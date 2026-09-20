import { TASK_CONFLICT_MODES, type ConflictMode } from "./Config";
import type { AgentAction } from "./AgentActions";
import type { PlannerTask } from "./PlannerClient";

// Scheduling weights are bounded so a single task can neither occupy less
// than a quarter of the capacity budget nor more than a full slot.
export const MIN_TASK_WEIGHT = 0.25;
export const MAX_TASK_WEIGHT = 1;
export const DEFAULT_TASK_WEIGHT = 1;

// Tolerance of the weighted-budget comparison: weights and budgets can be
// decimals (e.g. TASK_MAX_PARALLEL=1.9) and must not be rejected because of
// binary floating-point rounding.
const WEIGHT_EPSILON = 1e-9;

/**
 * Metadata of a task while it is running: the backbone of the capacity and
 * conflict decisions and of the running-tasks observability. One agent
 * process per agent identity is assumed: this state is in-memory only and
 * is not shared across instances.
 */
export interface RunningTask {
  taskId: string;
  title: string;
  projectName: string;
  actionKey: string;
  weight: number;
  conflictKeys: string[];
  startedAt: number;
  model: string;
}

// A ready (task, action) pair with the resolved project name (empty when
// the project cannot be resolved).
export interface SchedulerCandidate {
  task: PlannerTask;
  action: AgentAction;
  projectName: string;
}

// Result of the utility-model pre-evaluation of a task without explicit
// hints (see TaskEvaluator).
export interface TaskEvaluation {
  weight: number;
  conflicts: string[];
  kind: string;
}

export interface SchedulerOptions {
  // Weighted capacity budget (TASK_MAX_PARALLEL): a candidate is admitted
  // when the total weight of the running tasks plus its weight fits.
  maxParallel: number;
  // How automatic conflict keys are derived from the task content.
  conflictMode: ConflictMode;
  // Utility-model evaluations by task id; candidates without an entry fall
  // back to the default weight and the deterministic conflict keys.
  evaluations?: Map<string, TaskEvaluation>;
}

export interface SchedulerPick {
  task: PlannerTask;
  action: AgentAction;
  projectName: string;
  weight: number;
  conflictKeys: string[];
}

export interface SchedulerDeferral {
  task: PlannerTask;
  // 'capacity' or 'conflict:<key>'.
  reason: string;
}

export interface SchedulerSelection {
  picks: SchedulerPick[];
  deferrals: SchedulerDeferral[];
}

// The task description directives: 'agent-weight: <n>' hints the scheduling
// weight and 'agent-lock: <key>' lines (comma-separated keys, multiple lines
// allowed) declare the resources the task will work on. Both are read from
// the description only, like the 'agent-model:' directive.
const AGENT_WEIGHT_PATTERN = /^\s*agent-weight:\s*(\S+)\s*$/im;
const AGENT_LOCK_PATTERN = /^\s*agent-lock:\s*(.+)$/gim;

// Deterministic repository-slug extraction for the automatic conflict keys:
// GitHub HTTPS URLs, GitHub SSH clone URLs and 'owner/repo' slugs in
// backticks. The conservative set avoids locking on bare 'owner/repo'
// mentions anywhere in the text.
const REPO_PATTERNS: RegExp[] = [
  /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)/g,
  /git@github\.com[:/]([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)/g,
  /`([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)`/g,
];

const REPO_KEY_PATTERN = /^repo:[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/;
const REPO_SLUG_PATTERN = /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/;

export function extractAgentWeight(description: string): number | null {
  const match = description.match(AGENT_WEIGHT_PATTERN);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

// Normalizes a conflict key so the explicit directives, the automatic
// extraction and the utility-model keys match: lowercase; an 'owner/repo'
// slug becomes 'repo:owner/repo'.
export function normalizeConflictKey(key: string): string {
  const trimmed = key.trim().toLowerCase();
  if (REPO_KEY_PATTERN.test(trimmed) || REPO_SLUG_PATTERN.test(trimmed)) {
    return trimmed.startsWith("repo:") ? trimmed : `repo:${trimmed}`;
  }
  return trimmed;
}

// The utility model may only contribute repository conflict keys: keys
// without the repo shape are dropped so an LLM answer cannot inject
// arbitrary locks (fail-open except for the explicit agent-lock keys).
export function normalizeRepoConflictKey(key: string): string | null {
  const normalized = normalizeConflictKey(key);
  return REPO_KEY_PATTERN.test(normalized) ? normalized : null;
}

export function extractAgentLockKeys(description: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const match of description.matchAll(AGENT_LOCK_PATTERN)) {
    for (const part of match[1].split(",")) {
      if (part.trim().length === 0) {
        continue;
      }
      const normalized = normalizeConflictKey(part);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        keys.push(normalized);
      }
    }
  }
  return keys;
}

