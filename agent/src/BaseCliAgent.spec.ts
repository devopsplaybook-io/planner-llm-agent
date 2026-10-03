import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import type { AgentActionsConfig } from "./AgentActions";
import { Config } from "./Config";
import { BaseCliAgent, extractTaskModel, resolveModel } from "./clients/BaseCliAgent";
import { runCli } from "./CliUtils";
import type { RunCliOptions } from "./CliUtils";
import type { PlannerTask } from "./PlannerClient";
import type { PromptOptions, TaskOptions } from "./clients/CliAgent";

jest.mock("./OTelContext", () => {
  // One logger instance per module name: tests can assert the lines logged
  // by a specific module (e.g. 'cli-agent').
  const moduleLoggers: Record<
    string,
    { debug: jest.Mock; info: jest.Mock; warn: jest.Mock; error: jest.Mock }
  > = {};
  // Session metric instruments, recreated on every instrument creation so
  // a fresh client always gets fresh mocks.
  const histograms: Record<string, { record: jest.Mock }> = {};
  return {
    OTelTracer: jest.fn(() => ({
      startSpan: jest.fn(() => ({
        end: jest.fn(),
        setAttribute: jest.fn(),
        recordException: jest.fn(),
      })),
    })),
    OTelLogger: jest.fn(() => ({
      createModuleLogger: jest.fn((module: string) => {
        if (!moduleLoggers[module]) {
          moduleLoggers[module] = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
          };
        }
        return moduleLoggers[module];
      }),
    })),
    OTelMeter: jest.fn(() => ({
      createHistogram: jest.fn((key: string) => {
        histograms[key] = { record: jest.fn() };
        return histograms[key];
      }),
    })),
    __moduleLoggers: moduleLoggers,
    __histograms: histograms,
  };
});

jest.mock("./CliUtils", () => ({
  runCli: jest.fn(),
  extractErrorDetail: jest.fn(() => "error detail"),
}));

const MockedRunCli = runCli as unknown as jest.Mock;

// BaseCliAgent logs through the 'cli-agent' module logger: grab its info
// mock to assert the logged lines.
const otelMock = jest.requireMock("./OTelContext") as {
  __moduleLoggers: Record<string, { info: jest.Mock }>;
  __histograms: Record<string, { record: jest.Mock }>;
};
const moduleLoggers = otelMock.__moduleLoggers;
const baseCliAgentLogInfo = moduleLoggers["cli-agent"].info;

// Concrete adapter exposing the abstract methods with recorded calls.
class TestCliAgent extends BaseCliAgent {
  readonly name = "test";
  readonly displayName = "Test CLI";
  readonly authHint = "hint";

  // Records the onInvocationSettled hook calls (exposed for assertions).
  readonly settledCalls: string[][] = [];

  protected cliCommand(): string {
    return "test-cli";
  }

  protected buildAuthCheckArgs(probePrompt: string): string[] {
    return ["auth", probePrompt];
  }

  protected buildPromptArgs(prompt: string, model: string | null): string[] {
    return ["--model", model ?? "auto", "--prompt", prompt];
  }

  protected parseReply(result: { stdout: string; stderr: string }): string | null {
    return result.stdout.trim() || null;
  }

  protected extractUsage(): number | null {
    return null;
  }

  protected usageLabel(): string {
    return "Units";
  }

  protected buildListModelArgs(): string[] | null {
    return null;
  }

  protected parseModelList(): string[] {
    return [];
  }

  protected onInvocationSettled(args: string[]): void {
    this.settledCalls.push(args);
  }
}

const buildTask = (): PlannerTask => ({
  id: "task-1",
  projectId: "p1",
  title: "Task 1",
  status: "To Do",
  priority: "medium",
  description: "Do things",
  dateUpdated: "2026-09-10T00:00:00.000Z",
  comments: [],
  attachments: [],
});

// Minimal actions config with an actions default model.
const agentActions: AgentActionsConfig = {
  defaultModel: "actions-default-model",
  defaultTimeout: null,
  actions: [],
};

