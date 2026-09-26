import * as fse from "fs-extra";
import * as path from "path";
import {
  AgentAction,
  AgentActionsConfig,
  matchProjectPattern,
} from "./AgentActions";
import { Config } from "./Config";
import { createCliAgent } from "./clients/CliAgentRegistry";
import type { CliAgentClient } from "./clients/CliAgent";
import { resolveModel } from "./clients/BaseCliAgent";
import { OTelLogger, OTelMeter } from "./OTelContext";
import { PlannerClient, PlannerProject, PlannerTask } from "./PlannerClient";
import {
  DEFAULT_TASK_WEIGHT,
  SchedulerOptions,
  SchedulerPick,
  SchedulerSelection,
  RunningTask,
  actionKeyOf,
  maxConcurrentTasks,
  normalizeConflictMode,
  runningWeight,
  sanitizeBudget,
  selectEvaluationShortlist,
  selectTasks,
  selectTasksLegacy,
} from "./Scheduler";
import { TaskEvaluator } from "./TaskEvaluator";

const logger = OTelLogger().createModuleLogger("agent");

const AGENT_NOTES_MARKER =
  "<!-- AGENT-NOTES: the content below is maintained by the planner agent. Do not remove this marker. -->";

// Maximum length of the failure explanation posted on a task.
const MAX_FAILURE_EXPLANATION_LENGTH = 1000;

export class Agent {
  private config: Config;
  private agentActions: AgentActionsConfig | null;
  private planner: PlannerClient;
  private cliAgent: CliAgentClient;
  private cliAgents: Map<string, CliAgentClient>;
  private defaultAgent: string;
  private taskEvaluator: TaskEvaluator;
  private pollingTimer?: NodeJS.Timeout;
  // Tasks currently being processed with their scheduling metadata: they
  // are never picked again by a subsequent poll while their processing is
  // still running. In-memory only: one agent process per agent identity is
  // assumed; cross-instance scheduling is not supported.
  private processingTasks = new Map<string, RunningTask>();
  // Single-flight guard: while a poll is still running (task selection,
  // utility-model evaluations or processing start), the next tick is
  // skipped, so tasks can never be registered twice (double-pick race).
  private polling = false;
  // Scheduling metrics (disabled when OpenTelemetry is not initialized).
  private schedulerMetrics: {
    runningWeight: ReturnType<
      ReturnType<typeof OTelMeter>["createObservableGauge"]
    >;
    queueDepth: ReturnType<
      ReturnType<typeof OTelMeter>["createObservableGauge"]
    >;
    picked: ReturnType<ReturnType<typeof OTelMeter>["createCounter"]>;
    deferred: ReturnType<ReturnType<typeof OTelMeter>["createCounter"]>;
  } | null = null;
  private lastRunningWeight = 0;
  private lastQueueDepth = 0;
  // Invalid hot-reloaded values are reported once per value.
  private warnedBudgetValue: string | null = null;
  private warnedConflictModeValue: string | null = null;

  constructor(
    config: Config,
    agentActions?: AgentActionsConfig | null,
    cliAgents?: Map<string, CliAgentClient>,
  ) {
    this.config = config;
    this.agentActions = agentActions ?? null;
    this.planner = new PlannerClient(config);
    this.defaultAgent =
      this.agentActions?.defaultAgent || config.AGENT_CLI;
    this.cliAgents = cliAgents ?? new Map();
    if (!this.cliAgents.has(this.defaultAgent)) {
      this.cliAgents.set(
        this.defaultAgent,
        createCliAgent(config, this.agentActions, this.defaultAgent),
      );
    }
    this.cliAgent = this.cliAgents.get(this.defaultAgent)!;
    this.taskEvaluator = new TaskEvaluator(config, this.cliAgent);
    this.initSchedulerMetrics();
  }

  public start(): void {
    logger.info(
      `Agent '${this.config.AGENT_NAME}' started (polling every ${this.config.TASK_POLLING_INTERVAL} seconds)`,
    );
    void this.pollForTasks();
    this.pollingTimer = setInterval(() => {
      void this.pollForTasks();
    }, this.config.TASK_POLLING_INTERVAL * 1000);
  }

