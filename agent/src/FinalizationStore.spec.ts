import { FinalizationStore } from "./FinalizationStore";

const recordFields = (title = "Task 1") => ({
  title,
  contentVersion: "2026-09-10T00:00:00.000Z",
  summary: "All done",
  statusEnd: "Done",
});

describe("FinalizationStore", () => {
  it("records, reads and deletes a pending finalization", () => {
    const store = new FinalizationStore();
    expect(store.has("task-1")).toBe(false);

    const record = store.record("task-1", recordFields(), 1000);
    expect(record.taskId).toBe("task-1");
    expect(store.has("task-1")).toBe(true);
    expect(store.get("task-1")).toEqual({
      taskId: "task-1",
      title: "Task 1",
      contentVersion: "2026-09-10T00:00:00.000Z",
      summary: "All done",
      statusEnd: "Done",
      commentPosted: false,
      attempts: 0,
      nextRetryAt: 1000,
      createdAt: 1000,
    });

    store.delete("task-1");
    expect(store.has("task-1")).toBe(false);
    expect(store.size).toBe(0);
  });

  it("tracks the comment-posted state of a record", () => {
    const store = new FinalizationStore();
    store.record("task-1", recordFields(), 1000);
    expect(store.get("task-1")?.commentPosted).toBe(false);

    store.markCommentPosted("task-1");
    expect(store.get("task-1")?.commentPosted).toBe(true);

    // A missing record is silently ignored.
    expect(() => store.markCommentPosted("task-2")).not.toThrow();
  });

  it("schedules retries with an exponential backoff capped at the maximum", () => {
    const store = new FinalizationStore();
    store.record("task-1", recordFields(), 1000);

    store.scheduleRetry("task-1", 2000);
    expect(store.get("task-1")?.attempts).toBe(1);
    // Default base delay: 30s.
    expect(store.get("task-1")?.nextRetryAt).toBe(32_000);

    store.scheduleRetry("task-1", 32_000);
    expect(store.get("task-1")?.attempts).toBe(2);
    expect(store.get("task-1")?.nextRetryAt).toBe(92_000);

    // From the 6th attempt on the delay is capped at 10 minutes.
    store.scheduleRetry("task-1", 92_000);
    store.scheduleRetry("task-1", 152_000);
    store.scheduleRetry("task-1", 212_000);
    store.scheduleRetry("task-1", 272_000);
    expect(store.get("task-1")?.attempts).toBe(6);
    expect(store.get("task-1")?.nextRetryAt).toBe(872_000);
    store.scheduleRetry("task-1", 872_000);
    expect(store.get("task-1")?.nextRetryAt).toBe(1_472_000);

    // Scheduling a retry for an unknown record is a no-op.
    expect(() => store.scheduleRetry("task-2")).not.toThrow();
  });

  it("honors the injected retry timing overrides", () => {
    const store = new FinalizationStore({ retryBaseMs: 10, retryMaxMs: 25 });
    store.record("task-1", recordFields(), 0);

    store.scheduleRetry("task-1", 0);
    expect(store.get("task-1")?.nextRetryAt).toBe(10);

    store.scheduleRetry("task-1", 10);
    expect(store.get("task-1")?.nextRetryAt).toBe(30);

    store.scheduleRetry("task-1", 30);
    expect(store.get("task-1")?.nextRetryAt).toBe(55);
  });

  it("returns the due record ids", () => {
    const store = new FinalizationStore({ retryBaseMs: 10 });
    store.record("task-1", recordFields("Task 1"), 1000);
    store.record("task-2", recordFields("Task 2"), 1000);

    // A record is immediately due after creation (first attempt without
    // delay) and again after its scheduled retry time.
    expect(store.dueTaskIds(1000)).toEqual(["task-1", "task-2"]);

    store.scheduleRetry("task-1", 1000);
    expect(store.dueTaskIds(1005)).toEqual(["task-2"]);
    expect(store.dueTaskIds(1010)).toEqual(["task-1", "task-2"]);
  });

  it("prunes the records of tasks that are no longer assigned", () => {
    const store = new FinalizationStore();
    store.record("task-1", recordFields(), 1000);
    store.record("task-2", recordFields(), 1000);

    const pruned = store.prune(new Set(["task-2"]), 1001);
    expect(pruned).toBe(1);
    expect(store.has("task-1")).toBe(false);
    expect(store.has("task-2")).toBe(true);
  });

  it("prunes the records past the TTL safety net", () => {
    const store = new FinalizationStore({ ttlMs: 100 });
    store.record("task-1", recordFields(), 1000);

    expect(store.prune(new Set(["task-1"]), 1050)).toBe(0);
    expect(store.has("task-1")).toBe(true);

    expect(store.prune(new Set(["task-1"]), 1101)).toBe(1);
    expect(store.has("task-1")).toBe(false);
  });
});
