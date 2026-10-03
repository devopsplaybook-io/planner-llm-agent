import { Config } from "./Config";
import { OTelLogger, OTelMeter } from "./OTelContext";
import type { PlannerTask } from "./PlannerClient";
import type { CliAgentClient } from "./clients/CliAgent";
import {
  clampWeight,
  DEFAULT_TASK_WEIGHT,
  normalizeRepoConflictKey,
  type TaskEvaluation,
} from "./Scheduler";

const logger = OTelLogger().createModuleLogger("task-evaluator");

// At most this many utility-model calls run at the same time.
const EVALUATION_CONCURRENCY = 3;
// The evaluation prompt stays small (~1-2k tokens): title, trimmed
// description and the latest comments are enough for a size estimate.
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_LATEST_COMMENTS = 5;
const MAX_COMMENT_CHARS = 500;

// Bounds of the evaluation caches (L8): entries expire after the TTL and
// the maps never hold more than the maximum number of entries.
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

// Circuit breaker (M3): after this many consecutive timeouts the utility
// model is considered unavailable and is skipped entirely for a cooldown,
// so a hung model cannot eat the evaluation slots on every poll.
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_BASE_MS = 5 * 60 * 1000;
const BREAKER_COOLDOWN_MAX_MS = 30 * 60 * 1000;
// The cooldown is jittered so several agents do not retry in lockstep.
const BREAKER_JITTER_FRACTION = 0.2;

const EVALUATION_KINDS = ["code-heavy", "code-light", "non-code"];
const FALLBACK_KIND = "code-heavy";

export interface EvaluationInput {
  task: PlannerTask;
  projectName: string;
}

export interface TaskEvaluatorOptions {
  timeoutMs?: number;
  concurrency?: number;
}

export interface EvaluateAllOptions {
  // Process-count cap of the calling scheduler: every evaluation runs one
  // full CLI process, so the batch concurrency is lowered to it (never
  // raised above the configured concurrency).
  maxConcurrent?: number;
}

/**
 * Optional fast/cheap LLM pre-evaluation ("utility model") of the tasks
 * without explicit hints: it estimates the scheduling weight and the
 * repositories the task will work on. The model runs on the already
 * configured AGENT_CLI; when AGENT_UTILITY_MODEL is not set the evaluator
 * makes zero LLM calls and every task falls back to the default weight and
 * the deterministic conflict keys.
 */
export class TaskEvaluator {
  private config: Config;
  private cliAgent: CliAgentClient;
  private timeoutMs: number;
  private concurrency: number;
  // Evaluations by task id, invalidated when the task content changes
  // (dateUpdated) or when the entry expires: the steady-state cost of the
  // utility model is near zero while the cache stays bounded (L8).
  private cache = new Map<
    string,
    { dateUpdated: string; evaluation: TaskEvaluation; cachedAt: number }
  >();
  // Content version whose evaluation failure was already logged (log once,
  // not per poll); bounded like the evaluation cache.
  private failureLogged = new Map<string, { version: string; loggedAt: number }>();
  // Consecutive timeouts of the utility model, and until when the breaker
  // skips every call (M3).
  private timeoutStreak = 0;
  private breakerOpenUntil = 0;
  private breakerTrips = 0;
  // Counter of the utility-model timeouts (exported lazily: OpenTelemetry
  // may not be initialized, e.g. in tests).
  private evaluationTimeoutCounter?: { add: (value: number) => void };
  // Semaphore bounding the concurrent utility-model calls.
  private active = 0;
  private waiters: (() => void)[] = [];

  constructor(
    config: Config,
    cliAgent: CliAgentClient,
    options?: TaskEvaluatorOptions,
  ) {
    this.config = config;
    this.cliAgent = cliAgent;
    this.timeoutMs =
      options?.timeoutMs ?? config.AGENT_EVALUATION_TIMEOUT * 1000;
    this.concurrency = Math.max(1, options?.concurrency ?? EVALUATION_CONCURRENCY);
  }

  // The utility model is enabled by setting AGENT_UTILITY_MODEL to a model
  // name available on the configured AGENT_CLI.
  public isEnabled(): boolean {
    return this.config.AGENT_UTILITY_MODEL.trim().length > 0;
  }

  /**
   * Evaluates the given tasks (only the ones the scheduler could still
   * admit are passed in) and returns the results by task id. Without a
   * configured utility model the map stays empty and no LLM call is made.
   */
  public async evaluateAll(
    inputs: EvaluationInput[],
    options?: EvaluateAllOptions,
  ): Promise<Map<string, TaskEvaluation>> {
    const evaluations = new Map<string, TaskEvaluation>();
    if (!this.isEnabled() || inputs.length === 0) {
      return evaluations;
    }
    this.pruneCaches(Date.now());
    const concurrencyLimit = this.evaluationLimit(options?.maxConcurrent);
    await Promise.all(
      inputs.map(async (input) => {
        evaluations.set(
          input.task.id,
          await this.evaluateTask(input.task, input.projectName, concurrencyLimit),
        );
      }),
    );
    return evaluations;
  }