  public stop(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
      logger.info(`Agent '${this.config.AGENT_NAME}' stopped`);
    }
  }

  private async pollForTasks(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      await this.pollOnce();
    } finally {
      this.polling = false;
    }
  }

  private async pollOnce(): Promise<void> {
    try {
      const user = await this.planner.getCurrentUser();
      const tasks = await this.planner.listAssignedTasks(user);
      await this.cleanupCompletedTasks(tasks);
      this.logRunningTasks();
      const actions = this.getActions();
      if (actions.length === 0 || tasks.length === 0) {
        return;
      }
      // The projects are loaded lazily, once per poll: the project-bound
      // actions match on the project names, and the task brief includes the
      // project name and description.
      let projects: Map<string, PlannerProject> | null = null;
      const loadProjects =
        async (): Promise<Map<string, PlannerProject>> => {
          if (projects === null) {
            const list = await this.planner.listProjects();
            projects = new Map(list.map((project) => [project.id, project]));
          }
          return projects;
        };
      if (actions.some((action) => action.project.length > 0)) {
        await loadProjects();
      }
      // Only tasks matching an action are ready, and a task already being
      // processed is never picked again by a subsequent poll. Every matching
      // (task, action) pair is a candidate; the scheduler then fills the
      // capacity budget from the candidates sorted by queue priority. The
      // budget is shared by every action.
      const candidates: SchedulerPickless[] = [];
      for (const action of actions) {
        for (const task of tasks) {
          if (
            !this.matchesAction(task, action, projects) ||
            this.processingTasks.has(task.id) ||
            candidates.some((selected) => selected.task.id === task.id)
          ) {
            continue;
          }
          candidates.push({ task, action });
        }
      }
      if (candidates.length === 0) {
        return;
      }
      // Queue order: higher priorities first; within the same priority the
      // task whose last update is the oldest is picked first. The sort is
      // stable, so equal candidates keep the actions configuration order.
      candidates.sort(
        (a, b) =>
          priorityRank(b.task.priority) - priorityRank(a.task.priority) ||
          dateUpdatedValue(a.task.dateUpdated) -
            dateUpdatedValue(b.task.dateUpdated),
      );
      if (this.isSmartSchedulingEnabled()) {
        await this.selectTasksWithScheduler(candidates, loadProjects);
      } else {
        await this.selectTasksWithKillSwitch(candidates, loadProjects);
      }
    } catch (error) {
      logger.error(
        `Failed to poll tasks from Planner: ${(error as Error).message}`,
      );
    }
  }

  // Smart scheduling (default): weighted capacity budget, conflict-aware
  // greedy first-fit selection and the optional utility-model
  // pre-evaluation of the tasks without explicit hints.
  private async selectTasksWithScheduler(
    candidates: SchedulerPickless[],
    loadProjects: () => Promise<Map<string, PlannerProject>>,
  ): Promise<void> {
    // The project names feed the conflict keys, the utility-model prompt
    // and the running-task metadata.
    const projectMap = await loadProjects();
    const { maxParallel, conflictMode } = this.schedulerOptions();
    const schedulerCandidates = candidates.map((candidate) => ({
      task: candidate.task,
      action: candidate.action,
      projectName: projectMap.get(candidate.task.projectId)?.name ?? "",
    }));
    const options: SchedulerOptions = { maxParallel, conflictMode };
    // Cost control: only the tasks that could actually be admitted this
    // poll are pre-evaluated by the utility model.
    const shortlist = selectEvaluationShortlist(
      schedulerCandidates,
      this.processingTasks,
      options,
    );
    const evaluations = await this.taskEvaluator.evaluateAll(
      shortlist.map((candidate) => ({
        task: candidate.task,
        projectName: candidate.projectName,
      })),
      // The evaluations are CLI processes too: they share the process cap
      // of the scheduler instead of stacking on top of the running tasks.
      { maxConcurrent: maxConcurrentTasks(maxParallel) },
    );
    const selection = selectTasks(schedulerCandidates, this.processingTasks, {
      ...options,
      evaluations,
    });
    this.logSchedulingRound(selection);
    if (selection.picks.length === 0) {
      this.recordSchedulerMetrics(selection, candidates.length);
      return;
    }
    this.registerPicks(selection.picks);
    this.recordSchedulerMetrics(selection, candidates.length - selection.picks.length);
    // Each task manages its own error handling and in-flight cleanup. The
    // processing is detached from the poll: the single-flight guard only
    // protects the selection (through the synchronous registration), so
    // polling continues while the tasks are running.
    void this.processPicks(selection.picks, loadProjects);
  }

  // Kill switch (TASK_SMART_SCHEDULING=false): exactly the historical
  // count-based selection; weights, conflicts and the utility model are
  // ignored.
  private async selectTasksWithKillSwitch(
    candidates: SchedulerPickless[],
    loadProjects: () => Promise<Map<string, PlannerProject>>,
  ): Promise<void> {
    const tasksToProcess = selectTasksLegacy(
      candidates,
      this.config.TASK_MAX_PARALLEL,
      this.processingTasks.size,
    );
    if (tasksToProcess.length === 0) {
      return;
    }
    const picks: SchedulerPick[] = tasksToProcess.map(({ task, action }) => ({
      task,
      action,
      projectName: "",
      weight: DEFAULT_TASK_WEIGHT,
      conflictKeys: [],
    }));
    this.registerPicks(picks);
    void this.processPicks(picks, loadProjects);
  }

  // Registers the picked tasks into the in-flight map synchronously,
  // before any await: the next poll can never pick them again (double-pick
  // race). The map is also the metadata backbone of the running-tasks log
  // and of the capacity and conflict decisions of the following rounds.
  private registerPicks(picks: SchedulerPick[]): void {
    const startedAt = Date.now();
    for (const pick of picks) {
      this.processingTasks.set(pick.task.id, {
        taskId: pick.task.id,
        title: pick.task.title,
        projectName: pick.projectName,
        actionKey: actionKeyOf(pick.action),
        weight: pick.weight,
        conflictKeys: pick.conflictKeys,
        startedAt,
        model: this.resolveTaskModel(pick.task, pick.action),
      });
    }
  }

  // Starts the picked tasks and keeps the in-flight registration paired
  // with the per-task cleanup: tasks that never reach processTask are
  // unregistered here so they are picked again on the next poll.
  private async processPicks(
    picks: SchedulerPick[],
    loadProjects: () => Promise<Map<string, PlannerProject>>,
  ): Promise<void> {
    const started = new Set<string>();
    try {
      const projectMap = await loadProjects();
      for (const pick of picks) {
        const runningTask = this.processingTasks.get(pick.task.id);
        if (runningTask && runningTask.projectName.length === 0) {
          runningTask.projectName =
            projectMap.get(pick.task.projectId)?.name ?? "";
        }
      }
      await Promise.all(
        picks.map(async (pick) => {
          started.add(pick.task.id);
          await this.processTask(
            pick.task,
            pick.action,
            projectMap.get(pick.task.projectId) ?? null,
          );
        }),
      );
    } catch (error) {
      logger.error(
        `Failed to start the picked tasks: ${(error as Error).message}`,
      );
    } finally {
      for (const pick of picks) {
        if (!started.has(pick.task.id)) {
          this.processingTasks.delete(pick.task.id);
        }
      }
    }
  }

  private isSmartSchedulingEnabled(): boolean {
    return this.config.TASK_SMART_SCHEDULING !== false;
  }

  // Defensive read of the scheduling configuration: validate() runs at
  // startup only, so a hot-reloaded invalid value falls back to the
  // default (reported once per value).
  private schedulerOptions(): { maxParallel: number; conflictMode: ReturnType<typeof normalizeConflictMode> } {
    const rawBudget = this.config.TASK_MAX_PARALLEL;
    const maxParallel = sanitizeBudget(rawBudget);
    if (maxParallel !== rawBudget && this.warnedBudgetValue !== String(rawBudget)) {
      this.warnedBudgetValue = String(rawBudget);
      logger.warn(
        `Invalid TASK_MAX_PARALLEL '${String(rawBudget)}': falling back to ${maxParallel}`,
      );
    }
    const rawMode = this.config.TASK_CONFLICT_MODE;
    const conflictMode = normalizeConflictMode(rawMode);
    if (conflictMode !== rawMode && this.warnedConflictModeValue !== String(rawMode)) {
      this.warnedConflictModeValue = String(rawMode);
      logger.warn(
        `Invalid TASK_CONFLICT_MODE '${String(rawMode)}': falling back to '${conflictMode}'`,
      );
    }
    return { maxParallel, conflictMode };
  }

  // The model resolves to the action model, then the actions default
  // model; the task description still overrides both (see
  // BaseCliAgent.resolveModel).
  private resolveTaskModel(task: PlannerTask, action: AgentAction): string {
    const defaultModel = action.model || this.agentActions?.defaultModel || "";
    return resolveModel(task, defaultModel)?.model ?? "";
  }

  // The running tasks are reported on every poll while tasks are running
  // (title, project, weight, elapsed time, model): the only intentional
  // deviation from strict polling silence, so the parallel activity stays
  // observable in the logs.
  private logRunningTasks(): void {
    if (this.processingTasks.size === 0) {
      return;
    }
    const running = [...this.processingTasks.values()];
    const descriptions = running.map((runningTask) => {
      const parts = [
        `weight ${runningTask.weight.toFixed(2)}`,
        `running ${formatElapsed(Date.now() - runningTask.startedAt)}`,
      ];
      if (runningTask.projectName.length > 0) {
        parts.unshift(`project ${runningTask.projectName}`);
      }
      if (runningTask.model.length > 0) {
        parts.push(`model ${runningTask.model}`);
      }
      return `'${runningTask.title}' (${parts.join(", ")})`;
    });
    logger.info(
      `Tasks running (${running.length}, total weight ${runningWeight(this.processingTasks).toFixed(2)}): ${descriptions.join(", ")}`,
    );
  }

  // One scheduling-round line per poll when something was picked or
  // deferred (with the deferral reason), nothing otherwise.
  private logSchedulingRound(selection: SchedulerSelection): void {
    if (selection.picks.length === 0 && selection.deferrals.length === 0) {
      return;
    }
    const parts = [
      selection.picks.length > 0
        ? `picked: ${selection.picks
            .map((pick) => `'${pick.task.title}' (weight ${pick.weight.toFixed(2)})`)
            .join(", ")}`
        : "picked: none",
    ];
    if (selection.deferrals.length > 0) {
      parts.push(
        `deferred: ${selection.deferrals
          .map((deferral) => `'${deferral.task.title}' (${deferral.reason})`)
          .join(", ")}`,
      );
    }
    logger.info(`Scheduling round: ${parts.join("; ")}`);
  }

  private initSchedulerMetrics(): void {
    try {
      const meter = OTelMeter();
      this.schedulerMetrics = {
        runningWeight: meter.createObservableGauge(
          "scheduler.running-weight",
          (result) => result.observe(this.lastRunningWeight),
          "Total scheduling weight of the tasks currently running",
        ),
        queueDepth: meter.createObservableGauge(
          "scheduler.queue-depth",
          (result) => result.observe(this.lastQueueDepth),
          "Ready tasks waiting to be admitted by the scheduler",
        ),
        picked: meter.createCounter("scheduler.tasks.picked"),
        deferred: meter.createCounter("scheduler.tasks.deferred"),
      };
    } catch {
      // OpenTelemetry not initialized (e.g. in tests): the metrics stay
      // disabled and the scheduling keeps working.
      this.schedulerMetrics = null;
    }
  }

  private recordSchedulerMetrics(
    selection: SchedulerSelection,
    queueDepth: number,
  ): void {
    this.lastRunningWeight = runningWeight(this.processingTasks);
    this.lastQueueDepth = queueDepth;
    if (this.schedulerMetrics === null) {
      return;
    }
    if (selection.picks.length > 0) {
      this.schedulerMetrics.picked.add(selection.picks.length);
    }
    const deferredByReason = new Map<string, number>();
    for (const deferral of selection.deferrals) {
      const reason = deferral.reason.startsWith("conflict:")
        ? "conflict"
        : deferral.reason;
      deferredByReason.set(reason, (deferredByReason.get(reason) ?? 0) + 1);
    }
    for (const [reason, count] of deferredByReason) {
      this.schedulerMetrics.deferred.add(count, { reason });
    }
  }

  // The actions drive which tasks are picked and how they are processed.
  // They come from the agent actions configuration; without it no task
  // is processed.
  private getActions(): AgentAction[] {
    return this.agentActions?.actions ?? [];
  }

  // A task matches an action when its status is the action start status and
  // its project matches the action project pattern (an empty pattern matches
  // any project). A task whose project cannot be resolved never matches a
  // project-bound action.
  private matchesAction(
    task: PlannerTask,
    action: AgentAction,
    projects: Map<string, PlannerProject> | null,
  ): boolean {
    if (task.status !== action.statusStart) {
      return false;
    }
    if (action.project.length === 0) {
      return true;
    }
    if (projects === null || task.projectId.length === 0) {
      return false;
    }
    const projectName = projects.get(task.projectId)?.name;
    if (projectName === undefined) {
      return false;
    }
    return matchProjectPattern(action.project, projectName);
  }

  private async processTask(
    task: PlannerTask,
    action: AgentAction,
    project: PlannerProject | null,
  ): Promise<void> {
    logger.info(
      `Processing task '${task.title}' (${task.id}) in status '${task.status}'`,
    );
    await this.postStartComment(task);
    try {
      const notesFile = this.getTaskNotesFile(task.id);
      await this.writeTaskNotes(task, notesFile, project);
      // Each task runs in its own working directory so parallel tasks never
      // share one and cannot collide on the filesystem (the directory is
      // also stated in the task prompt; see BaseCliAgent.buildTaskPrompt).
      const taskDir = this.getTaskDir(task.id);
      await fse.ensureDir(taskDir);
      // The model resolves to the action model, then the actions default
      // model; the task description still overrides both (see
      // BaseCliAgent.resolveModel).
      const currentDefaultAgent =
        this.agentActions?.defaultAgent || this.config.AGENT_CLI;
      const selectedAgent = action.agent || currentDefaultAgent;
      const defaultModel =
        action.model ||
        (selectedAgent === currentDefaultAgent
          ? this.agentActions?.defaultModel
          : "") ||
        "";
      // The timeout resolves to the action timeout, then the actions
      // default timeout; when neither is configured the global TASK_TIMEOUT
      // (which defaults to 1 hour) applies (see BaseCliAgent.performTask).
      const cliAgent = this.getCliAgent(selectedAgent);
      const summary = await cliAgent.performTask(task, notesFile, {
        model: defaultModel,
        instruction: action.instruction,
        timeoutSeconds:
          action.timeout ??
          this.agentActions?.defaultTimeout ??
          this.config.TASK_TIMEOUT,
        cwd: taskDir,
      });
      await this.planner.addTaskComment(task.id, summary);
      await this.planner.updateTaskStatus(task.id, action.statusEnd);
      logger.info(
        `Task '${task.title}' (${task.id}) completed and moved to status '${action.statusEnd}'`,
      );
      await this.cleanupTaskFolderIfNeeded(task.id, action.statusEnd);
    } catch (error) {
      const message = (error as Error).message;
      logger.error(
        `Failed to process task '${task.title}' (${task.id}): ${message}`,
      );
      // A failing task must not block the agent by staying in the start
      // status forever: it is moved to the end status with an explanation.
      try {
        await this.planner.addTaskComment(
          task.id,
          buildFailureComment(message, action.statusEnd),
        );
        await this.planner.updateTaskStatus(task.id, action.statusEnd);
        logger.info(
          `Task '${task.title}' (${task.id}) moved to status '${action.statusEnd}' after a processing failure`,
        );
        await this.cleanupTaskFolderIfNeeded(task.id, action.statusEnd);
      } catch (cleanupError) {
        logger.error(
          `Failed to move task '${task.title}' (${task.id}) to status '${action.statusEnd}' after the processing failure: ${(cleanupError as Error).message}`,
        );
      }
    } finally {
      this.processingTasks.delete(task.id);
    }
  }

  private getCliAgent(agentName: string): CliAgentClient {
    let cliAgent = this.cliAgents.get(agentName);
    if (!cliAgent) {
      cliAgent = createCliAgent(this.config, this.agentActions, agentName);
      this.cliAgents.set(agentName, cliAgent);
    }
    return cliAgent;
  }

  // Notifies the user that the agent started working on the task.
  // Best-effort: a notification failure is logged but must not fail the
  // task processing.
  private async postStartComment(task: PlannerTask): Promise<void> {
    try {
      await this.planner.addTaskComment(
        task.id,
        `Agent '${this.config.AGENT_NAME}' started working on this task.`,
      );
    } catch (error) {
      logger.error(
        `Failed to post the start notification for task '${task.title}' (${task.id}): ${(error as Error).message}`,
      );
    }
  }

  private getTaskNotesFile(taskId: string): string {
    return path.join(this.config.DATA_DIR, "tasks", `${taskId}-Agent.md`);
  }

  private getTaskSummaryFile(taskId: string): string {
    return path.join(
      this.config.DATA_DIR,
      "tasks",
      `${taskId}-Agent-Summary.md`,
    );
  }

  private getTaskDir(taskId: string): string {
    return path.join(this.config.DATA_DIR, "tasks", taskId);
  }

  private async writeTaskNotes(
    task: PlannerTask,
    notesFile: string,
    project: PlannerProject | null,
  ): Promise<void> {
    // Preserve the agent notes from previous runs; the task brief (description,
    // comments and attachments) is always refreshed with the latest Planner content.
    let agentNotes = "\n\n## Agent Notes\n";
    if (await fse.pathExists(notesFile)) {
      const existing = await fse.readFile(notesFile, "utf8");
      const markerIndex = existing.indexOf(AGENT_NOTES_MARKER);
      if (markerIndex >= 0) {
        agentNotes = existing.slice(markerIndex + AGENT_NOTES_MARKER.length);
      }
    }

    const comments = task.comments
      .map(
        (comment) =>
          `- **${comment.userName || comment.userId}** (${comment.dateCreated}): ${comment.text}`,
      )
      .join("\n");
    const downloadedAttachments = await this.downloadAttachments(task);
    const attachmentLines =
      downloadedAttachments.length > 0
        ? downloadedAttachments.map(
            (filePath) => `- ${path.basename(filePath)} (${filePath})`,
          )
        : task.attachments.length > 0
          ? task.attachments.map(
              (attachment) => `- ${attachment.fileName} (download failed)`,
            )
          : ["*(none)*"];
    const brief = [
      `# Task: ${task.title}`,
      "",
      `- **ID**: ${task.id}`,
      `- **Status**: ${task.status}`,
      `- **Project**: ${project?.name ?? task.projectId}`,
      "",
      "## Description",
      "",
      task.description.trim().length > 0 ? task.description : "*(empty)*",
      "",
      // The project section is only rendered when the project has a
      // description.
      ...(project !== null && project.description.trim().length > 0
        ? ["## Project", "", project.description, ""]
        : []),
      "## Comments",
      "",
      comments.length > 0 ? comments : "*(none)*",
      "",
      "## Attachments",
      "",
      ...attachmentLines,
      "",
      AGENT_NOTES_MARKER,
    ].join("\n");

    await fse.ensureDir(path.dirname(notesFile));
    await fse.writeFile(notesFile, brief + agentNotes);
  }

  private async downloadAttachments(task: PlannerTask): Promise<string[]> {
    if (task.attachments.length === 0) {
      return [];
    }
    const attachmentsDir = path.join(this.getTaskDir(task.id), "attachments");
    await fse.ensureDir(attachmentsDir);
    const downloaded: string[] = [];
    for (const attachment of task.attachments) {
      try {
        const data = await this.planner.downloadTaskAttachment(
          task.id,
          attachment.id,
        );
        const filePath = path.join(attachmentsDir, attachment.fileName);
        await fse.writeFile(filePath, data);
        downloaded.push(filePath);
        logger.info(
          `Downloaded attachment '${attachment.fileName}' for task '${task.title}' (${task.id})`,
        );
      } catch (error) {
        logger.error(
          `Failed to download attachment '${attachment.fileName}' for task '${task.title}' (${task.id}): ${(error as Error).message}`,
        );
      }
    }
    return downloaded;
  }

  private async cleanupCompletedTasks(tasks: PlannerTask[]): Promise<void> {
    const tasksDir = path.join(this.config.DATA_DIR, "tasks");
    if (!(await fse.pathExists(tasksDir))) {
      return;
    }
    const assignedStatuses = new Map(
      tasks.map((task) => [task.id, task.status]),
    );
    const taskIdsToCheck = new Set<string>();
    for (const entry of await fse.readdir(tasksDir)) {
      const taskId = extractTaskId(entry);
      if (taskId && !this.processingTasks.has(taskId)) {
        taskIdsToCheck.add(taskId);
      }
    }
    for (const taskId of taskIdsToCheck) {
      const status = assignedStatuses.get(taskId);
      if (status === undefined || status === this.config.TASK_STATUS_CLEANUP) {
        await this.cleanupTaskFolder(taskId, status === undefined);
      }
    }
  }

  private async cleanupTaskFolderIfNeeded(
    taskId: string,
    endStatus: string,
  ): Promise<void> {
    if (endStatus === this.config.TASK_STATUS_CLEANUP) {
      await this.cleanupTaskFolder(taskId, false);
    }
  }

  private async cleanupTaskFolder(
    taskId: string,
    missingFromPlanner: boolean,
  ): Promise<void> {
    const taskDir = this.getTaskDir(taskId);
    const notesFile = this.getTaskNotesFile(taskId);
    const summaryFile = this.getTaskSummaryFile(taskId);
    try {
      await fse.remove(taskDir);
      await fse.remove(notesFile);
      await fse.remove(summaryFile);
      const reason = missingFromPlanner
        ? "no longer assigned on Planner"
        : `reached status '${this.config.TASK_STATUS_CLEANUP}'`;
      logger.info(`Cleaned up task folder for task '${taskId}' (${reason})`);
    } catch (error) {
      logger.error(
        `Failed to clean up task folder for task '${taskId}': ${(error as Error).message}`,
      );
    }
  }
}

