import type { StandardMeter } from "@devopsplaybook.io/otel-utils";
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

// The utility model is a fast/cheap model: a hung or slow CLI call must not
// stall the scheduling round, so every evaluation and every scheduling
// round is bounded by AGENT_EVALUATION_TIMEOUT (seconds). When the round
// bound is hit, the round proceeds with the evaluations available so far
// while the still-running ones keep feeding the cache in the background.
const DEFAULT_EVALUATION_TIMEOUT_SECONDS = 30;
// At most this many utility-model calls run at the same time.
const EVALUATION_CONCURRENCY = 3;
// Circuit breaker: after this many consecutive timed-out evaluations the
// utility model is clearly unavailable and is skipped for a cooldown.
const EVALUATION_TIMEOUT_CIRCUIT_THRESHOLD = 3;
const EVALUATION_CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;
// Bound of the evaluator caches: entries older than the TTL or beyond the
// capacity (LRU) are dropped, so a long-lived process cannot grow them
// without limit.
const CACHE_CAPACITY = 500;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// The evaluation prompt stays small (~1-2k tokens): title, trimmed
// description and the latest comments are enough for a size estimate.
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_LATEST_COMMENTS = 5;
const MAX_COMMENT_CHARS = 500;

const EVALUATION_KINDS = ["code-heavy", "code-light", "non-code"];
const FALLBACK_KIND = "code-heavy";

export interface EvaluationInput {
  task: PlannerTask;
  projectName: string;
}

