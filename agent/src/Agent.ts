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
  PlannerRequestError,
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

// Maximum length of a Planner label name (task_labels.name VARCHAR(100)).
const MAX_LABEL_LENGTH = 100;

// Delay before the stale running labels are reconciled at startup. The
// deployment is a rolling update: the previous pod stops within its 15 s
// shutdown guard, so a longer delay never clears the label of a task it is
// still finishing.
const RUNNING_LABEL_RECONCILE_DELAY_MS = 60000;

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

// Appended to the final summary when an adjustment round failed: the
// completed run is still reported, and the user sees that the comments
// posted during the run were not taken into account.
const ADJUSTMENT_FAILURE_NOTE =
  "Note: an adjustment round failed, so comments posted during the run were not taken into account.";

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

/**
 * Normalizes a raw value for a machine label: lowercase kebab-case, dots
 * kept (model version numbers), runs of separators collapsed and leading or
 * trailing separators stripped.
 */
export function normalizeLabelValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");
}

/**
 * Builds a prefixed label from a raw value (e.g. 'model:' + 'Qwen3.8-Flash'
 * -> 'model:qwen3.8-flash'), truncated to the Planner name limit. Returns
 * null when the normalized value is empty or the prefix is disabled.
 */
export function buildTaskLabel(
  prefix: string,
  value: string,
): string | null {
  const normalizedPrefix = prefix.trim();
  const normalized = normalizeLabelValue(value);
  if (normalizedPrefix.length === 0 || normalized.length === 0) {
    return null;
  }
  return `${normalizedPrefix}${normalized}`.slice(0, MAX_LABEL_LENGTH);
}

/**
 * Merges labels into a task label list: existing labels first (order
 * preserved, duplicates dropped), then the new ones. Only used by the
 * whole-list fallback for Planner servers without the atomic label
 * mutation endpoint; the fallback replaces the whole list, so the merge
 * keeps the labels set by humans.
 */