  /**
   * The evaluations already cached for the given inputs, by task id: the
   * scheduling round reads them synchronously and never waits for the
   * utility model (M3). Tasks without a fresh cached evaluation are simply
   * absent (the caller falls back to the default weight).
   */
  public cachedEvaluations(inputs: EvaluationInput[]): Map<string, TaskEvaluation> {
    const evaluations = new Map<string, TaskEvaluation>();
    const now = Date.now();
    for (const input of inputs) {
      const cached = this.cache.get(input.task.id);
      if (
        cached &&
        cached.dateUpdated === input.task.dateUpdated &&
        now - cached.cachedAt <= CACHE_TTL_MS
      ) {
        evaluations.set(input.task.id, cached.evaluation);
      }
    }
    return evaluations;
  }

  public async evaluateTask(
    task: PlannerTask,
    projectName: string,
    concurrencyLimit?: number,
  ): Promise<TaskEvaluation> {
    const cached = this.cache.get(task.id);
    if (
      cached &&
      cached.dateUpdated === task.dateUpdated &&
      Date.now() - cached.cachedAt <= CACHE_TTL_MS
    ) {
      return cached.evaluation;
    }
    // While the breaker is open the utility model is considered down: fall
    // back immediately, without a CLI call and without caching the
    // fallback (the next content version or a closed breaker retries).
    if (this.isEnabled() && Date.now() < this.breakerOpenUntil) {
      logger.warn(
        `Utility-model evaluation of task '${task.title}' (${task.id}) skipped: the circuit breaker is open after consecutive timeouts`,
      );
      return fallbackEvaluation();
    }
    await this.acquire(this.evaluationLimit(concurrencyLimit));
    try {
      // Re-check the cache once the slot is granted: another evaluation of
      // the same content version may have completed in the meantime.
      const cachedInSlot = this.cache.get(task.id);
      if (
        cachedInSlot &&
        cachedInSlot.dateUpdated === task.dateUpdated &&
        Date.now() - cachedInSlot.cachedAt <= CACHE_TTL_MS
      ) {
        return cachedInSlot.evaluation;
      }
      try {
        const evaluation = await this.callUtilityModel(task, projectName);
        this.cacheEvaluation(task.id, task.dateUpdated, evaluation);
        return evaluation;
      } catch {
        // A timed-out utility model must not poison the cache with its
        // fallback: once the model recovers, the next poll retries.
        return fallbackEvaluation();
      }
    } finally {
      this.release();
    }
  }

  // The effective concurrency of a batch: the caller may lower the
  // configured concurrency to its process cap, never raise it.
  private evaluationLimit(maxConcurrent?: number): number {
    return Math.max(
      1,
      Math.min(this.concurrency, maxConcurrent ?? this.concurrency),
    );
  }

  private async acquire(limit: number): Promise<void> {
    if (this.active < limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }

  private async callUtilityModel(
    task: PlannerTask,
    projectName: string,
  ): Promise<TaskEvaluation> {
    const prompt = buildEvaluationPrompt(task, projectName);
    let timeout: NodeJS.Timeout | undefined;
    let timedOut = false;
    try {
      const reply = await Promise.race([
        this.cliAgent.runPrompt(prompt, {
          model: this.config.AGENT_UTILITY_MODEL.trim(),
          timeoutMs: this.timeoutMs,
          purpose: `utility-model evaluation '${task.title.trim()}'`,
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            timedOut = true;
            reject(
              new Error(
                `utility model did not reply within ${Math.round(this.timeoutMs / 1000)} seconds`,
              ),
            );
          }, this.timeoutMs);
        }),
      ]);
      const evaluation = parseEvaluation(reply);
      if (evaluation === null) {
        throw new Error(
          `the reply is not a valid evaluation: ${reply.trim().slice(0, 200)}`,
        );
      }
      // A successful evaluation resets the circuit breaker.
      this.timeoutStreak = 0;
      this.breakerOpenUntil = 0;
      this.breakerTrips = 0;
      return evaluation;
    } catch (error) {
      if (this.failureLogged.get(task.id)?.version !== task.dateUpdated) {
        this.logFailure(task.id, task.dateUpdated);
        logger.error(
          `Utility-model evaluation failed for task '${task.title}' (${task.id}); falling back to the default weight and the deterministic conflict keys: ${(error as Error).message}`,
        );
      }
      if (timedOut) {
        this.recordEvaluationTimeout();
        this.registerTimeout();
        // Thrown so the caller keeps the fallback out of the cache.
        throw error;
      }
      return fallbackEvaluation();
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  // Records a consecutive timeout and opens the circuit breaker once the
  // threshold is reached (jittered, doubling cooldown).
  private registerTimeout(): void {
    this.timeoutStreak += 1;
    if (this.timeoutStreak < BREAKER_THRESHOLD) {
      return;
    }
    const base = Math.min(
      BREAKER_COOLDOWN_BASE_MS * 2 ** this.breakerTrips,
      BREAKER_COOLDOWN_MAX_MS,
    );
    const jitter = 1 + (Math.random() * 2 - 1) * BREAKER_JITTER_FRACTION;
    this.breakerOpenUntil = Date.now() + base * jitter;
    this.breakerTrips += 1;
    this.timeoutStreak = 0;
    logger.warn(
      `The utility model timed out ${BREAKER_THRESHOLD} times in a row: evaluations are skipped for the next ${Math.round((this.breakerOpenUntil - Date.now()) / 1000)} seconds`,
    );
  }

  private recordEvaluationTimeout(): void {
    try {
      if (!this.evaluationTimeoutCounter) {
        this.evaluationTimeoutCounter =
          OTelMeter().createCounter("evaluation.timeouts");
      }
      this.evaluationTimeoutCounter.add(1);
    } catch {
      // OpenTelemetry not initialized (e.g. in tests): the metrics stay
      // disabled and the evaluations keep working.
    }
  }

  private cacheEvaluation(
    taskId: string,
    dateUpdated: string,
    evaluation: TaskEvaluation,
  ): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) {
        this.cache.delete(oldest.value);
      }
    }
    this.cache.set(taskId, { dateUpdated, evaluation, cachedAt: Date.now() });
  }

  private logFailure(taskId: string, version: string): void {
    if (this.failureLogged.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.failureLogged.keys().next();
      if (!oldest.done) {
        this.failureLogged.delete(oldest.value);
      }
    }
    this.failureLogged.set(taskId, { version, loggedAt: Date.now() });
  }

  // Drops the expired entries of both caches (called once per batch).
  private pruneCaches(now: number): void {
    for (const [taskId, entry] of this.cache) {
      if (now - entry.cachedAt > CACHE_TTL_MS) {
        this.cache.delete(taskId);
      }
    }
    for (const [taskId, entry] of this.failureLogged) {
      if (now - entry.loggedAt > CACHE_TTL_MS) {
        this.failureLogged.delete(taskId);
      }
    }
  }
}