describe("BaseCliAgent", () => {
  let dataDir: string;
  let agent: TestCliAgent;

  beforeEach(() => {
    MockedRunCli.mockReset();
    MockedRunCli.mockResolvedValue({ stdout: "CLI reply\n", stderr: "" });
    dataDir = path.join(os.tmpdir(), `base-cli-agent-spec-${Date.now()}`);
    const config = new Config();
    config.DATA_DIR = dataDir;
    agent = new TestCliAgent(config, agentActions);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.requireActual("fs-extra").removeSync(dataDir);
  });

  const lastCall = (): { args: string[]; options: RunCliOptions } => {
    expect(MockedRunCli).toHaveBeenCalled();
    const calls = MockedRunCli.mock.calls;
    return { args: calls[calls.length - 1][1], options: calls[calls.length - 1][2] };
  };

  describe("runPrompt", () => {
    it("forwards the model override to the CLI arguments and the timeout to the CLI options", async () => {
      const options: PromptOptions = { model: "utility-model", timeoutMs: 12345 };
      const reply = await agent.runPrompt("Estimate this task", options);

      expect(reply).toBe("CLI reply");
      const { args, options: runOptions } = lastCall();
      expect(args.slice(0, 2)).toEqual(["--model", "utility-model"]);
      expect(args[3]).toContain("Estimate this task");
      expect(runOptions.timeout).toBe(12345);
    });

    it("falls back to the actions default model and the prompt timeout", async () => {
      await agent.runPrompt("Another standalone prompt");

      const { args, options } = lastCall();
      expect(args.slice(0, 2)).toEqual(["--model", "actions-default-model"]);
      expect(options.timeout).toBe(600000);
    });

    it("runs without a model argument when no model is configured", async () => {
      const config = new Config();
      config.DATA_DIR = dataDir;
      agent = new TestCliAgent(config, { ...agentActions, defaultModel: "" });
      await agent.runPrompt("No model set");

      const { args } = lastCall();
      expect(args.slice(0, 2)).toEqual(["--model", "auto"]);
    });

    it("labels the usage lines with the prompt purpose", async () => {
      await agent.runPrompt("Estimate this task", {
        purpose: "utility-model evaluation 'Task 1'",
      });

      const messages = baseCliAgentLogInfo.mock.calls.map(
        (call) => call[0] as string,
      );
      expect(messages).toContain(
        "Units before prompt (utility-model evaluation 'Task 1'): unknown",
      );
      expect(messages).toContain(
        "Units after prompt (utility-model evaluation 'Task 1'): unknown",
      );
    });
  });

  describe("performTask", () => {
    it("runs the task in the per-task working directory and states it in the prompt", async () => {
      const notesFile = path.join(dataDir, "tasks", "task-1-Agent.md");
      const taskDir = path.join(dataDir, "tasks", "task-1");
      const options: TaskOptions = { cwd: taskDir, timeoutSeconds: 60 };
      const summary = await agent.performTask(buildTask(), notesFile, options);

      expect(summary).toBe("CLI reply");
      const { args, options: runOptions } = lastCall();
      expect(runOptions.cwd).toBe(taskDir);
      expect(args[3]).toContain(`Working directory: ${taskDir}`);
    });

    it("falls back to the notes file directory as working directory", async () => {
      const notesFile = path.join(dataDir, "tasks", "task-1-Agent.md");
      await agent.performTask(buildTask(), notesFile);

      const { options } = lastCall();
      expect(options.cwd).toBe(path.dirname(notesFile));
    });

    it("lists the synced skills in the task prompt", async () => {
      const config = new Config();
      config.DATA_DIR = dataDir;
      config.AGENT_CONFIG_REPOSITORY =
        "https://github.com/acme/agent-config.git";
      agent = new TestCliAgent(config, agentActions);
      fse.outputFileSync(
        path.join(dataDir, "agent-config", "skills", "my-skill", "SKILL.md"),
        [
          "---",
          "name: my-skill",
          'description: "Use when testing the prompt."',
          "---",
          "",
          "# My skill",
        ].join("\n"),
      );

      const notesFile = path.join(dataDir, "tasks", "task-1-Agent.md");
      await agent.performTask(buildTask(), notesFile);

      const { args } = lastCall();
      expect(args[3]).toContain(
        "Available skills (read the SKILL.md of the relevant one before starting): 'my-skill — Use when testing the prompt.'",
      );
    });

    it("omits the skills list when no skill is synced", async () => {
      const config = new Config();
      config.DATA_DIR = dataDir;
      config.AGENT_CONFIG_REPOSITORY =
        "https://github.com/acme/agent-config.git";
      agent = new TestCliAgent(config, agentActions);

      const notesFile = path.join(dataDir, "tasks", "task-1-Agent.md");
      await agent.performTask(buildTask(), notesFile);

      const { args } = lastCall();
      expect(args[3]).not.toContain("Available skills");
    });
  });

  describe("usage persistence", () => {
    const writeUsage = (usage: number): Promise<void> =>
      (agent as unknown as { writeUsage: (usage: number) => Promise<void> }).writeUsage(
        usage,
      );

    it("persists and reads back the usage metric", async () => {
      await writeUsage(12.34);
      await expect(agent.readUsage()).resolves.toBe(12.34);
      await expect(agent.usageSummary()).resolves.toBe("Units: 12.34");
    });

    it("keeps the file valid and leaves no temp files behind under concurrent writes", async () => {
      await Promise.all(
        Array.from({ length: 30 }, (_, index) => writeUsage(index + 1)),
      );

      await expect(agent.readUsage()).resolves.toEqual(
        expect.any(Number),
      );
      expect(await agent.readUsage()).toBeGreaterThanOrEqual(1);
      expect(await agent.readUsage()).toBeLessThanOrEqual(30);
      const leftovers = (await fse.readdir(dataDir)).filter((entry) =>
        entry.includes(".tmp"),
      );
      expect(leftovers).toEqual([]);
    });

    it("returns null when no usage has been persisted", async () => {
      await expect(agent.readUsage()).resolves.toBeNull();
    });
  });

  describe("onInvocationSettled", () => {
    it("is called with the invocation arguments when a prompt settles", async () => {
      await agent.runPrompt("Settle this prompt");

      expect(agent.settledCalls).toHaveLength(1);
      expect(agent.settledCalls[0][3]).toContain("Settle this prompt");
    });

    it("is called when a prompt fails", async () => {
      MockedRunCli.mockRejectedValueOnce(new Error("boom"));

      await expect(agent.runPrompt("Failing prompt")).rejects.toThrow(
        "Test CLI prompt failed",
      );
      expect(agent.settledCalls).toHaveLength(1);
      expect(agent.settledCalls[0][3]).toContain("Failing prompt");
    });
  });

  describe("session metrics", () => {
    const notesFile = (): string =>
      path.join(dataDir, "tasks", "task-1-Agent.md");

    it("records the duration of a successful task", async () => {
      await agent.performTask(buildTask(), notesFile(), {
        model: "task-model",
      });

      const durations = otelMock.__histograms["session.duration"].record;
      expect(durations).toHaveBeenCalledTimes(1);
      expect(durations.mock.calls[0][0]).toBeGreaterThanOrEqual(0);
      expect(durations.mock.calls[0][0]).toBeLessThan(10);
      expect(durations.mock.calls[0][1]).toEqual({
        agent: "test",
        model: "task-model",
        status: "success",
      });
    });

    it("labels the session with the auto model when none is configured", async () => {
      await agent.performTask(buildTask(), notesFile());

      expect(
        otelMock.__histograms["session.duration"].record,
      ).toHaveBeenCalledWith(expect.any(Number), {
        agent: "test",
        model: "auto",
        status: "success",
      });
    });

    it("records an error session and rethrows the failure", async () => {
      MockedRunCli.mockRejectedValueOnce(
        Object.assign(new Error("boom"), { code: 1, killed: false }),
      );

      await expect(agent.performTask(buildTask(), notesFile())).rejects.toThrow(
        "Test CLI task execution failed",
      );

      expect(
        otelMock.__histograms["session.duration"].record,
      ).toHaveBeenCalledWith(expect.any(Number), {
        agent: "test",
        model: "auto",
        status: "error",
      });
    });
  });

  describe("model resolution", () => {
    it("resolves the model with the task description taking priority", () => {
      const task = buildTask();
      expect(resolveModel(task, "default-model")).toEqual({
        model: "default-model",
        source: "default",
      });
      expect(
        resolveModel({ ...task, description: "agent-model: task-model" }, "default-model"),
      ).toEqual({ model: "task-model", source: "task description" });
      expect(resolveModel({ ...task, description: "qoder-model: legacy-model" }, "")).toEqual({
        model: "legacy-model",
        source: "task description",
      });
      expect(resolveModel({ ...task, description: "" }, "")).toBeNull();
    });

    it("extracts the task model from the description", () => {
      expect(extractTaskModel("agent-model: m1\nrest")).toBe("m1");
      expect(extractTaskModel("qoder-model: m2")).toBe("m2");
      expect(extractTaskModel("nothing")).toBeNull();
    });
  });
});
