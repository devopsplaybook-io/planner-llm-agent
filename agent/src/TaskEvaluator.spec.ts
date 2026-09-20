import { Config } from "./Config";
import type { PlannerTask } from "./PlannerClient";
import type { CliAgentClient, PromptOptions } from "./clients/CliAgent";
import {
  TaskEvaluator,
  buildEvaluationPrompt,
  fallbackEvaluation,
  parseEvaluation,
} from "./TaskEvaluator";

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
  options: { model?: string; timeoutMs?: number; concurrency?: number } = {},
): TaskEvaluator => {
  const config = new Config();
  config.AGENT_UTILITY_MODEL = options.model ?? "qwen3-flash";
  return new TaskEvaluator(config, mockCli, {
    timeoutMs: options.timeoutMs,
    concurrency: options.concurrency,
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
      expect(options).toEqual({ model: "qwen3-flash", timeoutMs: 60000 });
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
});
