import * as os from "os";
import * as path from "path";
import * as fse from "fs-extra";
import { FinalizationStore } from "./FinalizationStore";

const TASK_1 = "11111111-1111-4111-8111-111111111111";
const TASK_2 = "22222222-2222-4222-8222-222222222222";

const recordFields = (title = "Task 1") => ({
  title,
  contentVersion: "2026-09-10T00:00:00.000Z",
  summary: "All done",
  statusEnd: "Done",
  statusAbort: "Aborted",
  runStartedAt: 900,
});

describe("FinalizationStore", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = path.join(
      os.tmpdir(),
      `finalization-store-spec-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
  });

  afterEach(() => {
    fse.removeSync(dataDir);
  });

  it("records, reads and deletes a pending finalization", async () => {
    const store = new FinalizationStore();
    expect(store.has("task-1")).toBe(false);

    const record = await store.record("task-1", recordFields(), 1000);
    expect(record.taskId).toBe("task-1");
    expect(store.has("task-1")).toBe(true);
    expect(store.get("task-1")).toEqual({
      taskId: "task-1",
      title: "Task 1",
      contentVersion: "2026-09-10T00:00:00.000Z",
      summary: "All done",
      statusEnd: "Done",
      statusAbort: "Aborted",
      commentPosted: false,
      attempts: 0,
      nextRetryAt: 1000,
      createdAt: 1000,
      runStartedAt: 900,
      resumed: false,
    });

    await store.delete("task-1");
    expect(store.has("task-1")).toBe(false);
    expect(store.size).toBe(0);
  });

  it("stores the resolved abort status and defaults it to null", async () => {
    const store = new FinalizationStore();
    await store.record("task-1", recordFields(), 1000);
    expect(store.get("task-1")?.statusAbort).toBe("Aborted");

    // An action without an abort status records null (no abort check).
    await store.record(
      "task-2",
      { ...recordFields("Task 2"), statusAbort: undefined },
      1000,
    );
    expect(store.get("task-2")?.statusAbort).toBeNull();
  });

  it("tracks the comment-posted state of a record", async () => {
    const store = new FinalizationStore();
    await store.record("task-1", recordFields(), 1000);
    expect(store.get("task-1")?.commentPosted).toBe(false);

    await store.markCommentPosted("task-1");
    expect(store.get("task-1")?.commentPosted).toBe(true);

    // A missing record is silently ignored.
    await expect(store.markCommentPosted("task-2")).resolves.toBeUndefined();
  });

  it("schedules retries with an exponential backoff capped at the maximum", async () => {
    const store = new FinalizationStore();
    await store.record("task-1", recordFields(), 1000);

    await store.scheduleRetry("task-1", 2000);
    expect(store.get("task-1")?.attempts).toBe(1);
    // Default base delay: 30s.
    expect(store.get("task-1")?.nextRetryAt).toBe(32_000);

    await store.scheduleRetry("task-1", 32_000);
    expect(store.get("task-1")?.attempts).toBe(2);
    expect(store.get("task-1")?.nextRetryAt).toBe(92_000);

    // From the 6th attempt on the delay is capped at 10 minutes.
    await store.scheduleRetry("task-1", 92_000);
    await store.scheduleRetry("task-1", 152_000);
    await store.scheduleRetry("task-1", 212_000);
    await store.scheduleRetry("task-1", 272_000);
    expect(store.get("task-1")?.attempts).toBe(6);
    expect(store.get("task-1")?.nextRetryAt).toBe(872_000);
    await store.scheduleRetry("task-1", 872_000);
    expect(store.get("task-1")?.nextRetryAt).toBe(1_472_000);

    // Scheduling a retry for an unknown record is a no-op.
    await expect(store.scheduleRetry("task-2")).resolves.toBeUndefined();
  });

  it("honors the injected retry timing overrides", async () => {
    const store = new FinalizationStore({ retryBaseMs: 10, retryMaxMs: 25 });
    await store.record("task-1", recordFields(), 0);

    await store.scheduleRetry("task-1", 0);
    expect(store.get("task-1")?.nextRetryAt).toBe(10);

    await store.scheduleRetry("task-1", 10);
    expect(store.get("task-1")?.nextRetryAt).toBe(30);

    await store.scheduleRetry("task-1", 30);
    expect(store.get("task-1")?.nextRetryAt).toBe(55);
  });

  it("returns the due record ids", async () => {
    const store = new FinalizationStore({ retryBaseMs: 10 });
    await store.record("task-1", recordFields("Task 1"), 1000);
    await store.record("task-2", recordFields("Task 2"), 1000);

    // A record is immediately due after creation (first attempt without
    // delay) and again after its scheduled retry time.
    expect(store.dueTaskIds(1000)).toEqual(["task-1", "task-2"]);

    await store.scheduleRetry("task-1", 1000);
    expect(store.dueTaskIds(1005)).toEqual(["task-2"]);
    expect(store.dueTaskIds(1010)).toEqual(["task-1", "task-2"]);
  });

  it("prunes the records of tasks that are no longer assigned", async () => {
    const store = new FinalizationStore();
    await store.record("task-1", recordFields(), 1000);
    await store.record("task-2", recordFields(), 1000);

    const pruned = await store.prune(new Set(["task-2"]), 1001);
    expect(pruned).toBe(1);
    expect(store.has("task-1")).toBe(false);
    expect(store.has("task-2")).toBe(true);
  });

  it("prunes the records past the TTL safety net", async () => {
    const store = new FinalizationStore({ ttlMs: 100 });
    await store.record("task-1", recordFields(), 1000);

    expect(await store.prune(new Set(["task-1"]), 1050)).toBe(0);
    expect(store.has("task-1")).toBe(true);

    expect(await store.prune(new Set(["task-1"]), 1101)).toBe(1);
    expect(store.has("task-1")).toBe(false);
  });

  it("persists a record to its own file under the configured directory", async () => {
    const store = new FinalizationStore({ dir: dataDir });
    await store.record(TASK_1, recordFields(), 1000);

    const filePath = path.join(dataDir, `${TASK_1}.json`);
    expect(await fse.pathExists(filePath)).toBe(true);
    const persisted = await fse.readJson(filePath);
    expect(persisted).toEqual({
      taskId: TASK_1,
      title: "Task 1",
      contentVersion: "2026-09-10T00:00:00.000Z",
      summary: "All done",
      statusEnd: "Done",
      statusAbort: "Aborted",
      commentPosted: false,
      attempts: 0,
      nextRetryAt: 1000,
      createdAt: 1000,
      runStartedAt: 900,
    });
    // The runtime-only flag is never serialized.
    expect(persisted.resumed).toBeUndefined();
  });

  it("persists the comment-posted flag and the scheduled retry", async () => {
    const store = new FinalizationStore({ dir: dataDir, retryBaseMs: 10 });
    await store.record(TASK_1, recordFields(), 1000);
    await store.markCommentPosted(TASK_1);
    await store.scheduleRetry(TASK_1, 1000);

    const persisted = await fse.readJson(path.join(dataDir, `${TASK_1}.json`));
    expect(persisted.commentPosted).toBe(true);
    expect(persisted.attempts).toBe(1);
    expect(persisted.nextRetryAt).toBe(1010);
  });

  it("reloads the persisted records at startup and makes them due", async () => {
    const first = new FinalizationStore({ dir: dataDir });
    await first.record(TASK_1, recordFields(), 1000);
    await first.markCommentPosted(TASK_1);
    await first.scheduleRetry(TASK_1, 1000);

    const second = new FinalizationStore({ dir: dataDir });
    const result = await second.load();
    expect(result).toEqual({ loaded: 1, skipped: [] });
    const record = second.get(TASK_1)!;
    expect(record.title).toBe("Task 1");
    expect(record.summary).toBe("All done");
    expect(record.contentVersion).toBe("2026-09-10T00:00:00.000Z");
    expect(record.statusEnd).toBe("Done");
    expect(record.statusAbort).toBe("Aborted");
    expect(record.commentPosted).toBe(true);
    // The attempts and the creation/run times are preserved...
    expect(record.attempts).toBe(1);
    expect(record.createdAt).toBe(1000);
    expect(record.runStartedAt).toBe(900);
    // ...while the retry is made due immediately and the record is resumed.
    expect(record.resumed).toBe(true);
    expect(record.nextRetryAt).toBeLessThanOrEqual(Date.now());
    expect(second.dueTaskIds()).toEqual([TASK_1]);
  });

  it("stays in memory when no directory is configured", async () => {
    const store = new FinalizationStore();
    await store.record(TASK_1, recordFields(), 1000);
    expect(await store.load()).toEqual({ loaded: 0, skipped: [] });
    expect(store.has(TASK_1)).toBe(true);
    await expect(store.delete(TASK_1)).resolves.toBeUndefined();
  });

  it("removes the record file on delete and prune", async () => {
    const store = new FinalizationStore({ dir: dataDir });
    await store.record(TASK_1, recordFields("Task 1"), 1000);
    await store.record(TASK_2, recordFields("Task 2"), 1000);

    await store.delete(TASK_1);
    expect(await fse.pathExists(path.join(dataDir, `${TASK_1}.json`))).toBe(
      false,
    );

    await store.prune(new Set(), 1001);
    expect(await fse.pathExists(path.join(dataDir, `${TASK_2}.json`))).toBe(
      false,
    );
    expect(store.size).toBe(0);
  });

  it("skips, reports and removes corrupt, foreign and invalid files", async () => {
    await fse.ensureDir(dataDir);
    // Corrupt JSON.
    await fse.writeFile(path.join(dataDir, `${TASK_1}.json`), "{not json");
    // Missing fields.
    await fse.writeFile(
      path.join(dataDir, `${TASK_2}.json`),
      JSON.stringify({ taskId: TASK_2 }),
    );
    // A leftover temp file is removed silently.
    const tempFile = path.join(dataDir, `${TASK_1}.json.123.tmp`);
    await fse.writeFile(tempFile, "partial");
    // A non-UUID file is ignored (not removed).
    const foreign = path.join(dataDir, "notes.json");
    await fse.writeFile(foreign, "{}");

    const store = new FinalizationStore({ dir: dataDir });
    const result = await store.load();
    expect(result.loaded).toBe(0);
    expect(result.skipped.sort()).toEqual(
      [`${TASK_2}.json`, `${TASK_1}.json`].sort(),
    );
    expect(await fse.pathExists(path.join(dataDir, `${TASK_1}.json`))).toBe(
      false,
    );
    expect(await fse.pathExists(path.join(dataDir, `${TASK_2}.json`))).toBe(
      false,
    );
    expect(await fse.pathExists(tempFile)).toBe(false);
    expect(await fse.pathExists(foreign)).toBe(true);
    expect(store.size).toBe(0);
  });

  it("defaults runStartedAt to createdAt for an older persisted record", async () => {
    await fse.ensureDir(dataDir);
    await fse.writeFile(
      path.join(dataDir, `${TASK_1}.json`),
      JSON.stringify({
        taskId: TASK_1,
        title: "Legacy",
        contentVersion: "v1",
        summary: "Summary",
        statusEnd: null,
        statusAbort: null,
        commentPosted: true,
        attempts: 0,
        nextRetryAt: 1,
        createdAt: 500,
      }),
    );

    const store = new FinalizationStore({ dir: dataDir });
    expect(await store.load()).toEqual({ loaded: 1, skipped: [] });
    expect(store.get(TASK_1)?.runStartedAt).toBe(500);
    expect(store.get(TASK_1)?.statusEnd).toBeNull();
  });
});