// Extracts the 'repo:owner/repo' conflict keys from the task description
// and comments.
export function extractRepoConflictKeys(task: PlannerTask): string[] {
  const texts = [task.description, ...task.comments.map((comment) => comment.text)];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const source of REPO_PATTERNS) {
      // A fresh RegExp per scan keeps the global patterns stateless.
      const pattern = new RegExp(source.source, source.flags);
      for (const match of text.matchAll(pattern)) {
        // Trailing dots are sentence punctuation, not part of the slug;
        // the '.git' suffix of clone URLs is stripped too.
        const owner = match[1].toLowerCase().replace(/\.+$/, "");
        const repo = match[2]
          .toLowerCase()
          .replace(/\.+$/, "")
          .replace(/\.git$/, "");
        if (owner.length === 0 || repo.length === 0) {
          continue;
        }
        const key = `repo:${owner}/${repo}`;
        seen.add(key);
      }
    }
  }
  return [...seen];
}

// The deterministic conflict keys of a candidate: the explicit agent-lock
// keys always apply (fail-closed by design), the automatic keys follow the
// conflict mode ('repo' extracts repository slugs, 'project' additionally
// serializes the tasks of the same Planner project, 'none' adds nothing).
export function resolveStaticConflictKeys(
  candidate: SchedulerCandidate,
  conflictMode: ConflictMode,
): string[] {
  const keys = new Set<string>(extractAgentLockKeys(candidate.task.description));
  if (conflictMode !== "none") {
    for (const key of extractRepoConflictKeys(candidate.task)) {
      keys.add(key);
    }
  }
  if (conflictMode === "project" && candidate.projectName.trim().length > 0) {
    keys.add(`project:${candidate.projectName.trim().toLowerCase()}`);
  }
  return [...keys];
}

export function clampWeight(weight: number): number {
  if (!Number.isFinite(weight)) {
    return DEFAULT_TASK_WEIGHT;
  }
  return Math.min(MAX_TASK_WEIGHT, Math.max(MIN_TASK_WEIGHT, weight));
}

// Weight resolution, cheapest source wins: the 'agent-weight:' directive,
// then the action weight, then the default (the utility-model evaluation
// fills the same slot as the action weight for the tasks without explicit
// hints). The value is clamped to the bounded scale.
export function resolveTaskWeight(
  description: string,
  actionWeight: number | null,
): number {
  const directive = extractAgentWeight(description);
  const explicit =
    directive ?? (typeof actionWeight === "number" ? actionWeight : null);
  return clampWeight(explicit ?? DEFAULT_TASK_WEIGHT);
}

// A candidate has an explicit weight hint when its description carries an
// 'agent-weight:' directive or its action configures a weight: the free
// sources win and no utility-model evaluation is needed.
export function hasExplicitWeightHint(candidate: SchedulerCandidate): boolean {
  return (
    extractAgentWeight(candidate.task.description) !== null ||
    typeof candidate.action.weight === "number"
  );
}

export function runningWeight(running: Map<string, RunningTask>): number {
  let total = 0;
  for (const runningTask of running.values()) {
    total += clampWeight(runningTask.weight);
  }
  return total;
}

// Label of an action in the running-task metadata and logs.
export function actionKeyOf(action: AgentAction): string {
  return `${action.project.length > 0 ? action.project : "*"}:${action.statusStart}`;
}

// Defensive read of the capacity budget: validate() runs at startup only,
// so a hot-reloaded invalid value falls back to the default instead of
// breaking the selection.
export function sanitizeBudget(maxParallel: number): number {
  return Number.isFinite(maxParallel) && maxParallel > 0 ? maxParallel : 1;
}

/**
 * Process-count cap of the capacity budget: every running task executes one
 * full CLI process, whatever its scheduling weight, and the CLI heap is
 * sized from the container memory limit — the process count, not the weight
 * sum, is what the container memory must hold. The weighted budget never
 * runs more CLI processes than the historical count semantics of the same
 * budget value (ceil), so upgrading from the count-based scheduler cannot
 * multiply the concurrent processes: TASK_MAX_PARALLEL=1.9 keeps running at
 * most 2 CLI processes at a time, and small weights only change which tasks
 * fill those process slots.
 */
export function maxConcurrentTasks(maxParallel: number): number {
  return Math.ceil(sanitizeBudget(maxParallel));
}

export function normalizeConflictMode(mode: string): ConflictMode {
  return (TASK_CONFLICT_MODES as readonly string[]).includes(mode)
    ? (mode as ConflictMode)
    : "repo";
}

function claimedRunningKeys(running: Map<string, RunningTask>): Set<string> {
  const claimed = new Set<string>();
  for (const runningTask of running.values()) {
    for (const key of runningTask.conflictKeys) {
      claimed.add(key);
    }
  }
  return claimed;
}

/**
 * The tasks of the shortlist may still be admitted this round and carry no
 * explicit weight hint: they are the only ones worth a utility-model
 * evaluation (cost control). The candidates are walked in the queue order
 * with optimistic weights (an unknown weight is assumed to be the minimum)
 * and without evaluator-added conflicts, so the shortlist is a superset of
 * the tasks the final selection can admit without an evaluation.
 */
