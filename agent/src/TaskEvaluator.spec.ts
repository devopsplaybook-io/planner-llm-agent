import { Config } from "./Config";
import type { PlannerTask } from "./PlannerClient";
import type { CliAgentClient, PromptOptions } from "./clients/CliAgent";
import {
  TaskEvaluator,
  buildEvaluationPrompt,
  fallbackEvaluation,
  parseEvaluation,
} from "./TaskEvaluator";

// The OpenTelemetry meter is mocked so the evaluation counter is observable;
// the logger still reaches console.log for the logSpy assertions.
jest.mock("./OTelContext", () => {
  const counters: Record<string, { add: jest.Mock }> = {};
  const logger = {
    info: (...args: unknown[]) => console.log(...args),
    warn: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.log(...args),
  };
  return {
    __counters: counters,
    OTelLogger: () => ({ createModuleLogger: () => logger }),
    OTelMeter: () => ({
      createCounter: (key: string) => {
        counters[key] ??= { add: jest.fn() };
        return counters[key];
      },
    }),
  };
});

const evaluationCounters = (): Record<string, { add: jest.Mock }> =>
  (jest.requireMock("./OTelContext") as {
    __counters: Record<string, { add: jest.Mock }>;
  }).__counters;

const buildTask = (overrides: Partial<PlannerTask> & { id: string }): PlannerTask => ({
  projectId: "p1",
  title: `Task ${overrides.id}`,
  status: "To Do",
  priority: "medium",
  description: "Implement the feature",
  dateUpdated: "2026-09-10T00:00:00.000Z",
  comments: [],
  attachments: [],
  ...overrides,
});

type MockCli = CliAgentClient & {
  runPrompt: jest.Mock;
  checkAuthentication: jest.Mock;
  performTask: jest.Mock;
  listModels: jest.Mock;
  readUsage: jest.Mock;
  usageSummary: jest.Mock;
};

const buildMockCli = (): MockCli =>
  ({
    name: "mock",
    displayName: "Mock",
    authHint: "",
    checkAuthentication: jest.fn(),
    performTask: jest.fn(),
    runPrompt: jest.fn(),
    listModels: jest.fn(),
    readUsage: jest.fn().mockResolvedValue(null),
    usageSummary: jest.fn(),
  }) as unknown as MockCli;

const buildEvaluator = (
  mockCli: CliAgentClient,
  options: {
    model?: string;
    timeoutMs?: number;
    concurrency?: number;
    cacheCapacity?: number;
    cacheTtlMs?: number;
  } = {},
): TaskEvaluator => {
  const config = new Config();
  config.AGENT_UTILITY_MODEL = options.model ?? "qwen3-flash";
  return new TaskEvaluator(config, mockCli, {
    timeoutMs: options.timeoutMs,
    concurrency: options.concurrency,
    cacheCapacity: options.cacheCapacity,
    cacheTtlMs: options.cacheTtlMs,
  });
};

