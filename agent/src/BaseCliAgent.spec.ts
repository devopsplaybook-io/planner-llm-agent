import * as os from "os";
import * as path from "path";
import type { AgentActionsConfig } from "./AgentActions";
import { Config } from "./Config";
import { BaseCliAgent, extractTaskModel, resolveModel } from "./clients/BaseCliAgent";
import { runCli } from "./CliUtils";
import type { RunCliOptions } from "./CliUtils";
import type { PlannerTask } from "./PlannerClient";
import type { PromptOptions, TaskOptions } from "./clients/CliAgent";

jest.mock("./OTelContext", () => ({
  OTelTracer: jest.fn(() => ({
    startSpan: jest.fn(() => ({
      end: jest.fn(),
      setAttribute: jest.fn(),
      recordException: jest.fn(),
    })),
  })),
  OTelLogger: jest.fn(() => ({
    createModuleLogger: jest.fn(() => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    })),
  })),
}));

jest.mock("./CliUtils", () => ({
  runCli: jest.fn(),
  extractErrorDetail: jest.fn(() => "error detail"),
}));

const MockedRunCli = runCli as unknown as jest.Mock;

// Concrete adapter exposing the abstract methods with recorded calls.
class TestCliAgent extends BaseCliAgent {
  readonly name = "test";
  readonly displayName = "Test CLI";
  readonly authHint = "hint";

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
