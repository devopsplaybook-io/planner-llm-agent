import * as fse from "fs-extra";
import * as path from "path";
import {
  AgentAction,
  AgentActionsConfig,
  matchProjectPattern,
} from "./AgentActions";
import { Config } from "./Config";
import type { AgentSchedulingSnapshot } from "./AgentNote";
import { FinalizationStore } from "./FinalizationStore";
import { createCliAgent } from "./clients/CliAgentRegistry";
import {
  prepareCliAgent,
  type CliAgentClient,
  type TaskOptions,
} from "./clients/CliAgent";
import { resolveModel } from "./clients/BaseCliAgent";
import {
  extractErrorOutputTail,
  isCliAbortError,
} from "./CliUtils";
import { OTelLogger, OTelMeter } from "./OTelContext";
import {
  PlannerClient,
  PlannerProject,
  PlannerTask,
  PlannerTaskComment,
  PlannerTaskDependency,
} from "./PlannerClient";
import {
  DEFAULT_TASK_WEIGHT,
  SchedulerDeferral,
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

// Refresh period of the heartbeat file the Kubernetes probes check.
const HEARTBEAT_INTERVAL_MS = 30000;

// Maximum length of the failure explanation posted on a task.
const MAX_FAILURE_EXPLANATION_LENGTH = 1000;

// Maximum lengths of the partial work salvaged into a failure comment (the
// partial task summary written by the CLI and the tail of the CLI output).
const MAX_SALVAGED_SUMMARY_LENGTH = 2000;
const MAX_SALVAGED_OUTPUT_LENGTH = 1000;

// Directive of an adjustment pass: appended to the action instruction when
// new comments arrived on the task while the CLI agent was running a step.
const MAX_ADJUSTMENT_DIRECTIVE =
  "New comments were posted on this task after your previous run (listed below). They are also included in the Comments section of the task documentation file. Take the new messages into account, adjust the delivered work if needed, and update the summary file accordingly. If no adjustment is needed, update the summary to state that no adjustment was required.";

/**
 * Sanitizes a Planner attachment file name for a safe local write: only the
 * base name is kept, and names carrying path separators or dot-only names
 * are rejected. The Planner server stores the client-provided name verbatim,
 * so an unsanitized name is an arbitrary-file-write vector (path traversal)
 * executed with the agent's privileges. Returns null for an unsafe name
 * (the attachment is skipped, never written).
 */
export function sanitizeAttachmentFileName(fileName: string): string | null {
  if (fileName.includes("/") || fileName.includes("\\")) {
    return null;
  }
  const base = path.basename(fileName);
  if (base.length === 0 || base === "." || base === "..") {
    return null;
  }
  return base;
}

export class Agent {
  private config: Config;
  private agentActions: AgentActionsConfig | null;
  private planner: PlannerClient;
  private cliAgent: CliAgentClient;
  private cliAgents: Map<string, CliAgentClient>;
  private defaultAgent: string;
  private taskEvaluator: TaskEvaluator;
  private running = false;
  private pollingTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  // Tasks currently being processed with their scheduling metadata: they
  // are never picked again by a subsequent poll while their processing is
  // still running. In-memory only: one agent process per agent identity is
  // assumed; cross-instance scheduling is not supported.
  private processingTasks = new Map<string, RunningTask>();
  // Completed tasks waiting for their Planner finalization (summary comment,
  // end status): while a record exists the task is never picked again, and
  // only the finalization steps are retried — the CLI work is never re-run.
  private finalizationStore: FinalizationStore;
  // Single-flight guard: while a poll is still running (task selection,
  // utility-model evaluations or processing start), the next tick is
  // skipped, so tasks can never be registered twice (double-pick race).
  private polling = false;
  // Adaptive polling: number of consecutive polls that found nothing to
  // do. The polling delay doubles after every idle poll, capped at
  // TASK_POLLING_MAX_INTERVAL; any activity resets it to the base interval.
  private idlePolls = 0;
  // Ready tasks waiting to be admitted by the scheduler: refreshed on every
  // completed poll and reported by the queue gauge (see initQueueMetrics).
  private queuedTasks = 0;
  // Titles of the queued tasks at the last poll (same lifecycle as the
  // queue gauge count): reported by the agent note with the count.
  private queuedTaskTitles: string[] = [];
  // Abort controllers of the tasks being processed, keyed by task id: the
  // poll signals a controller when the task status on Planner changed to
  // the action abort status (see abortRequestedTasks), which kills the CLI
  // process group of the task.
  private abortControllers = new Map<string, AbortController>();
  // Invalid hot-reloaded values are reported once per value.
  private warnedBudgetValue: string | null = null;
  private warnedConflictModeValue: string | null = null;
  // Planner user id of the agent itself, cached at every poll: the
  // new-comment check excludes the comments authored by this user (they are
  // the agent's own start/summary comments). One agent process per agent
  // identity is an existing assumption, so a per-process cache is safe.
  private agentUserId: string | null = null;

  constructor(
    config: Config,
    agentActions?: AgentActionsConfig | null,
    cliAgents?: Map<string, CliAgentClient>,
    finalizationStore?: FinalizationStore,
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
    this.finalizationStore = finalizationStore ?? new FinalizationStore();
    this.initQueueMetrics();
  }

  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    logger.info(
      `Agent '${this.config.AGENT_NAME}' started (polling every ${this.config.TASK_POLLING_INTERVAL} seconds, backing off to at most ${this.maxPollingIntervalSeconds()} seconds between polls when idle)`,
    );
    void this.pollForTasks()
      .finally(() => this.scheduleNextPoll())
      .catch((error: Error) =>
        logger.error(`Failed to run the polling loop: ${error.message}`),
      );
    this.startHeartbeat();
  }

  public stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = undefined;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    logger.info(`Agent '${this.config.AGENT_NAME}' stopped`);
  }

  // The Kubernetes probes check the freshness of the heartbeat file: it
  // proves the agent event loop is alive even when no poll runs (the file
  // is touched at startup too, see App).
  private startHeartbeat(): void {
    void this.writeHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.writeHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private async writeHeartbeat(): Promise<void> {
    try {
      await fse.ensureDir(this.config.DATA_DIR);
      await fse.writeFile(
        path.join(this.config.DATA_DIR, "heartbeat"),
        new Date().toISOString(),
      );
    } catch (error) {
      logger.error(
        `Failed to write the heartbeat file: ${(error as Error).message}`,
      );
    }
  }

  // The polling loop is self-rescheduling instead of a fixed interval: the
  // next poll is scheduled once the current one completed, with a delay
  // that doubles after every consecutive idle poll (adaptive backoff).
  private scheduleNextPoll(): void {
    if (!this.running) {
      return;
    }
    this.pollingTimer = setTimeout(() => {
      this.pollingTimer = undefined;
      void this.pollForTasks()
        .finally(() => this.scheduleNextPoll())
        .catch((error: Error) =>
          logger.error(`Failed to run the polling loop: ${error.message}`),
        );
    }, this.nextPollDelaySeconds() * 1000);
  }

  private async pollForTasks(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      const outcome = await this.pollOnce();
      this.updatePollCadence(outcome);
    } finally {
      this.polling = false;
    }
  }

  // The delay before the next poll: the base TASK_POLLING_INTERVAL doubled
  // after every consecutive idle poll (the first idle poll keeps the base
  // interval), capped at the effective maximum.
  private nextPollDelaySeconds(): number {
    const base = this.pollingIntervalSeconds();
    const factor = 2 ** Math.max(this.idlePolls - 1, 0);
    return Math.min(base * factor, this.maxPollingIntervalSeconds());
  }

  // The effective polling ceiling: the largest of TASK_POLLING_MAX_INTERVAL
  // and the base interval, so a misconfigured maximum can never make the
  // agent poll faster than the base interval.
  private maxPollingIntervalSeconds(): number {
    return Math.max(
      this.pollingIntervalSeconds(),
      this.configuredMaxPollingIntervalSeconds(),
    );
  }

  private pollingIntervalSeconds(): number {
    const value = this.config.TASK_POLLING_INTERVAL;
    return Number.isFinite(value) && value > 0 ? value : 60;
  }

  private configuredMaxPollingIntervalSeconds(): number {
    const value = this.config.TASK_POLLING_MAX_INTERVAL;
    return Number.isFinite(value) && value > 0 ? value : 300;
  }

  private updatePollCadence(outcome: PollOutcome): void {
    if (outcome === "error") {
      // An error says nothing about idleness: keep the current cadence.
      return;
    }
    // Anything to do keeps the base cadence: picked or queued candidates,
    // tasks still running and pending Planner finalizations are all work
    // the next poll must reach without waiting out a backoff.
    const active =
      outcome === "actionable" ||
      this.processingTasks.size > 0 ||
      this.finalizationStore.size > 0;
    this.idlePolls = active ? 0 : this.idlePolls + 1;
  }

  private async pollOnce(): Promise<PollOutcome> {
    let outcome: PollOutcome = "idle";
    try {
      const user = await this.planner.getCurrentUser();
      this.agentUserId = user.id;
      const actions = this.getActions();
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
      // Cut the poll payload: when every action is bound to a project
      // pattern, the task list is fetched per project instead of across
      // all projects.
      const projectScope = await this.taskScopeProjectIds(
        actions,
        loadProjects,
      );
      const tasks = await this.planner.listAssignedTasks(
        user,
        projectScope ?? undefined,
      );
      await this.cleanupCompletedTasks(tasks);
      // Records of the tasks that are no longer assigned can never be
      // finalized: drop them.
      this.finalizationStore.prune(new Set(tasks.map((task) => task.id)));
      this.logRunningTasks();
      this.abortRequestedTasks(tasks);
      if (actions.length === 0 || tasks.length === 0) {
        this.queuedTasks = 0;
        this.queuedTaskTitles = [];
        return outcome;
      }
      // The project-bound actions match on the project names: the projects
      // are loaded when any action needs them (the scoped fetch above
      // already loaded them when every action is project-bound).
      if (actions.some((action) => action.project.length > 0)) {
        await loadProjects();
      }
      // Only tasks matching an action are ready, and a task already being
      // processed is never picked again by a subsequent poll. A task with a
      // dependency that is not Done yet is never picked either: it is only
      // reported as deferred (no status change, no error comment) and is
      // picked up naturally once its dependencies complete. Every matching
      // (task, action) pair is a candidate; the scheduler then fills the
      // capacity budget from the candidates sorted by queue priority. The
      // budget is shared by every action.
      const candidates: SchedulerPickless[] = [];
      const dependencyDeferrals: SchedulerDeferral[] = [];
      for (const action of actions) {
        for (const task of tasks) {
          if (
            !this.matchesAction(task, action, projects) ||
            this.processingTasks.has(task.id) ||
            // A task with a pending finalization completed already: only its
            // Planner updates remain, never a new CLI execution.
            this.finalizationStore.has(task.id) ||
            candidates.some((selected) => selected.task.id === task.id)
          ) {
            continue;
          }
          const blocking = blockingDependencies(task);
          if (blocking.length > 0) {
            dependencyDeferrals.push({
              task,
              reason: `dependency:${blocking[0].taskId}`,
            });
            continue;
          }
          candidates.push({ task, action });
        }
      }
      if (candidates.length === 0 && dependencyDeferrals.length === 0) {
        this.queuedTasks = 0;
        this.queuedTaskTitles = [];
        return outcome;
      }
      // Queue order: higher priorities first; within the same priority the
      // task whose last update is the oldest is picked first. The queue
      // priority of a task is the priority of its matching action when the
      // action sets one, and the task's own Planner priority otherwise. The
      // sort is stable, so equal candidates keep the actions configuration
      // order.
      candidates.sort(
        (a, b) =>
          priorityRank(queuePriorityOf(b.task, b.action)) -
            priorityRank(queuePriorityOf(a.task, a.action)) ||
          dateUpdatedValue(a.task.dateUpdated) -
            dateUpdatedValue(b.task.dateUpdated),
      );
      if (this.isSmartSchedulingEnabled()) {
        outcome = "actionable";
        await this.selectTasksWithScheduler(
          candidates,
          dependencyDeferrals,
          loadProjects,
        );
      } else {
        outcome = "actionable";
        await this.selectTasksWithKillSwitch(
          candidates,
          dependencyDeferrals,
          loadProjects,
        );
      }
    } catch (error) {
      logger.error(
        `Failed to poll tasks from Planner: ${(error as Error).message}`,
      );
      outcome = "error";
    } finally {
      // The finalization retries run after the selection of this poll: a
      // record deleted by a successful retry can then no longer influence
      // the (already stale) task list of the same poll, so a task finalized
      // on retry is never re-picked by that poll.
      await this.retryDueFinalizations();
    }
    return outcome;
  }

  // The project ids the task fetch is scoped to, or null for the unscoped
  // fetch: the scoping only applies when every action is bound to a
  // project pattern, and it falls back to the unscoped list when no
  // project matches the patterns (the client-side matching then rejects
  // every task, exactly like the unscoped fetch does).
  private async taskScopeProjectIds(
    actions: AgentAction[],
    loadProjects: () => Promise<Map<string, PlannerProject>>,
  ): Promise<string[] | null> {
    if (
      actions.length === 0 ||
      actions.some((action) => action.project.length === 0)
    ) {
      return null;
    }
    const projects = await loadProjects();
    const ids: string[] = [];
    for (const project of projects.values()) {
      if (
        actions.some((action) =>
          matchProjectPattern(action.project, project.name),
        )
      ) {
        ids.push(project.id);
      }
    }
    return ids.length > 0 ? ids : null;
  }

  // Smart scheduling (default): weighted capacity budget, conflict-aware
  // greedy first-fit selection and the optional utility-model
  // pre-evaluation of the tasks without explicit hints.
  private async selectTasksWithScheduler(
    candidates: SchedulerPickless[],
    dependencyDeferrals: SchedulerDeferral[],
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
    // The dependency-gated tasks never reach the scheduler: they are merged
    // into the deferrals so the scheduling round reports them like any other
    // blocked task.
    this.logSchedulingRound({
      picks: selection.picks,
      deferrals: [...dependencyDeferrals, ...selection.deferrals],
    });
    this.recordQueueState(candidates, dependencyDeferrals, selection.picks);
    if (selection.picks.length === 0) {
      return;
    }
    this.registerPicks(selection.picks);
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
    dependencyDeferrals: SchedulerDeferral[],
    loadProjects: () => Promise<Map<string, PlannerProject>>,
  ): Promise<void> {
    const tasksToProcess = selectTasksLegacy(
      candidates,
      this.config.TASK_MAX_PARALLEL,
      this.processingTasks.size,
    );
    // The kill-switch path keeps its historical silence about the scheduling
    // rounds; the dependency-gated tasks are only counted in the queue gauge.
    this.recordQueueState(
      candidates,
      dependencyDeferrals,
      tasksToProcess.map(({ task, action }) => ({
        task,
        action,
        projectName: "",
        weight: DEFAULT_TASK_WEIGHT,
        conflictKeys: [],
      })),
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

  // Records the queue gauge count and the queued titles after a scheduling
  // round: every candidate (dependency-gated ones included) that the round
  // did not pick stays queued behind the capacity budget.
  private recordQueueState(
    candidates: SchedulerPickless[],
    dependencyDeferrals: SchedulerDeferral[],
    picks: SchedulerPick[],
  ): void {
    const pickedIds = new Set(picks.map((pick) => pick.task.id));
    this.queuedTaskTitles = [
      ...candidates
        .filter((candidate) => !pickedIds.has(candidate.task.id))
        .map((candidate) => candidate.task.title),
      ...dependencyDeferrals.map((deferral) => deferral.task.title),
    ];
    this.queuedTasks = this.queuedTaskTitles.length;
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
        statusAbort:
          pick.action.statusAbort ?? this.agentActions?.defaultStatusAbort,
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

  // Cancels the running tasks whose status on Planner changed to their
  // action abort status (per-task cancel): signaling the abort controller
  // kills the CLI process group, and the processing then posts the abort
  // comment instead of the failure handling. Detection latency is bounded
  // by the polling interval (polls keep the base interval while tasks run).
  // A task with no abort controller has no CLI execution in flight (already
  // finalizing): nothing to kill.
  private abortRequestedTasks(tasks: PlannerTask[]): void {
    for (const runningTask of this.processingTasks.values()) {
      if (!runningTask.statusAbort) {
        continue;
      }
      const abortController = this.abortControllers.get(runningTask.taskId);
      if (!abortController || abortController.signal.aborted) {
        continue;
      }
      const current = tasks.find((task) => task.id === runningTask.taskId);
      if (!current || current.status !== runningTask.statusAbort) {
        continue;
      }
      logger.info(
        `Task '${runningTask.title}' (${runningTask.taskId}) moved to the abort status '${runningTask.statusAbort}' on Planner: aborting the CLI execution`,
      );
      abortController.abort();
    }
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

  // One gauge consolidating the scheduling queue: one data point per
  // value, selected by the 'type' attribute. The instrument name carries
  // its own namespace because observable gauges are exported as-is,
  // without the service-name prefix (so the exported name is tasks.queue).
  private initQueueMetrics(): void {
    try {
      const meter = OTelMeter();
      meter.createObservableGauge(
        "tasks.queue",
        (result) => {
          result.observe(this.queuedTasks, { type: "tasks_queued" });
          result.observe(this.processingTasks.size, {
            type: "tasks_in_progress",
          });
          result.observe(runningWeight(this.processingTasks), {
            type: "weight_in_progress",
          });
        },
        "Tasks waiting to be admitted by the scheduler, tasks in progress and their total scheduling weight",
      );
    } catch {
      // OpenTelemetry not initialized (e.g. in tests): the metrics stay
      // disabled and the scheduling keeps working.
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
    const abortController = new AbortController();
    this.abortControllers.set(task.id, abortController);
    const startedAt = Date.now();
    try {
      // The model resolves to the action model, then the actions default
      // model; the task description still overrides both (see
      // BaseCliAgent.resolveModel). It is resolved before the start
      // comment so the notification can display it.
      const currentDefaultAgent =
        this.agentActions?.defaultAgent || this.config.AGENT_CLI;
      const selectedAgent = action.agent || currentDefaultAgent;
      const defaultModel =
        action.model ||
        (selectedAgent === currentDefaultAgent
          ? this.agentActions?.defaultModel
          : "") ||
        "";
      const resolvedModel = resolveModel(task, defaultModel)?.model ?? "";
      await this.postStartComment(task, resolvedModel);
      // Show the task as being processed on Planner (optional
      // status_in_progress): best-effort, a failed or skipped transition
      // never fails the task processing.
      await this.moveTaskToInProgress(task, project, action);
      const notesFile = this.getTaskNotesFile(task.id);
      await this.writeTaskNotes(task, notesFile, project);
      // Each task runs in its own working directory so parallel tasks never
      // share one and cannot collide on the filesystem (the directory is
      // also stated in the task prompt; see BaseCliAgent.buildTaskPrompt).
      const taskDir = this.getTaskDir(task.id);
      await fse.ensureDir(taskDir);
      // The timeout resolves to the action timeout, then the actions
      // default timeout; when neither is configured the global TASK_TIMEOUT
      // (which defaults to 1 hour) applies (see BaseCliAgent.performTask).
      const cliAgent = await this.getCliAgent(selectedAgent);
      const taskOptions: TaskOptions = {
        model: defaultModel,
        instruction: action.instruction,
        timeoutSeconds:
          action.timeout ??
          this.agentActions?.defaultTimeout ??
          this.config.TASK_TIMEOUT,
        cwd: taskDir,
        abortSignal: abortController.signal,
      };
      const stopProgressHeartbeat = this.startProgressHeartbeat(
        task,
        startedAt,
      );
      let summary: string;
      try {
        summary = await cliAgent.performTask(task, notesFile, taskOptions);
      } finally {
        stopProgressHeartbeat();
      }
      // The CLI run of the step is done: before finalizing, check whether
      // new comments were posted on the task while it ran and give the CLI
      // agent a bounded number of adjustment passes to take them into
      // account.
      const { summary: finalSummary, contentVersion } =
        await this.adjustForNewComments(
          task,
          project,
          cliAgent,
          notesFile,
          taskOptions,
          summary,
        );
      // The CLI work is done for good: from here on only the Planner
      // finalization remains, and a failure of it must never re-run the
      // CLI — the record keeps the task out of the candidates and drives
      // the idempotent retries (see retryDueFinalizations).
      this.finalizationStore.record(task.id, {
        title: task.title,
        contentVersion,
        summary: finalSummary,
        statusEnd: action.statusEnd,
      });
      await this.finalizeCompletedTask(task.id);
      this.finalizationStore.delete(task.id);
      logger.info(
        `Task '${task.title}' (${task.id}) completed and moved to status '${action.statusEnd}'`,
      );
    } catch (error) {
      const message = (error as Error).message;
      if (isCliAbortError(error)) {
        // A user requested the abort by moving the task to the action abort
        // status on Planner: the CLI process group was killed by the abort
        // signal. The task keeps the status the user set: no error status,
        // no end status, no finalization.
        await this.finalizeAbortedTask(task, action);
        return;
      }
      if (this.finalizationStore.has(task.id)) {
        // The CLI execution succeeded; only the Planner finalization failed.
        // The retry is scheduled with an exponential backoff.
        this.finalizationStore.scheduleRetry(task.id);
        const record = this.finalizationStore.get(task.id);
        logger.error(
          `Failed to finalize completed task '${task.title}' (${task.id}) (attempt ${record?.attempts ?? 1}, retry scheduled): ${message}`,
        );
        return;
      }
      logger.error(
        `Failed to process task '${task.title}' (${task.id}): ${message}`,
      );
      // A failing task must not block the agent by staying in the start
      // status forever: it is moved to the resolved error status (the action
      // status_error, then the actions default status_error, then the end
      // status) with an explanation, salvaging the partial work of the CLI
      // run (partial summary file and output tail) when any exists.
      const errorStatus =
        action.statusError ??
        this.agentActions?.defaultStatusError ??
        action.statusEnd;
      try {
        await this.planner.addTaskComment(
          task.id,
          buildFailureComment(
            message,
            errorStatus,
            await this.readSalvagedSummary(task.id),
            extractErrorOutputTail(error, MAX_SALVAGED_OUTPUT_LENGTH),
          ),
        );
        await this.planner.updateTaskStatus(task.id, errorStatus);
        logger.info(
          `Task '${task.title}' (${task.id}) moved to status '${errorStatus}' after a processing failure`,
        );
        await this.cleanupTaskFolderIfNeeded(task.id, errorStatus);
      } catch (cleanupError) {
        logger.error(
          `Failed to move task '${task.title}' (${task.id}) to status '${errorStatus}' after the processing failure: ${(cleanupError as Error).message}`,
        );
      }
    } finally {
      this.abortControllers.delete(task.id);
      this.processingTasks.delete(task.id);
    }
  }

  // Re-fetches the task after the CLI run of a step and detects the comments
  // posted since the brief was built (comment ids unknown to the brief-time
  // snapshot, excluding the agent's own comments). When some exist, the task
  // brief is refreshed with them and the CLI agent runs again with a
  // directive listing the new messages, at most
  // TASK_ADJUSTMENT_MAX_ROUNDS times. Returns the summary of the last
  // successful run and the freshest observed task content version. A failed
  // Planner read never discards the completed run (the task finalizes
  // as-is); a failed adjustment run propagates to the processTask error
  // handling.
  private async adjustForNewComments(
    task: PlannerTask,
    project: PlannerProject | null,
    cliAgent: CliAgentClient,
    notesFile: string,
    taskOptions: TaskOptions,
    initialSummary: string,
  ): Promise<{ summary: string; contentVersion: string }> {
    let summary = initialSummary;
    let contentVersion = task.dateUpdated;
    const knownCommentIds = new Set(task.comments.map((comment) => comment.id));
    const maxRounds = this.maxAdjustmentRounds();
    let roundsUsed = 0;
    for (;;) {
      let freshTask: PlannerTask;
      try {
        freshTask = await this.planner.getTask(task.id);
      } catch (error) {
        logger.warn(
          `Failed to check task '${task.title}' (${task.id}) for new comments (finalizing with the current summary): ${(error as Error).message}`,
        );
        return { summary, contentVersion };
      }
      contentVersion = freshTask.dateUpdated;
      const unknownComments = freshTask.comments.filter(
        (comment) => !knownCommentIds.has(comment.id),
      );
      if (unknownComments.length === 0) {
        return { summary, contentVersion };
      }
      const agentUserId = await this.resolveAgentUserId();
      if (agentUserId === null) {
        return { summary, contentVersion };
      }
      const newComments = unknownComments.filter(
        (comment) => comment.userId !== agentUserId,
      );
      if (newComments.length === 0) {
        // Only the agent's own comments arrived: nothing to adjust.
        return { summary, contentVersion };
      }
      if (roundsUsed >= maxRounds) {
        logger.warn(
          `Task '${task.title}' (${task.id}) received ${newComments.length} new comment(s) after the adjustment budget of ${maxRounds} round(s) was used up: finalizing with the current summary`,
        );
        return { summary, contentVersion };
      }
      roundsUsed++;
      for (const comment of freshTask.comments) {
        knownCommentIds.add(comment.id);
      }
      logger.info(
        `Task '${task.title}' (${task.id}) received ${newComments.length} new comment(s) while the step ran: adjustment round ${roundsUsed}/${maxRounds}`,
      );
      await this.writeTaskNotes(freshTask, notesFile, project);
      summary = await cliAgent.performTask(freshTask, notesFile, {
        ...taskOptions,
        instruction: buildAdjustmentInstruction(
          taskOptions.instruction,
          newComments,
        ),
      });
    }
  }

  // Defensive read of the adjustment budget: validate() runs at startup
  // only, so a hot-reloaded invalid value falls back to the default (2)
  // instead of allowing an unbounded adjustment loop.
  private maxAdjustmentRounds(): number {
    const value = this.config.TASK_ADJUSTMENT_MAX_ROUNDS;
    return Number.isInteger(value) && value >= 0 ? value : 2;
  }

  // The agent user id is cached at every poll; the fallback covers a check
  // running before the first successful poll (or after its user fetch
  // failed). Returns null when the Planner user cannot be resolved: the
  // caller then skips the check, since the agent's own comments could not
  // be told apart from the human ones.
  private async resolveAgentUserId(): Promise<string | null> {
    if (this.agentUserId) {
      return this.agentUserId;
    }
    try {
      const user = await this.planner.getCurrentUser();
      this.agentUserId = user.id;
      return user.id;
    } catch (error) {
      logger.warn(
        `Failed to resolve the agent user for the new-comment check (finalizing with the current summary): ${(error as Error).message}`,
      );
      return null;
    }
  }

  // Completes a finished task on Planner: posts the summary comment (unless
  // a previous attempt already did) and moves the task to its end status.
  // Idempotent, driven by the FinalizationStore record of the task.
  private async finalizeCompletedTask(taskId: string): Promise<void> {
    const record = this.finalizationStore.get(taskId);
    if (!record) {
      return;
    }
    if (!record.commentPosted) {
      await this.planner.addTaskComment(taskId, record.summary);
      this.finalizationStore.markCommentPosted(taskId);
    }
    await this.planner.updateTaskStatus(taskId, record.statusEnd);
    await this.cleanupTaskFolderIfNeeded(taskId, record.statusEnd);
  }

  // Retries the pending finalizations of the completed tasks whose summary
  // comment or end-status update previously failed. Only the Planner
  // updates run here: the CLI work is never re-executed. The tasks still
  // being processed are skipped: their own processTask call is
  // finalizing them right now.
  private async retryDueFinalizations(): Promise<void> {
    for (const taskId of this.finalizationStore.dueTaskIds()) {
      const record = this.finalizationStore.get(taskId);
      if (!record || this.processingTasks.has(taskId)) {
        continue;
      }
      try {
        await this.finalizeCompletedTask(taskId);
        this.finalizationStore.delete(taskId);
        logger.info(
          `Task '${record.title}' (${taskId}) finalized on retry and moved to status '${record.statusEnd}'`,
        );
      } catch (error) {
        this.finalizationStore.scheduleRetry(taskId);
        logger.error(
          `Failed to finalize completed task '${record.title}' (${taskId}) (attempt ${record.attempts}, retry scheduled): ${(error as Error).message}`,
        );
      }
    }
  }

  private async getCliAgent(agentName: string): Promise<CliAgentClient> {
    let cliAgent = this.cliAgents.get(agentName);
    if (!cliAgent) {
      cliAgent = createCliAgent(this.config, this.agentActions, agentName);
      this.cliAgents.set(agentName, cliAgent);
      // A CLI introduced by a hot-reloaded action is created outside the
      // startup preparation pass, so prepare it on first use.
      await prepareCliAgent(cliAgent);
    }
    return cliAgent;
  }

  // Notifies the user that the agent started working on the task, with the
  // resolved model when one is configured. Best-effort: a notification
  // failure is logged but must not fail the task processing.
  private async postStartComment(
    task: PlannerTask,
    model: string,
  ): Promise<void> {
    try {
      const modelSuffix = model.length > 0 ? ` (model ${model})` : "";
      await this.planner.addTaskComment(
        task.id,
        `Agent '${this.config.AGENT_NAME}' started working on this task${modelSuffix}.`,
      );
    } catch (error) {
      logger.error(
        `Failed to post the start notification for task '${task.title}' (${task.id}): ${(error as Error).message}`,
      );
    }
  }

  // Moves the task to the resolved in-progress status (the action
  // status_in_progress, then the actions default.status_in_progress) before
  // the CLI run, so the processing state is visible on Planner. Optional
  // and best-effort: without a configured status, when it equals the start
  // status, when the project status catalog is known and does not contain
  // it, or when the transition fails, the task keeps its current status
  // and the processing continues.
  private async moveTaskToInProgress(
    task: PlannerTask,
    project: PlannerProject | null,
    action: AgentAction,
  ): Promise<void> {
    const statusInProgress =
      action.statusInProgress ?? this.agentActions?.defaultStatusInProgress;
    if (!statusInProgress || statusInProgress === task.status) {
      return;
    }
    if (
      project?.statuses &&
      project.statuses.length > 0 &&
      !project.statuses.includes(statusInProgress)
    ) {
      logger.warn(
        `Task '${task.title}' (${task.id}) not moved to the in-progress status '${statusInProgress}': the status does not exist in project '${project.name}'`,
      );
      return;
    }
    try {
      await this.planner.updateTaskStatus(task.id, statusInProgress);
      logger.info(
        `Task '${task.title}' (${task.id}) moved to the in-progress status '${statusInProgress}'`,
      );
    } catch (error) {
      logger.warn(
        `Failed to move task '${task.title}' (${task.id}) to the in-progress status '${statusInProgress}' (continuing): ${(error as Error).message}`,
      );
    }
  }

  // Periodic "still working" comments for long runs
  // (TASK_PROGRESS_COMMENT_INTERVAL seconds, 0 disables): a task running
  // longer than the interval gets one heartbeat comment per interval
  // instead of total silence between the start and summary comments. The
  // comments are best-effort and return the stop function; they are posted
  // by the agent user, so the new-comment adjustment check ignores them.
  private startProgressHeartbeat(
    task: PlannerTask,
    startedAt: number,
  ): () => void {
    const intervalSeconds = this.progressCommentIntervalSeconds();
    if (intervalSeconds <= 0) {
      return () => undefined;
    }
    const timer = setInterval(() => {
      const elapsed = formatElapsed(Date.now() - startedAt);
      void this.planner
        .addTaskComment(task.id, `Still working on this task (elapsed ${elapsed}).`)
        .catch((error: Error) => {
          logger.error(
            `Failed to post the progress comment for task '${task.title}' (${task.id}): ${error.message}`,
          );
        });
    }, intervalSeconds * 1000);
    timer.unref();
    return () => clearInterval(timer);
  }

  // Defensive read of the progress-comment interval: validate() runs at
  // startup only, so a hot-reloaded invalid value disables the heartbeats.
  private progressCommentIntervalSeconds(): number {
    const value = this.config.TASK_PROGRESS_COMMENT_INTERVAL;
    return Number.isInteger(value) && value > 0 ? value : 0;
  }

  // Finalizes a task aborted at user request (its status was moved to the
  // action abort status on Planner while the CLI ran): posts a short abort
  // comment and cleans the local task folder when the abort status is the
  // cleanup status — otherwise the next polls clean it up when the task
  // reaches TASK_STATUS_CLEANUP. The task keeps the status the user set.
  private async finalizeAbortedTask(
    task: PlannerTask,
    action: AgentAction,
  ): Promise<void> {
    const abortStatus =
      action.statusAbort ?? this.agentActions?.defaultStatusAbort;
    logger.info(
      `Task '${task.title}' (${task.id}) aborted at user request (abort status '${abortStatus ?? "unknown"}' on Planner)`,
    );
    try {
      await this.planner.addTaskComment(
        task.id,
        buildAbortComment(abortStatus),
      );
    } catch (error) {
      logger.error(
        `Failed to post the abort comment for task '${task.title}' (${task.id}): ${(error as Error).message}`,
      );
    }
    if (abortStatus) {
      await this.cleanupTaskFolderIfNeeded(task.id, abortStatus);
    }
  }

  // Reads the partial task summary file left by a failed CLI run, for the
  // failure comment salvage (null when the CLI wrote nothing usable).
  private async readSalvagedSummary(taskId: string): Promise<string | null> {
    try {
      const summaryFile = this.getTaskSummaryFile(taskId);
      if (!(await fse.pathExists(summaryFile))) {
        return null;
      }
      const content = (await fse.readFile(summaryFile, "utf8")).trim();
      if (content.length === 0) {
        return null;
      }
      return content.length > MAX_SALVAGED_SUMMARY_LENGTH
        ? `...${content.slice(-MAX_SALVAGED_SUMMARY_LENGTH)}`
        : content;
    } catch {
      return null;
    }
  }

  // Live scheduling snapshot for the agent note: the tasks currently being
  // processed (title, project, elapsed time, model) and the queue behind
  // the capacity budget (count and titles) as of the last poll.
  public getSchedulingState(): AgentSchedulingSnapshot {
    return {
      running: [...this.processingTasks.values()].map((runningTask) => ({
        title: runningTask.title,
        project: runningTask.projectName,
        elapsed: formatElapsed(Date.now() - runningTask.startedAt),
        model: runningTask.model,
      })),
      queuedCount: this.queuedTasks,
      queuedTitles: [...this.queuedTaskTitles],
    };
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
    // One line per attachment: unsafe names are always reported as skipped,
    // the downloaded ones with their local path, the others as failed.
    const attachmentLines =
      task.attachments.length > 0
        ? task.attachments.map((attachment) => {
            const name = sanitizeAttachmentFileName(attachment.fileName);
            if (name === null) {
              return "- (unsafe file name, skipped)";
            }
            const downloadedPath = downloadedAttachments.find(
              (filePath) => path.basename(filePath) === name,
            );
            return downloadedPath !== undefined
              ? `- ${name} (${downloadedPath})`
              : `- ${name} (download failed)`;
          })
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
      // The dependencies section is only rendered when the task declares
      // dependencies: the brief tells the agent what the task waits on.
      ...dependencyBrief(task.dependencies),
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
        const fileName = sanitizeAttachmentFileName(attachment.fileName);
        if (fileName === null) {
          logger.warn(
            `Skipping attachment with unsafe file name '${attachment.fileName}' for task '${task.title}' (${task.id})`,
          );
          continue;
        }
        const filePath = path.join(attachmentsDir, fileName);
        // Containment is enforced again after resolution, on top of the
        // name sanitization, so no attachment can ever be written outside
        // the task attachments directory.
        const resolvedDir = `${path.resolve(attachmentsDir)}${path.sep}`;
        if (!path.resolve(filePath).startsWith(resolvedDir)) {
          logger.warn(
            `Skipping attachment with unsafe file name '${attachment.fileName}' for task '${task.title}' (${task.id})`,
          );
          continue;
        }
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

// What a poll found: actionable work (scheduler candidates), nothing to
// do, or a failure to reach Planner (the polling cadence is only adapted
// on the first two outcomes).
type PollOutcome = "actionable" | "idle" | "error";

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

// Queue priority of a candidate: the priority of the matching action
// overrides the task's own Planner priority when the action sets one.
function queuePriorityOf(task: PlannerTask, action: AgentAction): string {
  return action.priority ?? task.priority;
}

// Sort key of the task last update, ascending: the oldest update comes
// first. A missing or unparsable date sorts as the oldest task.
function dateUpdatedValue(dateUpdated: string): number {
  const time = Date.parse(dateUpdated);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

// The dependencies that still block a task: only an explicit 'Done' status
// satisfies a dependency (the only done-like status in the catalog, matching
// the 'doneSince' and TASK_STATUS_CLEANUP semantics). A dependency without a
// hydrated status blocks too: fail-closed, since the planner reports the
// status of every existing dependency. An older server that omits the
// dependencies field entirely gates nothing (it has no dependency data).
export function blockingDependencies(
  task: PlannerTask,
): PlannerTaskDependency[] {
  return (task.dependencies ?? []).filter(
    (dependency) => dependency.status !== "Done",
  );
}

// One line per dependency in the task brief: the current title and status
// when the planner hydrated them, the id alone otherwise.
function dependencyLines(dependencies: PlannerTaskDependency[]): string {
  return dependencies
    .map((dependency) => {
      const title = dependency.title ?? dependency.taskId;
      const status = dependency.status ?? "unknown";
      return `- ${title} (${dependency.taskId}) — status: ${status}`;
    })
    .join("\n");
}

// The dependencies section of the task brief: empty unless the task
// declares dependencies.
function dependencyBrief(
  dependencies: PlannerTaskDependency[] | undefined,
): string[] {
  if (!dependencies || dependencies.length === 0) {
    return [];
  }
  return ["## Dependencies", "", dependencyLines(dependencies), ""];
}

// The instruction of an adjustment pass: the action instruction (when set)
// followed by the new-comment directive and the new comments themselves.
function buildAdjustmentInstruction(
  instruction: string | undefined,
  newComments: PlannerTaskComment[],
): string {
  const parts: string[] = [];
  if (instruction && instruction.trim().length > 0) {
    parts.push(instruction);
  }
  parts.push(
    [
      MAX_ADJUSTMENT_DIRECTIVE,
      ...newComments.map(
        (comment) =>
          `- **${comment.userName || comment.userId}** (${comment.dateCreated}): ${comment.text}`,
      ),
    ].join("\n"),
  );
  return parts.join("\n\n");
}

// The comment posted on a task that failed to process: the explanation of
// the error, kept concise, the partial work salvaged from the failed CLI
// run (partial summary and output tail) when any exists, and the resulting
// status change.
function buildFailureComment(
  message: string,
  endStatus: string,
  salvagedSummary: string | null = null,
  salvagedOutput: string | null = null,
): string {
  const explanation =
    message.length > MAX_FAILURE_EXPLANATION_LENGTH
      ? `${message.slice(0, MAX_FAILURE_EXPLANATION_LENGTH)}...`
      : message;
  const sections = ["Task processing failed:", explanation];
  if (salvagedSummary) {
    sections.push(
      "",
      "Partial summary written before the failure:",
      salvagedSummary,
    );
  }
  if (salvagedOutput) {
    sections.push("", "Last CLI output:", salvagedOutput);
  }
  sections.push(
    "",
    `The task was moved to '${endStatus}' so it does not block the agent. Check the agent logs for more details.`,
  );
  return sections.join("\n");
}

// The comment posted on a task aborted at user request: the abort status
// detected on Planner and the fact that no summary was produced. The task
// keeps the status the user set.
function buildAbortComment(abortStatus: string | undefined): string {
  return `Task aborted at user request: the task status was moved to '${
    abortStatus ?? "the abort status"
  }' on Planner while the agent was working on it. The CLI execution was stopped and no summary was produced; the task keeps this status.`;
}