export interface TaskEvaluatorOptions {
  timeoutMs?: number;
  concurrency?: number;
  cacheCapacity?: number;
  cacheTtlMs?: number;
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
  // (dateUpdated): the steady-state cost of the utility model is zero.
  // Bounded (TTL + LRU) so a long-lived process cannot grow it without
  // limit.
  private cache: BoundedCache<{ dateUpdated: string; evaluation: TaskEvaluation }>;
  // Content version whose evaluation failure was already logged (log once,
  // not per poll), bounded like the evaluation cache.
  private failureLogged: BoundedCache<string>;
  // Consecutive timed-out evaluations and the instant until which the
  // utility model is skipped (circuit breaker, see the constants above).
  private consecutiveTimeouts = 0;
  private circuitOpenUntil = 0;
  // Counter of the utility-model evaluations by outcome (success, timeout,
  // failure): null when OpenTelemetry is not initialized (e.g. in tests).
  private evaluationCounter: ReturnType<
    StandardMeter["createCounter"]
  > | null = null;
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
      options?.timeoutMs ?? this.configuredTimeoutMs();
    this.concurrency = Math.max(1, options?.concurrency ?? EVALUATION_CONCURRENCY);
    this.cache = new BoundedCache(
      Math.max(1, options?.cacheCapacity ?? CACHE_CAPACITY),
      Math.max(1, options?.cacheTtlMs ?? CACHE_TTL_MS),
    );
    this.failureLogged = new BoundedCache(
      Math.max(1, options?.cacheCapacity ?? CACHE_CAPACITY),
      Math.max(1, options?.cacheTtlMs ?? CACHE_TTL_MS),
    );
    try {
      this.evaluationCounter = OTelMeter().createCounter("evaluations");
    } catch {
      // OpenTelemetry not initialized (e.g. in tests): the metric stays
      // disabled and the evaluation keeps working.
    }
  }

  // The configured evaluation bound in milliseconds; a hot-reloaded
  // invalid value falls back to the default instead of arming an
  // immediate (NaN) or unbounded timer.
  private configuredTimeoutMs(): number {
    const seconds = this.config.AGENT_EVALUATION_TIMEOUT;
    return (Number.isFinite(seconds) && seconds > 0
      ? seconds
      : DEFAULT_EVALUATION_TIMEOUT_SECONDS) * 1000;
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
   *
   * The round is bounded by the evaluation timeout: the evaluations still
   * running when the bound is hit keep running in the background and feed
   * the later rounds through the cache, while the returned map carries the
   * fallback evaluation for the tasks the round could not evaluate in
   * time.
   */
  public async evaluateAll(
    inputs: EvaluationInput[],
    options?: EvaluateAllOptions,
  ): Promise<Map<string, TaskEvaluation>> {
    const evaluations = new Map<string, TaskEvaluation>();
    if (!this.isEnabled() || inputs.length === 0) {
      return evaluations;
    }
    const concurrencyLimit = this.evaluationLimit(options?.maxConcurrent);
    // Circuit breaker: while it is open the utility model is not called at
    // all; the cached evaluations still apply.
    if (Date.now() < this.circuitOpenUntil) {
      for (const input of inputs) {
        evaluations.set(
          input.task.id,
          this.cachedEvaluation(input.task) ?? fallbackEvaluation(),
        );
      }
      return evaluations;
    }
    let roundTimeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all(
          inputs.map(async (input) => {
            evaluations.set(
              input.task.id,
              await this.evaluateTask(
                input.task,
                input.projectName,
                concurrencyLimit,
              ),
            );
          }),
        ),
        new Promise<void>((resolve) => {
          roundTimeout = setTimeout(resolve, this.timeoutMs);
        }),
      ]);
    } finally {
      if (roundTimeout) {
        clearTimeout(roundTimeout);
      }
    }
    // The tasks the round could not evaluate in time fall back for this
    // round; their in-flight evaluation lands in the cache for the next
    // one.
    for (const input of inputs) {
      if (!evaluations.has(input.task.id)) {
        evaluations.set(input.task.id, fallbackEvaluation());
      }
    }
    // A snapshot: the background evaluations keep writing their results
    // into the internal map and the cache, not into the caller's map.
    return new Map(evaluations);
  }

  public async evaluateTask(
    task: PlannerTask,
    projectName: string,
    concurrencyLimit?: number,
  ): Promise<TaskEvaluation> {
    const cached = this.cachedEvaluation(task);
    if (cached !== null) {
      return cached;
    }
    await this.acquire(this.evaluationLimit(concurrencyLimit));
    try {
      // Re-check the cache once the slot is granted: another evaluation of
      // the same content version may have completed in the meantime.
      const cachedInSlot = this.cachedEvaluation(task);
      if (cachedInSlot !== null) {
        return cachedInSlot;
      }
      const evaluation = await this.callUtilityModel(task, projectName);
      // The fallback is cached too: a failing or slow utility model is not
      // retried for the same content version on every poll.
      this.cache.set(task.id, { dateUpdated: task.dateUpdated, evaluation });
      return evaluation;
    } finally {
      this.release();
    }
  }

  // The evaluation cached for the exact content version of the task, or
  // null when none is (or the cache entry expired).
  private cachedEvaluation(task: PlannerTask): TaskEvaluation | null {
    const cached = this.cache.get(task.id);
    if (cached && cached.dateUpdated === task.dateUpdated) {
      return cached.evaluation;
    }
    return null;
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
      this.onEvaluationSuccess();
      return evaluation;
    } catch (error) {
      this.onEvaluationFailure(timedOut);
      if (this.failureLogged.get(task.id) !== task.dateUpdated) {
        this.failureLogged.set(task.id, task.dateUpdated);
        logger.error(
          `Utility-model evaluation failed for task '${task.title}' (${task.id}); falling back to the default weight and the deterministic conflict keys: ${(error as Error).message}`,
        );
      }
      return fallbackEvaluation();
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private onEvaluationSuccess(): void {
    this.consecutiveTimeouts = 0;
    this.recordEvaluationMetric("success");
  }

  private onEvaluationFailure(timedOut: boolean): void {
    this.recordEvaluationMetric(timedOut ? "timeout" : "failure");
    if (!timedOut) {
      return;
    }
    this.consecutiveTimeouts++;
    if (this.consecutiveTimeouts >= EVALUATION_TIMEOUT_CIRCUIT_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + EVALUATION_CIRCUIT_COOLDOWN_MS;
      this.consecutiveTimeouts = 0;
      logger.warn(
        `Utility-model evaluations timed out ${EVALUATION_TIMEOUT_CIRCUIT_THRESHOLD} times in a row: the utility model is skipped until ${new Date(this.circuitOpenUntil).toISOString()}`,
      );
    }
  }

  private recordEvaluationMetric(
    result: "success" | "timeout" | "failure",
  ): void {
    try {
      this.evaluationCounter?.add(1, { result });
    } catch {
      // The metrics never break the evaluation.
    }
  }
}

// A bounded Map with a TTL and LRU eviction: reads past the TTL miss,
// reads refresh the recency order and writes evict the oldest entry beyond
// the capacity. Keeps the evaluator caches of a long-lived process bounded.
class BoundedCache<V> {
  private readonly entries = new Map<string, { value: V; cachedAt: number }>();

  constructor(
    private readonly capacity: number,
    private readonly ttlMs: number,
  ) {}

  public get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  public set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, cachedAt: Date.now() });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }

  public get size(): number {
    return this.entries.size;
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
