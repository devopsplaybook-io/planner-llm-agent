import * as fse from "fs-extra";
import * as path from "path";
import { writeJsonAtomic } from "./AtomicFile";

// Registry of the tasks whose CLI execution succeeded but whose Planner
// finalization (summary comment, end status, folder cleanup) did not.
// While a record exists the task is never picked again: re-running the CLI
// would redo completed work; only the finalization steps are retried, with
// an exponential backoff. The statusEnd field selects the variant: a status
// pipeline finalization moves the task and cleans the folder, the
// comment-only finalization of a comments action (statusEnd null) only posts
// the summary. When a directory is configured the records are persisted
// there (one JSON file per task, written atomically) and reloaded at
// startup, so a crash or rolling restart between the CLI completion and the
// Planner updates resumes the delivery instead of re-running the CLI. One
// agent process per agent identity is assumed.
export interface FinalizationRecord {
  taskId: string;
  title: string;
  // Task content version (dateUpdated) observed when the record was created.
  contentVersion: string;
  // Summary comment to post when the comment POST has not succeeded yet.
  summary: string;
  // End status to move the task to (snapshotted from the action); null in
  // the comments mode, where the finalization is comment-only (no status
  // move, no folder cleanup) and the retry then only re-posts the comment.
  statusEnd: string | null;
  // Resolved abort status of the action (snapshotted at pick time); null
  // when the action has none. A task found in this status during
  // finalization keeps the user-set status (the end status is not applied).
  statusAbort: string | null;
  // True once the summary comment POST succeeded: the retry then only
  // updates the status, so the comment is never posted twice.
  commentPosted: boolean;
  attempts: number;
  // Epoch ms when the next retry may run.
  nextRetryAt: number;
  // Epoch ms of the record creation (TTL safety net).
  createdAt: number;
  // Epoch ms of the task run start: an identical summary comment older than
  // this (minus a clock-skew tolerance) belongs to a previous run and never
  // proves that the current summary was already posted.
  runStartedAt: number;
  // True when the record was reloaded from disk at startup: the delivery is
  // then resumed (and the duplicate-summary check is always armed). Runtime
  // only, never serialized.
  resumed: boolean;
}

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 600_000;
const RECORD_TTL_MS = 24 * 60 * 60 * 1000;

// Same canonical id rule as isCanonicalTaskId in Agent.ts, duplicated here
// to avoid an import cycle: only such ids are read from or written to disk.
const CANONICAL_TASK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECORD_FILE_SUFFIX = ".json";
const TEMP_FILE_SUFFIX = ".tmp";

// Timing overrides (tests inject short delays) and the persistence directory
// (absent = in-memory, which keeps unit tests fast).
export interface FinalizationStoreOptions {
  retryBaseMs?: number;
  retryMaxMs?: number;
  ttlMs?: number;
  dir?: string;
}

export class FinalizationStore {
  private records = new Map<string, FinalizationRecord>();
  private retryBaseMs: number;
  private retryMaxMs: number;
  private ttlMs: number;
  private dir: string | null;

  constructor(options?: FinalizationStoreOptions) {
    this.retryBaseMs = options?.retryBaseMs ?? RETRY_BASE_MS;
    this.retryMaxMs = options?.retryMaxMs ?? RETRY_MAX_MS;
    this.ttlMs = options?.ttlMs ?? RECORD_TTL_MS;
    this.dir = options?.dir ?? null;
  }

  public has(taskId: string): boolean {
    return this.records.has(taskId);
  }

  public get(taskId: string): FinalizationRecord | undefined {
    return this.records.get(taskId);
  }

  // Registers (or replaces) the pending finalization of a completed task.
  // The record is kept in memory even when the write fails, and the error is
  // rethrown: the caller then retries the finalization instead of re-running
  // the CLI (re-running would redo completed work).
  public async record(
    taskId: string,
    fields: {
      title: string;
      contentVersion: string;
      summary: string;
      statusEnd: string | null;
      statusAbort?: string;
      runStartedAt: number;
    },
    now: number = Date.now(),
  ): Promise<FinalizationRecord> {
    const newRecord: FinalizationRecord = {
      taskId,
      title: fields.title,
      contentVersion: fields.contentVersion,
      summary: fields.summary,
      statusEnd: fields.statusEnd,
      statusAbort: fields.statusAbort ?? null,
      commentPosted: false,
      attempts: 0,
      nextRetryAt: now,
      createdAt: now,
      runStartedAt: fields.runStartedAt,
      resumed: false,
    };
    this.records.set(taskId, newRecord);
    await this.persist(newRecord);
    return newRecord;
  }

  // Marks the summary comment as posted. The persistence failure is
  // propagated: the retry then checks Planner for an already posted summary
  // before posting again, so a lost flag can never duplicate the comment.
  public async markCommentPosted(taskId: string): Promise<void> {
    const record = this.records.get(taskId);
    if (!record) {
      return;
    }
    record.commentPosted = true;
    await this.persist(record);
  }