// Extracts a Planner task id (UUID) from a task file or directory name.
function extractTaskId(entry: string): string | undefined {
  const match = entry.match(
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  return match ? match[1].toLowerCase() : undefined;
}

// A ready (task, action) pair, before the scheduler resolves the project
// name and the scheduling metadata.
interface SchedulerPickless {
  task: PlannerTask;
  action: AgentAction;
}

// Compact elapsed-time rendering for the running-tasks log line.
function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

// Queue order of the priorities: higher ranks are picked first. Unknown or
// missing priorities rank as medium, the Planner default.
const PRIORITY_RANKS: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function priorityRank(priority: string): number {
  return PRIORITY_RANKS[priority] ?? PRIORITY_RANKS.medium;
}

// Sort key of the task last update, ascending: the oldest update comes
// first. A missing or unparsable date sorts as the oldest task.
function dateUpdatedValue(dateUpdated: string): number {
  const time = Date.parse(dateUpdated);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

// The comment posted on a task that failed to process: the explanation of
// the error, kept concise, and the resulting status change.
function buildFailureComment(message: string, endStatus: string): string {
  const explanation =
    message.length > MAX_FAILURE_EXPLANATION_LENGTH
      ? `${message.slice(0, MAX_FAILURE_EXPLANATION_LENGTH)}...`
      : message;
  return [
    "Task processing failed:",
    explanation,
    "",
    `The task was moved to '${endStatus}' so it does not block the agent. Check the agent logs for more details.`,
  ].join("\n");
}