describe("TaskEvaluator", () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(jest.fn());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("utility model disabled", () => {
    it("makes zero LLM calls when AGENT_UTILITY_MODEL is unset", async () => {
      const mockCli = buildMockCli();
      const evaluator = buildEvaluator(mockCli, { model: "" });
      expect(evaluator.isEnabled()).toBe(false);

      const evaluations = await evaluator.evaluateAll([
        { task: buildTask({ id: "t1" }), projectName: "Projects" },
      ]);
      expect(evaluations.size).toBe(0);
      expect(mockCli.runPrompt).not.toHaveBeenCalled();
    });
  });

  describe("reply parsing", () => {
    it("parses a clean JSON reply", () => {
      expect(
        parseEvaluation('{"weight": 0.5, "conflicts": ["repo:acme/web"], "kind": "code-light"}'),
      ).toEqual({ weight: 0.5, conflicts: ["repo:acme/web"], kind: "code-light" });
    });

    it("parses a reply inside code fences or prose", () => {
      expect(
        parseEvaluation('```json\n{"weight": 0.25, "conflicts": [], "kind": "non-code"}\n```'),
      ).toEqual({ weight: 0.25, conflicts: [], kind: "non-code" });
      expect(
        parseEvaluation(
          'Here is my estimate:\n{"weight": 0.75, "conflicts": ["repo:acme/api"], "kind": "code-heavy"}\nHope that helps!',
        ),
      ).toEqual({ weight: 0.75, conflicts: ["repo:acme/api"], kind: "code-heavy" });
    });

    it("clamps an out-of-range weight", () => {
      expect(parseEvaluation('{"weight": 5, "conflicts": [], "kind": "code-heavy"}')?.weight).toBe(1);
      expect(parseEvaluation('{"weight": 0.05, "conflicts": [], "kind": "code-heavy"}')?.weight).toBe(0.25);
    });

    it("falls back when the weight is missing, invalid or the reply has no JSON", () => {
      expect(parseEvaluation('{"conflicts": [], "kind": "code-heavy"}')).toBeNull();
      expect(parseEvaluation('{"weight": "big", "conflicts": [], "kind": "code-heavy"}')).toBeNull();
      expect(parseEvaluation("no JSON at all")).toBeNull();
      expect(parseEvaluation("")).toBeNull();
    });

    it("normalizes the conflict keys and drops the ones without the repo shape", () => {
      expect(
        parseEvaluation(
          '{"weight": 0.5, "conflicts": ["repo:ACME/Web", "acme/api", "just a word", 42], "kind": "code-heavy"}',
        ),
      ).toEqual({
        weight: 0.5,
        conflicts: ["repo:acme/web", "repo:acme/api"],
        kind: "code-heavy",
      });
      expect(parseEvaluation('{"weight": 0.5}')).toEqual({
        weight: 0.5,
        conflicts: [],
        kind: "code-heavy",
      });
    });

    it("falls back to the code-heavy kind when the kind is unknown", () => {
      expect(parseEvaluation('{"weight": 0.5, "conflicts": [], "kind": "unknown"}')?.kind).toBe(
        "code-heavy",
      );
      expect(fallbackEvaluation()).toEqual({
        weight: 1,
        conflicts: [],
        kind: "code-heavy",
      });
    });
  });

  describe("evaluation", () => {
    it("evaluates a task with the utility model and returns the result", async () => {
      const mockCli = buildMockCli();
      mockCli.runPrompt.mockResolvedValue(
        '{"weight": 0.25, "conflicts": ["repo:acme/web"], "kind": "code-light"}',
      );
      const evaluator = buildEvaluator(mockCli);
      const evaluations = await evaluator.evaluateAll([
        { task: buildTask({ id: "t1" }), projectName: "Web" },
      ]);
      expect(evaluations.get("t1")).toEqual({
        weight: 0.25,
        conflicts: ["repo:acme/web"],
        kind: "code-light",
      });
      expect(mockCli.runPrompt).toHaveBeenCalledTimes(1);
      const [prompt, options] = mockCli.runPrompt.mock.calls[0] as [string, PromptOptions];
      expect(prompt).toContain("Task title: Task t1");
      expect(prompt).toContain("Project: Web");
      expect(prompt).toContain("Implement the feature");
      expect(options).toEqual({
        model: "qwen3-flash",
        timeoutMs: 30000,
        purpose: "utility-model evaluation 'Task t1'",
      });
    });

    it("trims the description and the latest comments in the prompt", () => {
      const prompt = buildEvaluationPrompt(
        buildTask({
          id: "t1",
          description: "x".repeat(3000),
          comments: [
            { id: "c1", userId: "u1", text: "oldest comment", dateCreated: "2026-09-01T00:00:00.000Z" },
            { id: "c2", userId: "u1", text: "older comment", dateCreated: "2026-09-02T00:00:00.000Z" },
            { id: "c3", userId: "u1", text: "older still", dateCreated: "2026-09-03T00:00:00.000Z" },
            { id: "c4", userId: "u1", text: "older", dateCreated: "2026-09-04T00:00:00.000Z" },
            { id: "c5", userId: "u1", text: "y".repeat(600), dateCreated: "2026-09-05T00:00:00.000Z" },
            { id: "c6", userId: "u1", text: "newest comment", dateCreated: "2026-09-06T00:00:00.000Z" },
          ],
        }),
        "Web",
      );
      expect(prompt).toContain(`${"x".repeat(2000)}...`);
      expect(prompt).not.toContain("oldest comment");
      expect(prompt).toContain("newest comment");
      expect(prompt).toContain(`${"y".repeat(500)}...`);
      expect(prompt).toContain("Project: Web");
    });

    it("uses (unknown) when the project name is empty", () => {
      const prompt = buildEvaluationPrompt(buildTask({ id: "t1" }), "");
      expect(prompt).toContain("Project: (unknown)");
    });

    it("caches the evaluation per task content version", async () => {
      const mockCli = buildMockCli();
      mockCli.runPrompt.mockResolvedValue('{"weight": 0.5, "conflicts": [], "kind": "code-light"}');
      const evaluator = buildEvaluator(mockCli);
      const task = buildTask({ id: "t1" });

      await evaluator.evaluateTask(task, "Web");
      await evaluator.evaluateTask(task, "Web");
      expect(mockCli.runPrompt).toHaveBeenCalledTimes(1);

      // A task update invalidates the cache.
      await evaluator.evaluateTask(
        { ...task, dateUpdated: "2026-09-11T00:00:00.000Z" },
        "Web",
      );
      expect(mockCli.runPrompt).toHaveBeenCalledTimes(2);
    });

    it("falls back and logs once per content version when the model fails", async () => {
      const mockCli = buildMockCli();
      mockCli.runPrompt.mockRejectedValue(new Error("CLI is down"));
      const evaluator = buildEvaluator(mockCli);
      const task = buildTask({ id: "t1" });

      const evaluation = await evaluator.evaluateTask(task, "Web");
      expect(evaluation).toEqual(fallbackEvaluation());

      // The fallback is cached: no retry for the same content version, and
      // the failure is logged once, not per poll.
      await evaluator.evaluateTask(task, "Web");
      expect(mockCli.runPrompt).toHaveBeenCalledTimes(1);
      const failureLogs = logSpy.mock.calls.filter((call) =>
        String(call[0]).includes("Utility-model evaluation failed"),
      );
      expect(failureLogs).toHaveLength(1);
    });

    it("falls back when the reply is not a valid evaluation", async () => {
      const mockCli = buildMockCli();
      mockCli.runPrompt.mockResolvedValue("I cannot answer that.");
      const evaluator = buildEvaluator(mockCli);
      const evaluation = await evaluator.evaluateTask(buildTask({ id: "t1" }), "Web");
      expect(evaluation).toEqual(fallbackEvaluation());
      expect(logSpy.mock.calls.some((call) => String(call[0]).includes("Utility-model evaluation failed"))).toBe(
        true,
      );
    });

    it("falls back when the utility model does not reply within the timeout", async () => {
      const mockCli = buildMockCli();
      mockCli.runPrompt.mockImplementation(() => {
        const timer = setTimeout(() => resolveHanging("late reply"), 5000);
        // Do not keep the jest process alive for the hanging reply.
        timer.unref?.();
        return hanging;
      });
      let resolveHanging: (value: string) => void = () => undefined;
      const hanging = new Promise<string>((resolve) => {
        resolveHanging = resolve;
      });
      const evaluator = buildEvaluator(mockCli, { timeoutMs: 20 });
      const evaluation = await evaluator.evaluateTask(buildTask({ id: "t1" }), "Web");
      expect(evaluation).toEqual(fallbackEvaluation());
      expect(logSpy.mock.calls.some((call) => String(call[0]).includes("did not reply within"))).toBe(
        true,
      );
    });

    it("bounds the concurrent utility-model calls", async () => {
      const mockCli = buildMockCli();
      let concurrent = 0;
      let maxConcurrent = 0;
      mockCli.runPrompt.mockImplementation(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrent--;
        return '{"weight": 0.5, "conflicts": [], "kind": "code-light"}';
      });
      const evaluator = buildEvaluator(mockCli, { concurrency: 2 });
      const evaluations = await evaluator.evaluateAll(
        ["t1", "t2", "t3", "t4", "t5"].map((id) => ({
          task: buildTask({ id }),
          projectName: "Web",
        })),
      );
      expect(evaluations.size).toBe(5);
      expect(mockCli.runPrompt).toHaveBeenCalledTimes(5);
      expect(maxConcurrent).toBe(2);
    });

    it("lowers the batch concurrency to the process cap of the scheduler", async () => {
      const mockCli = buildMockCli();
      let concurrent = 0;
      let maxObserved = 0;
      mockCli.runPrompt.mockImplementation(async () => {
        concurrent++;
        maxObserved = Math.max(maxObserved, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrent--;
        return '{"weight": 0.5, "conflicts": [], "kind": "code-light"}';
      });
      const evaluator = buildEvaluator(mockCli, { concurrency: 3 });
      const evaluations = await evaluator.evaluateAll(
        ["t1", "t2", "t3", "t4"].map((id) => ({
          task: buildTask({ id }),
          projectName: "Web",
        })),
        // A scheduler process cap of 1: every evaluation is one CLI
        // process, so the batch runs strictly serially.
        { maxConcurrent: 1 },
      );
      expect(evaluations.size).toBe(4);
      expect(mockCli.runPrompt).toHaveBeenCalledTimes(4);
      expect(maxObserved).toBe(1);
    });
  });

  describe("bounded round, circuit breaker and cache bounds", () => {
    const realSleep = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms));

    it("bounds the round and lets a queued evaluation land in the cache in the background", async () => {
      const mockCli = buildMockCli();
      // The first evaluation hangs forever; the second resolves quickly.
      mockCli.runPrompt.mockImplementation(() => {
        if (mockCli.runPrompt.mock.calls.length === 1) {
          return new Promise<string>(() => undefined);
        }
        return new Promise<string>((resolve) => {
          const timer = setTimeout(
            () => resolve('{"weight": 0.5, "conflicts": [], "kind": "code-light"}'),
            30,
          );
          timer.unref?.();
        });
      });
      const evaluator = buildEvaluator(mockCli, {
        timeoutMs: 50,
        concurrency: 1,
      });
      const t1 = buildTask({ id: "t1" });
      const t2 = buildTask({ id: "t2" });

      const evaluations = await evaluator.evaluateAll([
        { task: t1, projectName: "Web" },
        { task: t2, projectName: "Web" },
      ]);
      // The round returned at the bound: both tasks carry the fallback for
      // this round (the first call timed out, the second had not run yet).
      expect(evaluations.get("t1")).toEqual(fallbackEvaluation());
      expect(evaluations.get("t2")).toEqual(fallbackEvaluation());

      // The evaluation queued behind the timed-out one keeps running and
      // its result lands in the cache for the next round.
      await realSleep(300);
      expect(mockCli.runPrompt).toHaveBeenCalledTimes(2);
      await expect(evaluator.evaluateTask(t2, "Web")).resolves.toEqual({
        weight: 0.5,
        conflicts: [],
        kind: "code-light",
      });
      expect(mockCli.runPrompt).toHaveBeenCalledTimes(2);
    });

    it("opens the circuit breaker after consecutive timeouts and skips the utility model during the cooldown", async () => {
      const mockCli = buildMockCli();
      mockCli.runPrompt.mockImplementation(
        () => new Promise<string>(() => undefined),
      );
      const evaluator = buildEvaluator(mockCli, {
        timeoutMs: 10,
        concurrency: 3,
      });

      // Three consecutive timeouts open the circuit.
      const inputs = ["t1", "t2", "t3"].map((id) => ({
        task: buildTask({ id }),
        projectName: "Web",
      }));
      const evaluations = await evaluator.evaluateAll(inputs);
      expect(mockCli.runPrompt).toHaveBeenCalledTimes(3);
      expect(evaluations.get("t1")).toEqual(fallbackEvaluation());
      // The per-call timeout catches settle in the macrotasks after the
      // round returned: let them run before the next round.
      await realSleep(30);

      // While the circuit is open the utility model is not called at all:
      // the cached evaluations still apply, the others fall back.
      mockCli.runPrompt.mockClear();
      const duringOpen = await evaluator.evaluateAll([
        { task: buildTask({ id: "t1" }), projectName: "Web" },
        { task: buildTask({ id: "t4" }), projectName: "Web" },
      ]);
      expect(mockCli.runPrompt).not.toHaveBeenCalled();
      expect(duringOpen.get("t1")).toEqual(fallbackEvaluation());
      expect(duringOpen.get("t4")).toEqual(fallbackEvaluation());

      // After the cooldown the calls resume.
      const nowSpy = jest
        .spyOn(Date, "now")
        .mockReturnValue(Date.now() + 6 * 60 * 1000);
      mockCli.runPrompt.mockResolvedValue(
        '{"weight": 0.75, "conflicts": [], "kind": "code-heavy"}',
      );
      const after = await evaluator.evaluateAll([
        { task: buildTask({ id: "t4" }), projectName: "Web" },
      ]);
      expect(mockCli.runPrompt).toHaveBeenCalledTimes(1);
      expect(after.get("t4")?.weight).toBe(0.75);
      nowSpy.mockRestore();
    });

    it("counts the evaluations by outcome", async () => {
      const mockCli = buildMockCli();
      mockCli.runPrompt
        .mockResolvedValueOnce(
          '{"weight": 0.5, "conflicts": [], "kind": "code-light"}',
        )
        .mockRejectedValueOnce(new Error("CLI is down"))
        .mockImplementation(() => new Promise<string>(() => undefined));
      const evaluator = buildEvaluator(mockCli, {
        timeoutMs: 10,
        concurrency: 3,
      });

      await evaluator.evaluateTask(buildTask({ id: "t1" }), "Web");
      await evaluator.evaluateTask(buildTask({ id: "t2" }), "Web");
      await evaluator.evaluateTask(buildTask({ id: "t3" }), "Web");

      const add = evaluationCounters()["evaluations"].add;
      expect(add).toHaveBeenCalledWith(1, { result: "success" });
      expect(add).toHaveBeenCalledWith(1, { result: "failure" });
      expect(add).toHaveBeenCalledWith(1, { result: "timeout" });
    });

    it("evicts the least recently used evaluations beyond the cache capacity", async () => {
      const mockCli = buildMockCli();
      mockCli.runPrompt.mockResolvedValue(
        '{"weight": 0.5, "conflicts": [], "kind": "code-light"}',
      );
      const evaluator = buildEvaluator(mockCli, { cacheCapacity: 2 });

      await evaluator.evaluateTask(buildTask({ id: "t1" }), "Web");
      await evaluator.evaluateTask(buildTask({ id: "t2" }), "Web");
      await evaluator.evaluateTask(buildTask({ id: "t3" }), "Web"); // evicts t1
      expect(mockCli.runPrompt).toHaveBeenCalledTimes(3);

      await evaluator.evaluateTask(buildTask({ id: "t1" }), "Web"); // re-evaluated
      expect(mockCli.runPrompt).toHaveBeenCalledTimes(4);

      await evaluator.evaluateTask(buildTask({ id: "t3" }), "Web"); // still cached
      expect(mockCli.runPrompt).toHaveBeenCalledTimes(4);
    });

    it("drops the cached evaluations past the TTL", async () => {
      const mockCli = buildMockCli();
      mockCli.runPrompt.mockResolvedValue(
        '{"weight": 0.5, "conflicts": [], "kind": "code-light"}',
      );
      const evaluator = buildEvaluator(mockCli, { cacheTtlMs: 50 });
      const task = buildTask({ id: "t1" });

      await evaluator.evaluateTask(task, "Web");
      await evaluator.evaluateTask(task, "Web");
      expect(mockCli.runPrompt).toHaveBeenCalledTimes(1);

      const nowSpy = jest
        .spyOn(Date, "now")
        .mockReturnValue(Date.now() + 60 * 1000);
      await evaluator.evaluateTask(task, "Web");
      expect(mockCli.runPrompt).toHaveBeenCalledTimes(2);
      nowSpy.mockRestore();
    });
  });
});
