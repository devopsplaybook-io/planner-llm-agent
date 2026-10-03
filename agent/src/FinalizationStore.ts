// Backoff of a failed finalization: the first retry comes after the base
// delay, then doubles up to the maximum. The retries are also bounded by
// the polling interval, which is usually larger than the base delay.
export const FINALIZATION_RETRY_BASE_MS = 2000;
export const FINALIZATION_RETRY_MAX_MS = 600000;
// After this many failed finalization attempts the entry is dropped: the
// task stays in its start status on Planner and needs a human look (the
// alternative would be retrying forever on a permanently failing Planner
// call, e.g. a comment rejected for its size).
export const FINALIZATION_MAX_ATTEMPTS = 10;

export interface PendingFinalization {
  taskId: string;
  title: string;
  // Comment to post on the task: the summary of a successful CLI run, or
  // the failure explanation.
  summary: string;
  endStatus: string;
  // Failed finalization attempts so far (the first attempt happens right
  // after the CLI run, without backoff).
  attempt: number;
  nextAttemptAt: number;
  // Set when the attempts ran out: the entry stays in the ledger (the task
  // is never re-executed) but is no longer retried; it needs a human look.
  surrendered: boolean;
}

/**
 * Ledger of the tasks whose CLI work is done and whose Planner
 * finalization (result comment + status change) is still pending. Its
 * purpose is idempotency: once a task is recorded here it must never be
 * re-executed by a later poll — only the finalization is retried, with an
 * exponential backoff, until it succeeds or the bounded attempts run out.
 *
 * In-memory only: one agent process per agent identity is assumed, and the
 * entries die with the process (a restart loses the ledger; the planner
 * server does not expose a usable marker for the start comment because
 * posting a comment bumps the task dateUpdated itself).
 */
export class FinalizationStore {
  private pending = new Map<string, PendingFinalization>();

  public markProcessed(
    taskId: string,
    title: string,
    summary: string,
    endStatus: string,
    now: number = Date.now(),
  ): void {
    // Re-recording a pending task keeps its backoff state (the CLI work is
    // never re-executed while an entry exists, so this only happens on
    // exotic restarts-within-one-process scenarios).
    const existing = this.pending.get(taskId);
    this.pending.set(taskId, {
      taskId: taskId,
      title: title,
      summary: summary,
      endStatus: endStatus,
      attempt: existing?.attempt ?? 0,
      nextAttemptAt: existing?.nextAttemptAt ?? now,
      surrendered: existing?.surrendered ?? false,
    });
  }

  public isProcessed(taskId: string): boolean {
    return this.pending.has(taskId);
  }

  // True while at least one finalization still awaits a retry: the polling
  // must stay at the base interval so idle backoff cannot delay the
  // retries.
  public hasPending(): boolean {
    for (const entry of this.pending.values()) {
      if (!entry.surrendered) {
        return true;
      }
    }
    return false;
  }

  // Entries whose next finalization attempt is due.
  public ready(now: number = Date.now()): PendingFinalization[] {
    return [...this.pending.values()].filter(
      (entry) => !entry.surrendered && entry.nextAttemptAt <= now,
    );
  }

  public markFinalized(taskId: string): void {
    this.pending.delete(taskId);
  }

  // Records a failed finalization attempt and schedules the retry with an
  // exponential backoff. Returns false while the entry stays scheduled for
  // a retry, true when the attempts ran out and the entry was surrendered
  // (it stays in the ledger so the task is never re-executed).
  public recordFailure(taskId: string, now: number = Date.now()): boolean {
    const entry = this.pending.get(taskId);
    if (!entry) {
      return true;
    }
    entry.attempt += 1;
    if (entry.attempt >= FINALIZATION_MAX_ATTEMPTS) {
      entry.surrendered = true;
      return true;
    }
    const backoff = Math.min(
      FINALIZATION_RETRY_BASE_MS * 2 ** (entry.attempt - 1),
      FINALIZATION_RETRY_MAX_MS,
    );
    entry.nextAttemptAt = now + backoff;
    return false;
  }
}