export function fallbackEvaluation(): TaskEvaluation {
  return { weight: DEFAULT_TASK_WEIGHT, conflicts: [], kind: FALLBACK_KIND };
}

/**
 * Parses a utility-model reply: a single JSON object
 * {"weight": <0.25|0.5|0.75|1>, "conflicts": ["repo:owner/name", ...],
 * "kind": "<code-heavy|code-light|non-code>"} tolerated inside code fences
 * or prose. The weight is clamped to the bounded scale, the conflict keys
 * are normalized to 'repo:owner/name' (anything else is dropped) and an
 * unknown kind falls back to 'code-heavy'. Returns null when the reply
 * carries no usable weight (the caller falls back).
 */
export function parseEvaluation(reply: string): TaskEvaluation | null {
  const parsed = extractJsonObject(reply);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.weight !== "number" ||
    !Number.isFinite(record.weight)
  ) {
    return null;
  }
  const conflicts = Array.isArray(record.conflicts)
    ? [
        ...new Set(
          record.conflicts
            .filter((key): key is string => typeof key === "string")
            .map(normalizeRepoConflictKey)
            .filter((key): key is string => key !== null),
        ),
      ]
    : [];
  const kind =
    typeof record.kind === "string" && EVALUATION_KINDS.includes(record.kind)
      ? record.kind
      : FALLBACK_KIND;
  return { weight: clampWeight(record.weight), conflicts, kind };
}

// Extracts the first balanced '{...}' block of the reply (string-aware, so
// braces inside JSON strings are handled) and parses it as JSON.
function extractJsonObject(reply: string): unknown {
  const start = reply.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < reply.length; index++) {
    const char = reply[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(reply.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function buildEvaluationPrompt(
  task: PlannerTask,
  projectName: string,
): string {
  const comments = task.comments
    .slice(-MAX_LATEST_COMMENTS)
    .map((comment) => `- ${trimText(comment.text, MAX_COMMENT_CHARS)}`);
  return [
    "You are the scheduling assistant of a task-processing agent. Analyze the task below and estimate its scheduling weight and the repositories it will work on.",
    "",
    'Reply with a single JSON object and nothing else: {"weight": <number>, "conflicts": [<strings>], "kind": "<string>"}',
    "",
    '- "weight": how much of one parallel execution slot the task needs. Use one of: 0.25 (tiny task: quick question, one-line fix), 0.5 (small task), 0.75 (substantial task), 1 (large task: full feature, long investigation, work across several areas).',
    '- "conflicts": the main repositories the task will read or modify, as lowercase "repo:owner/name" entries (e.g. "repo:acme/web"). Two tasks listing the same repository are never run in parallel. Use an empty list when no specific repository is involved.',
    '- "kind": "code-heavy" (mostly code work), "code-light" (light code or review work) or "non-code" (documentation, questions, planning).',
    "",
    `Task title: ${task.title}`,
    `Project: ${projectName.trim().length > 0 ? projectName.trim() : "(unknown)"}`,
    "",
    "Task description:",
    trimText(task.description, MAX_DESCRIPTION_CHARS) || "(empty)",
    "",
    "Latest comments:",
    comments.length > 0 ? comments.join("\n") : "(none)",
  ].join("\n");
}

function trimText(text: string, maxLength: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength
    ? `${trimmed.slice(0, maxLength)}...`
    : trimmed;
}
