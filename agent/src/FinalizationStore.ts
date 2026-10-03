// In-memory registry of the tasks whose CLI execution succeeded but whose
// Planner finalization (summary comment, end status, folder cleanup) did not.
// While a record exists the task is never picked again: re-running the CLI
// would redo completed work; only the finalization steps are retried, with
// an exponential backoff. One agent process per agent identity is assumed
// (records are lost on restart, like the in-flight registrations).
export interface FinalizationRecord {
  taskId: string;
  title: string;
  // Task content version (dateUpdated) observed when the record was created.
  contentVersion: string;
  // Summary comment to post when the comment POST has not succeeded yet.
  summary: string;
  // End status to move the task to (snapshotted from the action).
  statusEnd: string;
  // True once the summary comment POST succeeded: the retry then only
  // updates the status, so the comment is never posted twice.
  commentPosted: boolean;
  attempts: number;
  // Epoch ms when the next retry may run.
  nextRetryAt: number;
  // Epoch ms of the record creation (TTL safety net).
  createdAt: number;
}

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 600_000;
const RECORD_TTL_MS = 24 * 60 * 60 * 1000;

// Timing overrides (tests inject short delays).
export interface FinalizationStoreOptions {
  retryBaseMs?: number;
  retryMaxMs?: number;
  ttlMs?: number;
}

export class FinalizationStore {
  private records = new Map<string, FinalizationRecord>();
  private retryBaseMs: number;
  private retryMaxMs: number;
  private ttlMs: number;

  constructor(options?: FinalizationStoreOptions) {
    this.retryBaseMs = options?.retryBaseMs ?? RETRY_BASE_MS;
    this.retryMaxMs = options?.retryMaxMs ?? RETRY_MAX_MS;
    this.ttlMs = options?.ttlMs ?? RECORD_TTL_MS;
  }

  public has(taskId: string): boolean {
    return this.records.has(taskId);
  }

  public get(taskId: string): FinalizationRecord | undefined {
    return this.records.get(taskId);
  }

  // Registers (or replaces) the pending finalization of a completed task.
  public record(
    taskId: string,
    fields: {
      title: string;
      contentVersion: string;
      summary: string;
      statusEnd: string;
    },
    now: number = Date.now(),
  ): FinalizationRecord {
    const newRecord: FinalizationRecord = {
      taskId,
      title: fields.title,
      contentVersion: fields.contentVersion,
      summary: fields.summary,
      statusEnd: fields.statusEnd,
      commentPosted: false,
      attempts: 0,
      nextRetryAt: now,
      createdAt: now,
    };
    this.records.set(taskId, newRecord);
    return newRecord;
  }

  public markCommentPosted(taskId: string): void {
    const record = this.records.get(taskId);
    if (record) {
      record.commentPosted = true;
    }
  }

  // Schedules the next retry with an exponential backoff (30s base by
  // default, doubled per attempt, capped at 10 minutes) after a failed
  // finalization attempt.
  public scheduleRetry(taskId: string, now: number = Date.now()): void {
    const record = this.records.get(taskId);
    if (!record) {
      return;
    }
    record.attempts++;
    const delay = Math.min(
      this.retryBaseMs * 2 ** (record.attempts - 1),
      this.retryMaxMs,
    );
    record.nextRetryAt = now + delay;
  }

  // Ids of the records whose retry is due (in registration order).
  public dueTaskIds(now: number = Date.now()): string[] {
    return [...this.records.values()]
      .filter((record) => record.nextRetryAt <= now)
      .map((record) => record.taskId);
  }

  public delete(taskId: string): void {
    this.records.delete(taskId);
  }

  // Drops the records of the tasks that are no longer assigned (the agent
  // could not finalize them anymore) and the ones past the TTL safety net.
  // Returns the number of pruned records.
  public prune(assignedTaskIds: Set<string>, now: number = Date.now()): number {
    let pruned = 0;
    for (const [taskId, record] of this.records) {
      if (!assignedTaskIds.has(taskId) || now - record.createdAt > this.ttlMs) {
        this.records.delete(taskId);
        pruned++;
      }
    }
    return pruned;
  }

  public get size(): number {
    return this.records.size;
  }
}