export function mergeLabels(
  current: string[],
  labelsToAdd: string[],
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const label of [...current, ...labelsToAdd]) {
    if (label.length === 0 || seen.has(label)) {
      continue;
    }
    seen.add(label);
    merged.push(label);
  }
  return merged;
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
  // Timer of the startup reconciliation of stale running labels.
  private runningLabelTimer?: NodeJS.Timeout;
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
    this.scheduleRunningLabelReconciliation();
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
    if (this.runningLabelTimer) {
      clearTimeout(this.runningLabelTimer);
      this.runningLabelTimer = undefined;
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
  // agent poll faster than the base interval. When any comment-triggered
  // action is configured, the ceiling is the base interval itself: the
  // backoff never extends past it, so a user comment is answered within
  // one base interval (the live configuration is re-read on every call, so
  // hot-reload is picked up automatically).
  private maxPollingIntervalSeconds(): number {
    if (this.hasCommentTriggeredActions()) {
      return this.pollingIntervalSeconds();
    }
    return Math.max(
      this.pollingIntervalSeconds(),
      this.configuredMaxPollingIntervalSeconds(),
    );
  }

  // Whether at least one action of the (live, hot-reloaded) configuration
  // is comment-triggered.
  private hasCommentTriggeredActions(): boolean {
    return this.getActions().some((action) => action.trigger === "comments");
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
      // processed is never picked again by a subsequent poll. The first
      // action in configuration order whose project pattern and start status
      // match owns the task: it claims the task before the eligibility gates
      // below, so a task it deliberately leaves alone (a conversation waiting
      // for the user, a blocked dependency) is never picked up by a later
      // overlapping action. The claim set is rebuilt from the configuration
      // and the comments on every poll, so the rule is stateless and
      // restart-safe. A task with a dependency that is not Done yet is only
      // reported as deferred (no status change, no error comment) and is
      // picked up naturally once its dependencies complete. Every claimed
      // (task, action) pair that passes the gates is a candidate; the
      // scheduler then fills the capacity budget from the candidates sorted
      // by queue priority. The budget is shared by every action.
      const candidates: SchedulerPickless[] = [];
      const dependencyDeferrals: SchedulerDeferral[] = [];
      const claimedTaskIds = new Set<string>();
      for (const action of actions) {
        for (const task of tasks) {
          if (
            !this.matchesAction(task, action, projects) ||
            this.processingTasks.has(task.id) ||
            // A task with a pending finalization completed already: only its
            // Planner updates remain, never a new CLI execution.
            this.finalizationStore.has(task.id) ||
            claimedTaskIds.has(task.id)
          ) {
            continue;
          }
          // Taking the claim before the gates is what makes "the first
          // matching action wins" hold whatever the trigger state: the gates
          // only decide whether the owning action processes the task now.
          claimedTaskIds.add(task.id);
          // Comment-triggered actions only pick a task up when the
          // conversation waits for the agent: zero comments (the
          // description is the initial prompt) or a last comment the agent
          // did not author. A conversation waiting for the user is not
          // queued work, so the skip is silent (no deferral, no queue
          // gauge entry). The predicate is evaluated over the data every
          // poll already fetched, which makes the rule stateless and
          // restart-safe.
          if (
            action.trigger === "comments" &&
            !commentsPickupPending(task, this.agentUserId)
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
    // The exact running label added at start, removed in the finally even if
    // TASK_RUNNING_LABEL or TASK_LABELS is hot-reloaded during the run.
    let runningLabel: string | null = null;
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
      // The task shows as executing through the agent-managed labels: the
      // transient running label is removed on every exit path (finally),
      // while the model/CLI provenance labels accumulate across the task
      // lifecycle. Best-effort, like the legacy start comment.
      runningLabel = await this.addTaskRunLabels(
        task,
        resolvedModel,
        selectedAgent,
      );
      // Pipeline actions notify on every run; a comments action only on
      // the first run of the task (stateless test: no agent-authored
      // comment exists yet), so a fast comment back-and-forth does not
      // flood the task with "started working" lines. The comment is a
      // legacy fallback: the labels above replace it by default.
      if (this.config.AGENT_START_COMMENT) {
        if (
          action.trigger !== "comments" ||
          !hasAgentComment(task, this.agentUserId)
        ) {
          await this.postStartComment(task, resolvedModel);
        }
      }
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
        // Pick-time snapshot, so the check matches abortRequestedTasks even
        // if the actions config is hot-reloaded mid-run.
        statusAbort: this.processingTasks.get(task.id)?.statusAbort,
      });
      const outcome = await this.finalizeCompletedTask(task.id);
      this.finalizationStore.delete(task.id);
      logger.info(
        outcome === "aborted"
          ? `Task '${task.title}' (${task.id}) completed; its status '${this.processingTasks.get(task.id)?.statusAbort ?? "unknown"}' was kept (user abort)`
          : action.statusEnd === null
            ? `Task '${task.title}' (${task.id}) completed (comment-only finalization)`
            : `Task '${task.title}' (${task.id}) completed and moved to status '${action.statusEnd}'`,
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
      const salvagedSummary = await this.readSalvagedSummary(task.id);
      const salvagedOutput = extractErrorOutputTail(
        error,
        MAX_SALVAGED_OUTPUT_LENGTH,
      );
      if (action.trigger === "comments") {
        // Comments mode: no status move (the resolved error status is
        // ignored) and no folder cleanup — the failure comment reports the
        // problem and the user comments again to trigger a new run.
        try {
          await this.planner.addTaskComment(
            task.id,
            buildFailureComment(message, null, salvagedSummary, salvagedOutput),
          );
          logger.info(
            `Task '${task.title}' (${task.id}) failed: the failure comment was posted and the task keeps its status (comments mode)`,
          );
        } catch (commentError) {
          logger.error(
            `Failed to post the failure comment for task '${task.title}' (${task.id}): ${(commentError as Error).message}`,
          );
        }
        return;
      }
      // A failing task must not block the agent by staying in the start
      // status forever: it is moved to the resolved error status (the action
      // status_error, then the actions default status_error, then the end
      // status) with an explanation, salvaging the partial work of the CLI
      // run (partial summary file and output tail) when any exists.
      // statusEnd is always set in the pipeline mode (the validation
      // rejects a status action without one).
      const errorStatus =
        action.statusError ??
        this.agentActions?.defaultStatusError ??
        action.statusEnd!;
      try {
        await this.planner.addTaskComment(
          task.id,
          buildFailureComment(
            message,
            errorStatus,
            salvagedSummary,
            salvagedOutput,
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
      if (runningLabel !== null) {
        await this.clearTaskRunningLabel(task, runningLabel);
      }
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
  // successful run and the freshest observed task content version. The
  // adjustment rounds are best-effort: a failed Planner read or a failed
  // adjustment run never discards the completed work (the task finalizes
  // with the summary of the last successful run, plus a note when an
  // adjustment round failed). Only a user abort is rethrown, so it still
  // wins over the finalization; only a failure of the initial run takes the
  // processTask error path.
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
      try {
        await this.writeTaskNotes(freshTask, notesFile, project);
        summary = await cliAgent.performTask(freshTask, notesFile, {
          ...taskOptions,
          instruction: buildAdjustmentInstruction(
            taskOptions.instruction,
            newComments,
          ),
        });
      } catch (error) {
        if (isCliAbortError(error)) {
          // A user abort always wins over the finalization.
          throw error;
        }
        logger.warn(
          `Task '${task.title}' (${task.id}) adjustment round ${roundsUsed}/${maxRounds} failed (finalizing with the summary of the last successful run): ${(error as Error).message}`,
        );
        return {
          summary: `${summary}\n\n${ADJUSTMENT_FAILURE_NOTE}`,
          contentVersion,
        };
      }
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
  // a previous attempt already did) and moves the task to its end status
  // unless the record is comment-only (comments mode: the task never
  // changes status, so no folder cleanup applies either). Before the
  // end-status update the task is re-fetched: when the user moved it to the
  // abort status after the CLI finished, the summary is still posted but the
  // end status is not applied and the folder is not cleaned (an aborted
  // work is still reported; the user-set status wins). A failed re-fetch
  // propagates so the caller schedules a retry: the same Planner API is
  // needed for the status update anyway. Idempotent, driven by the
  // FinalizationStore record of the task.
  private async finalizeCompletedTask(
    taskId: string,
  ): Promise<"finalized" | "aborted"> {
    const record = this.finalizationStore.get(taskId);
    if (!record) {
      return "finalized";
    }
    if (!record.commentPosted) {
      await this.planner.addTaskComment(taskId, record.summary);
      this.finalizationStore.markCommentPosted(taskId);
    }
    if (record.statusEnd === null) {
      return "finalized";
    }
    if (record.statusAbort !== null) {
      const current = await this.planner.getTask(taskId);
      if (current.status === record.statusAbort) {
        logger.info(
          `Task '${record.title}' (${taskId}) is in its abort status '${record.statusAbort}': keeping the user-set status (the summary comment was posted)`,
        );
        return "aborted";
      }
    }
    await this.planner.updateTaskStatus(taskId, record.statusEnd);
    await this.cleanupTaskFolderIfNeeded(taskId, record.statusEnd);
    return "finalized";
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
        const outcome = await this.finalizeCompletedTask(taskId);
        this.finalizationStore.delete(taskId);
        logger.info(
          outcome === "aborted"
            ? `Task '${record.title}' (${taskId}) finalized on retry; its status '${record.statusAbort}' was kept (user abort)`
            : record.statusEnd === null
              ? `Task '${record.title}' (${taskId}) finalized on retry (comment-only finalization)`
              : `Task '${record.title}' (${taskId}) finalized on retry and moved to status '${record.statusEnd}'`,
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

  // Whether the agent manages Planner task labels (master switch).
  private taskLabelsEnabled(): boolean {
    return this.config.TASK_LABELS !== false;
  }

  private runningLabel(): string {
    return (this.config.TASK_RUNNING_LABEL ?? "").trim();
  }

  // Labels recording what worked on the task: the normalized model and,
  // when a prefix is configured, the CLI agent. They accumulate across runs
  // and are never removed.
  private provenanceLabels(model: string, cliAgent: string): string[] {
    const labels: string[] = [];
    const modelLabel = buildTaskLabel(
      this.config.TASK_MODEL_LABEL_PREFIX ?? "",
      model,
    );
    if (modelLabel) {
      labels.push(modelLabel);
    }
    const cliLabel = buildTaskLabel(
      this.config.TASK_CLI_LABEL_PREFIX ?? "",
      cliAgent,
    );
    if (cliLabel) {
      labels.push(cliLabel);
    }
    return labels;
  }

  // Marks the task as running and records its provenance in one atomic
  // mutation (the running label plus the model/CLI labels), without reading
  // the task first. Returns the exact running label added (null when labels
  // are disabled or no running label is configured), so the finally removes
  // that label even if the configuration is hot-reloaded during the run.
  // Best-effort: a label failure is logged but never fails the task
  // processing.
  private async addTaskRunLabels(
    task: PlannerTask,
    model: string,
    cliAgent: string,
  ): Promise<string | null> {
    if (!this.taskLabelsEnabled()) {
      return null;
    }
    const labelsToAdd = this.provenanceLabels(model, cliAgent);
    const runningLabel = this.runningLabel();
    if (runningLabel.length > 0) {
      labelsToAdd.unshift(runningLabel);
    }
    if (labelsToAdd.length === 0) {
      return null;
    }
    const add = mergeLabels([], labelsToAdd);
    await this.applyLabelMutation(
      task,
      { add },
      `add the agent labels (${add.join(", ")})`,
    );
    return runningLabel.length > 0 ? runningLabel : null;
  }

  // Removes the exact running label added at task start; the provenance
  // labels stay. Called on every exit path of processTask through its
  // finally, with the snapshot taken when the run started (never the live
  // configuration).
  private async clearTaskRunningLabel(
    task: PlannerTask,
    runningLabel: string,
  ): Promise<void> {
    await this.applyLabelMutation(
      task,
      { remove: [runningLabel] },
      `remove the running label '${runningLabel}'`,
    );
  }

  // Applies an atomic add/remove label mutation and returns whether anything
  // changed (the server applies only the difference, so repeated or
  // overlapping calls are idempotent). Against a Planner without the PATCH
  // endpoint (404/405, e.g. an older deploy) it falls back to the
  // read-merge-write whole-list replace. Writes are quiet: the server skips
  // the "Labels updated" feed entry and the assignee notification. Returns
  // whether a real change was written. Best-effort: failures are logged,
  // never propagated.
  private async applyLabelMutation(
    task: PlannerTask,
    mutation: { add?: string[]; remove?: string[] },
    description: string,
  ): Promise<boolean> {
    try {
      const result = await this.planner.mutateTaskLabels(task.id, {
        add: mutation.add ?? [],
        remove: mutation.remove ?? [],
        quiet: true,
      });
      return result.changed;
    } catch (error) {
      if (
        !(error instanceof PlannerRequestError) ||
        (error.status !== 404 && error.status !== 405)
      ) {
        logger.warn(
          `Failed to ${description} for task '${task.title}' (${task.id}) (continuing): ${(error as Error).message}`,
        );
        return false;
      }
    }
    return this.updateTaskLabelsFallback(task, mutation, description);
  }

  // Legacy whole-list replace for Planner servers without the atomic label
  // mutation endpoint: a fresh read keeps the overwrite window tiny, the
  // merge preserves the labels set by humans and a no-op change is skipped.
  private async updateTaskLabelsFallback(
    task: PlannerTask,
    mutation: { add?: string[]; remove?: string[] },
    description: string,
  ): Promise<boolean> {
    try {
      const fresh = await this.planner.getTask(task.id);
      const current = fresh.labels ?? [];
      const removed = new Set(mutation.remove ?? []);
      const updated = mergeLabels(
        current.filter((label) => !removed.has(label)),
        mutation.add ?? [],
      );
      if (
        updated.length === current.length &&
        updated.every((label, index) => label === current[index])
      ) {
        return false;
      }
      await this.planner.updateTaskLabels(task.id, updated);
      return true;
    } catch (error) {
      logger.warn(
        `Failed to ${description} for task '${task.title}' (${task.id}) (continuing): ${(error as Error).message}`,
      );
      return false;
    }
  }

  // Reconciles the stale running labels left by a previous process (crash
  // or hard kill): after the startup delay the agent lists its assigned
  // tasks carrying the running label and clears it, skipping the tasks it
  // is processing itself. The delay protects the tasks a previous pod may
  // still be finishing during a rolling update.
  private scheduleRunningLabelReconciliation(): void {
    if (!this.taskLabelsEnabled() || this.runningLabel().length === 0) {
      return;
    }
    this.runningLabelTimer = setTimeout(() => {
      this.runningLabelTimer = undefined;
      void this.reconcileRunningLabels().catch((error: Error) => {
        logger.warn(
          `Failed to reconcile the stale running labels: ${error.message}`,
        );
      });
    }, RUNNING_LABEL_RECONCILE_DELAY_MS);
    this.runningLabelTimer.unref();
  }

  private async reconcileRunningLabels(): Promise<void> {
    const runningLabel = this.runningLabel();
    const user = await this.planner.getCurrentUser();
    this.agentUserId = user.id;
    const tasks = await this.planner.listAssignedTasks(user, undefined, [
      runningLabel,
    ]);
    let cleared = 0;
    for (const task of tasks) {
      if (this.processingTasks.has(task.id)) {
        continue;
      }
      if (
        await this.applyLabelMutation(
          task,
          { remove: [runningLabel] },
          `reconcile the stale running label '${runningLabel}'`,
        )
      ) {
        cleared++;
      }
    }
    if (tasks.length > 0) {
      logger.info(
        `Running label reconciliation: cleared '${runningLabel}' on ${cleared} of ${tasks.length} task(s)`,
      );
    }
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
    // Comments mode never moves the task: even the config-wide
    // default.status_in_progress must not silently move a conversational
    // task out of its start status, which would kill the next pickups.
    if (action.trigger === "comments") {
      return;
    }
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
      // The notes file embeds the previous brief, including the user
      // comments: a comment quoting the marker must not truncate the
      // preserved notes, so split after the last marker section.
      const markerIndex = existing.lastIndexOf(AGENT_NOTES_MARKER);
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

// Sort key of a comment timestamp, with unparsable dates as the oldest.
function commentTimestamp(dateCreated: string): number {
  const time = Date.parse(dateCreated);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

// The most recent comment of a task: the greatest server-generated
// dateCreated, and the later array index on equal timestamps (robust to any
// ordering of the comments array by the server). Null when the task has no
// comment.
export function lastCommentOf(task: PlannerTask): PlannerTaskComment | null {
  let last: PlannerTaskComment | null = null;
  let lastTime = Number.NEGATIVE_INFINITY;
  for (const comment of task.comments) {
    const time = commentTimestamp(comment.dateCreated);
    if (last === null || time >= lastTime) {
      last = comment;
      lastTime = time;
    }
  }
  return last;
}

// Whether a comment-triggered action must pick the task up now: zero
// comments means pending (the description is the initial prompt) and
// otherwise the task is picked up exactly when its last comment was not
// authored by the agent. A null agentUserId is fail-safe: the agent's own
// comments cannot be told apart from the user ones, so picking could loop
// on the agent's own summary.
export function commentsPickupPending(
  task: PlannerTask,
  agentUserId: string | null,
): boolean {
  if (agentUserId === null) {
    return false;
  }
  const last = lastCommentOf(task);
  return last === null || last.userId !== agentUserId;
}

// Whether the agent already commented on the task at least once: the
// stateless "first run" test of the comments mode (the one-line start
// comment is posted on the first run only, to keep a fast back-and-forth
// readable).
export function hasAgentComment(
  task: PlannerTask,
  agentUserId: string | null,
): boolean {
  if (agentUserId === null) {
    return false;
  }
  return task.comments.some((comment) => comment.userId === agentUserId);
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
// run (partial summary and output tail) when any exists, and the outcome:
// the end status the task was moved to, or — for a comments action
// (endStatus null) — the fact that the task keeps its status and a new
// user comment triggers a new run.
function buildFailureComment(
  message: string,
  endStatus: string | null,
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
    endStatus === null
      ? "The task keeps its status: post a new comment on the task to trigger a new run. Check the agent logs for more details."
      : `The task was moved to '${endStatus}' so it does not block the agent. Check the agent logs for more details.`,
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