export function selectEvaluationShortlist(
  candidates: SchedulerCandidate[],
  running: Map<string, RunningTask>,
  options: SchedulerOptions,
): SchedulerCandidate[] {
  const budget = sanitizeBudget(options.maxParallel);
  const conflictMode = normalizeConflictMode(options.conflictMode);
  // The evaluations are CLI processes too: no task beyond the process cap
  // of this round is worth a utility-model call.
  const freeProcessSlots = maxConcurrentTasks(options.maxParallel) - running.size;
  let usedWeight = runningWeight(running);
  const claimedKeys = claimedRunningKeys(running);
  const shortlist: SchedulerCandidate[] = [];
  let admitted = 0;
  for (const candidate of candidates) {
    if (
      budget - usedWeight < MIN_TASK_WEIGHT - WEIGHT_EPSILON ||
      admitted >= freeProcessSlots
    ) {
      // No candidate can fit the remaining budget or process slots anymore.
      break;
    }
    const conflictKeys = resolveStaticConflictKeys(candidate, conflictMode);
    if (conflictKeys.some((key) => claimedKeys.has(key))) {
      // Statically conflicting tasks are never admitted: no evaluation.
      continue;
    }
    const explicitWeight =
      extractAgentWeight(candidate.task.description) ??
      (typeof candidate.action.weight === "number"
        ? candidate.action.weight
        : null);
    const assumedWeight = explicitWeight ?? MIN_TASK_WEIGHT;
    if (usedWeight + assumedWeight > budget + WEIGHT_EPSILON) {
      // Cannot fit even with the smallest possible weight: keep walking
      // (no head-of-line blocking), no evaluation.
      continue;
    }
    if (explicitWeight === null) {
      shortlist.push(candidate);
    }
    // Simulate the optimistic admission for the following candidates.
    usedWeight += assumedWeight;
    admitted++;
    for (const key of conflictKeys) {
      claimedKeys.add(key);
    }
  }
  return shortlist;
}

/**
 * Greedy first-fit selection over the candidates in the given (priority)
 * order: a task is picked when its weight fits the remaining capacity
 * budget and it shares no conflict key with a running task or a task picked
 * in this round; otherwise it is deferred with a reason and the walk
 * continues, so a blocked high-priority task never blocks unrelated
 * lower-priority tasks (no head-of-line blocking). Deferred tasks are
 * retried naturally on the next poll.
 */
export function selectTasks(
  candidates: SchedulerCandidate[],
  running: Map<string, RunningTask>,
  options: SchedulerOptions,
): SchedulerSelection {
  const budget = sanitizeBudget(options.maxParallel);
  const conflictMode = normalizeConflictMode(options.conflictMode);
  // Every picked task is one full CLI process: the weighted budget fills
  // the process slots left by the running tasks (see maxConcurrentTasks).
  const freeProcessSlots = maxConcurrentTasks(options.maxParallel) - running.size;
  let usedWeight = runningWeight(running);
  const claimedKeys = claimedRunningKeys(running);
  const picks: SchedulerPick[] = [];
  const deferrals: SchedulerDeferral[] = [];
  for (const candidate of candidates) {
    const evaluation = options.evaluations?.get(candidate.task.id);
    const explicitWeight =
      extractAgentWeight(candidate.task.description) ??
      (typeof candidate.action.weight === "number"
        ? candidate.action.weight
        : null);
    const weight = clampWeight(
      explicitWeight ?? evaluation?.weight ?? DEFAULT_TASK_WEIGHT,
    );
    const conflictKeys = [
      ...new Set([
        ...resolveStaticConflictKeys(candidate, conflictMode),
        ...(evaluation && !hasExplicitWeightHint(candidate)
          ? evaluation.conflicts
              .map(normalizeRepoConflictKey)
              .filter((key): key is string => key !== null)
          : []),
      ]),
    ];
    const blockingKey = conflictKeys.find((key) => claimedKeys.has(key));
    if (blockingKey !== undefined) {
      deferrals.push({
        task: candidate.task,
        reason: `conflict:${blockingKey}`,
      });
      continue;
    }
    if (
      usedWeight + weight > budget + WEIGHT_EPSILON ||
      picks.length >= freeProcessSlots
    ) {
      deferrals.push({ task: candidate.task, reason: "capacity" });
      continue;
    }
    picks.push({
      task: candidate.task,
      action: candidate.action,
      projectName: candidate.projectName,
      weight,
      conflictKeys,
    });
    usedWeight += weight;
    for (const key of conflictKeys) {
      claimedKeys.add(key);
    }
  }
  return { picks, deferrals };
}

/**
 * The kill-switch selection (TASK_SMART_SCHEDULING=false): exactly the
 * historical count-based behavior — the first candidates of the queue order
 * fill the free count-based slots; weights, conflicts and the utility model
 * are ignored.
 */
export function selectTasksLegacy(
  candidates: { task: PlannerTask; action: AgentAction }[],
  maxParallel: number,
  runningCount: number,
): { task: PlannerTask; action: AgentAction }[] {
  const freeSlots = maxParallel - runningCount;
  return candidates.slice(0, Math.max(freeSlots, 0));
}