  // Schedules the next retry with an exponential backoff (30s base by
  // default, doubled per attempt, capped at 10 minutes) after a failed
  // finalization attempt. The write is best-effort: every delivery step is
  // idempotent and load() resets the retry time anyway.
  public async scheduleRetry(
    taskId: string,
    now: number = Date.now(),
  ): Promise<void> {
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
    await this.persist(record).catch(() => undefined);
  }

  // Ids of the records whose retry is due (in registration order).
  public dueTaskIds(now: number = Date.now()): string[] {
    return [...this.records.values()]
      .filter((record) => record.nextRetryAt <= now)
      .map((record) => record.taskId);
  }

  public async delete(taskId: string): Promise<void> {
    this.records.delete(taskId);
    await this.removeFile(taskId);
  }

  // Drops the records of the tasks that are no longer assigned (the agent
  // could not finalize them anymore) and the ones past the TTL safety net.
  // Returns the number of pruned records. The file removals are best-effort.
  public async prune(
    assignedTaskIds: Set<string>,
    now: number = Date.now(),
  ): Promise<number> {
    const removed: string[] = [];
    for (const [taskId, record] of this.records) {
      if (!assignedTaskIds.has(taskId) || now - record.createdAt > this.ttlMs) {
        this.records.delete(taskId);
        removed.push(taskId);
      }
    }
    await Promise.all(removed.map((taskId) => this.removeFile(taskId)));
    return removed.length;
  }

  // Reloads the persisted records at startup. The records are made due
  // immediately (a restart must deliver them right away) and flagged as
  // resumed so the duplicate-summary check is armed. Invalid or unreadable
  // files are removed and reported.
  public async load(): Promise<{ loaded: number; skipped: string[] }> {
    if (this.dir === null) {
      return { loaded: 0, skipped: [] };
    }
    await fse.ensureDir(this.dir);
    const entries = await fse.readdir(this.dir);
    const skipped: string[] = [];
    for (const entry of entries) {
      const filePath = path.join(this.dir, entry);
      if (entry.endsWith(TEMP_FILE_SUFFIX)) {
        await fse.remove(filePath).catch(() => undefined);
        continue;
      }
      if (!entry.endsWith(RECORD_FILE_SUFFIX)) {
        continue;
      }
      const taskId = entry.slice(0, -RECORD_FILE_SUFFIX.length);
      if (!CANONICAL_TASK_ID_PATTERN.test(taskId)) {
        continue;
      }
      let record: FinalizationRecord | null = null;
      try {
        record = parseFinalizationRecord(await fse.readJson(filePath), taskId);
      } catch {
        record = null;
      }
      if (record === null) {
        await fse.remove(filePath).catch(() => undefined);
        skipped.push(entry);
        continue;
      }
      record.resumed = true;
      record.nextRetryAt = Date.now();
      this.records.set(record.taskId, record);
    }
    return { loaded: this.records.size, skipped };
  }

  public get size(): number {
    return this.records.size;
  }

  private filePath(taskId: string): string {
    return path.join(this.dir as string, `${taskId}${RECORD_FILE_SUFFIX}`);
  }

  private async persist(record: FinalizationRecord): Promise<void> {
    if (this.dir === null) {
      return;
    }
    // 'resumed' is runtime-only: it is never written to disk.
    const { resumed: _resumed, ...persisted } = record;
    await writeJsonAtomic(this.filePath(record.taskId), persisted);
  }

  private async removeFile(taskId: string): Promise<void> {
    if (this.dir === null) {
      return;
    }
    await fse.remove(this.filePath(taskId)).catch(() => undefined);
  }
}

// Validates a persisted record against its file name; returns null when the
// shape is invalid (the caller drops the file).
function parseFinalizationRecord(
  raw: unknown,
  fileTaskId: string,
): FinalizationRecord | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  if (value.taskId !== fileTaskId) {
    return null;
  }
  if (typeof value.title !== "string") {
    return null;
  }
  if (typeof value.contentVersion !== "string") {
    return null;
  }
  if (typeof value.summary !== "string") {
    return null;
  }
  if (value.statusEnd !== null && typeof value.statusEnd !== "string") {
    return null;
  }
  if (value.statusAbort !== null && typeof value.statusAbort !== "string") {
    return null;
  }
  if (typeof value.commentPosted !== "boolean") {
    return null;
  }
  if (!Number.isInteger(value.attempts) || (value.attempts as number) < 0) {
    return null;
  }
  if (
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt)
  ) {
    return null;
  }
  const createdAt = value.createdAt;
  const runStartedAt =
    typeof value.runStartedAt === "number" && Number.isFinite(value.runStartedAt)
      ? value.runStartedAt
      : createdAt;
  return {
    taskId: fileTaskId,
    title: value.title,
    contentVersion: value.contentVersion,
    summary: value.summary,
    statusEnd: value.statusEnd as string | null,
    statusAbort: value.statusAbort as string | null,
    commentPosted: value.commentPosted,
    attempts: value.attempts as number,
    nextRetryAt: createdAt,
    createdAt,
    runStartedAt,
    resumed: false,
  };
}
