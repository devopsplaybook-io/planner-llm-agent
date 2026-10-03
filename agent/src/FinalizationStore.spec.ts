import {
  FINALIZATION_MAX_ATTEMPTS,
  FINALIZATION_RETRY_BASE_MS,
  FINALIZATION_RETRY_MAX_MS,
  FinalizationStore,
} from "./FinalizationStore";

describe("FinalizationStore", () => {
  const NOW = 1_000_000;

  const record = (
    store: FinalizationStore,
    taskId = "task-1",
  ): void => {
    store.markProcessed(taskId, "Task 1", "summary", "Done", NOW);
  };

  it("reports a recorded task as processed and ready immediately", () => {
    const store = new FinalizationStore();
    record(store);

    expect(store.isProcessed("task-1")).toBe(true);
    expect(store.ready(NOW)).toEqual([
      {
        taskId: "task-1",
        title: "Task 1",
        summary: "summary",
        endStatus: "Done",
        attempt: 0,
        nextAttemptAt: NOW,
        surrendered: false,
      },
    ]);
  });

  it("stops reporting a task as processed once it is finalized", () => {
    const store = new FinalizationStore();
    record(store);
    store.markFinalized("task-1");

    expect(store.isProcessed("task-1")).toBe(false);
    expect(store.ready(NOW)).toEqual([]);
  });

  it("keeps the backoff state when a task is recorded again", () => {
    const store = new FinalizationStore();
    record(store);
    store.recordFailure("task-1", NOW);
    record(store, "task-1");

    const pending = store.ready(NOW);
    expect(pending).toEqual([]);
    expect(store.ready(NOW + FINALIZATION_RETRY_BASE_MS)).toHaveLength(1);
  });

  it("schedules retries with an exponential backoff capped at the maximum", () => {
    const store = new FinalizationStore();
    record(store);

    expect(store.recordFailure("task-1", NOW)).toBe(false);
    expect(store.ready(NOW + FINALIZATION_RETRY_BASE_MS - 1)).toEqual([]);
    expect(store.ready(NOW + FINALIZATION_RETRY_BASE_MS)).toHaveLength(1);

    expect(store.recordFailure("task-1", NOW)).toBe(false);
    expect(store.ready(NOW + FINALIZATION_RETRY_BASE_MS * 2)).toHaveLength(1);
    expect(store.ready(NOW + FINALIZATION_RETRY_BASE_MS * 2 - 1)).toEqual([]);

    expect(store.recordFailure("task-1", NOW)).toBe(false);
    expect(store.ready(NOW + FINALIZATION_RETRY_BASE_MS * 4)).toHaveLength(1);

    for (let i = 0; i < 20; i += 1) {
      if (store.recordFailure("task-1", NOW)) {
        break;
      }
    }
    const pending = store.ready(NOW + FINALIZATION_RETRY_MAX_MS);
    expect(pending).toEqual([]);
  });

  it("surrenders after the maximum attempts without dropping the task", () => {
    const store = new FinalizationStore();
    record(store);

    let surrendered = false;
    for (let attempt = 0; attempt < FINALIZATION_MAX_ATTEMPTS; attempt += 1) {
      surrendered = store.recordFailure("task-1", NOW);
    }
    expect(surrendered).toBe(true);
    // A surrendered task is never retried, but it is still reported as
    // processed so a later poll can never re-execute it.
    expect(store.ready(NOW + FINALIZATION_RETRY_MAX_MS * 100)).toEqual([]);
    expect(store.isProcessed("task-1")).toBe(true);
  });

  it("reports a failure of an unknown task as surrendered", () => {
    const store = new FinalizationStore();
    expect(store.recordFailure("task-unknown", NOW)).toBe(true);
  });

  it("tracks task ids independently", () => {
    const store = new FinalizationStore();
    record(store, "task-1");
    record(store, "task-2");
    store.markFinalized("task-1");
    store.recordFailure("task-2", NOW);

    expect(store.isProcessed("task-1")).toBe(false);
    expect(store.isProcessed("task-2")).toBe(true);
    expect(store.ready(NOW)).toEqual([]);
    expect(store.ready(NOW + FINALIZATION_RETRY_BASE_MS)).toHaveLength(1);
  });
});
