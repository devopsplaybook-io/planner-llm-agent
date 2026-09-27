import { execFile } from "child_process";
import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import { CopilotCliClient } from "./CopilotCliClient";
import { Config } from "../Config";

jest.mock("../OTelContext", () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return {
    __logger: logger,
    OTelTracer: jest.fn(() => ({
      startSpan: jest.fn(() => ({
        end: jest.fn(),
        setAttribute: jest.fn(),
        recordException: jest.fn(),
      })),
    })),
    OTelLogger: jest.fn(() => ({
      createModuleLogger: jest.fn(() => logger),
    })),
  };
});

const mockLogger = (
  jest.requireMock("../OTelContext") as {
    __logger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock };
  }
).__logger;

jest.mock("child_process", () => ({
  execFile: jest.fn(),
}));

const mockExecFile = execFile as unknown as jest.Mock;

const promptArgs = (): string[] => {
  const call = mockExecFile.mock.calls.find((call) =>
    (call[1] as string[]).includes("-p"),
  );
  if (!call) {
    throw new Error("No task prompt call recorded");
  }
  return call[1] as string[];
};

describe("CopilotCliClient", () => {
  const originalEnv = process.env;
  let config: Config;
  let client: CopilotCliClient;

  beforeEach(() => {
    delete process.env.COPILOT_CLI;
    config = new Config();
    config.COPILOT_CLI = "copilot";
    config.DATA_DIR = path.join(os.tmpdir(), "copilot-cli-spec", "data");
    client = new CopilotCliClient(config);
    mockExecFile.mockReset();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    fse.removeSync(path.join(os.tmpdir(), "copilot-cli-spec"));
  });

  const task = (description = "Add a feature") => ({
    id: "task-1",
    projectId: "project-1",
    title: "Implement feature",
    status: "To Do",
    priority: "medium",
    description,
    dateUpdated: "",
    comments: [],
    attachments: [],
  });

  it("should run a headless prompt to verify authentication", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, "OK", ""),
    );

    await expect(client.checkAuthentication()).resolves.toBeUndefined();

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [command, args] = mockExecFile.mock.calls[0];
    expect(command).toBe("copilot");
    expect(args).toEqual([
      "-p",
      "Reply with exactly: OK",
      "--output-format",
      "text",
      "--silent",
    ]);
  });

  it("should run the task with the Copilot autonomy flags and a silent text output", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, "Done", ""),
    );

    const summary = await client.performTask(
      task("Add a feature\nagent-model: claude-sonnet-4.5"),
      path.join(os.tmpdir(), "copilot-cli-spec", "task-1-Agent.md"),
    );

    expect(summary).toBe("Done\n\n---\nModel: claude-sonnet-4.5");
    const args = promptArgs();
    expect(args.slice(-6)).toEqual([
      "--model",
      "claude-sonnet-4.5",
      "--output-format",
      "text",
      "--silent",
      "--yolo",
    ]);
  });

  it("should extract the reply from the plain stdout", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, "\n  Implemented the feature  \n", ""),
    );

    const summary = await client.performTask(
      task(),
      path.join(os.tmpdir(), "copilot-cli-spec", "task-1-Agent.md"),
    );

    expect(summary).toBe("Implemented the feature");
  });

  it("should report no output when the CLI prints nothing", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, "  \n", ""),
    );

    const summary = await client.performTask(
      task(),
      path.join(os.tmpdir(), "copilot-cli-spec", "task-1-Agent.md"),
    );

    expect(summary).toBe("Task executed (no output returned by Copilot)");
  });

  it("should append no usage to the footer (not reported by the CLI)", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, "Done", ""),
    );

    const summary = await client.performTask(
      task(),
      path.join(os.tmpdir(), "copilot-cli-spec", "task-1-Agent.md"),
    );

    expect(summary).toBe("Done");
    expect(await client.listModels()).toBeNull();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("should report a clear error when the CLI is not installed", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) =>
        callback(
          Object.assign(new Error("spawn copilot ENOENT"), {
            code: "ENOENT",
          }),
          "",
          "",
        ),
    );

    await expect(client.checkAuthentication()).rejects.toThrow(
      "Copilot CLI 'copilot' not found in PATH",
    );
  });

  describe("prepare", () => {
    it("should register the synced skills directory with the CLI", async () => {
      config.AGENT_CONFIG_REPOSITORY =
        "https://github.com/acme/agent-config.git";
      mockExecFile.mockImplementation(
        (
          _command: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => callback(null, "Added custom skill directory", ""),
      );

      await expect(client.prepare()).resolves.toBeUndefined();

      expect(mockExecFile).toHaveBeenCalledTimes(1);
      const [command, args] = mockExecFile.mock.calls[0];
      expect(command).toBe("copilot");
      expect(args).toEqual([
        "skill",
        "add",
        path.join(config.DATA_DIR, "agent-config", "skills"),
      ]);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Copilot skills directory registered"),
      );
    });

    it("should do nothing when no agent config repository is configured", async () => {
      await expect(client.prepare()).resolves.toBeUndefined();

      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("should stay non-fatal when the registration fails", async () => {
      config.AGENT_CONFIG_REPOSITORY =
        "https://github.com/acme/agent-config.git";
      mockExecFile.mockImplementation(
        (
          _command: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) =>
          callback(
            Object.assign(new Error("spawn copilot ENOENT"), {
              code: "ENOENT",
            }),
            "",
            "",
          ),
      );

      await expect(client.prepare()).resolves.toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Copilot skills directory registration failed"),
      );
    });
  });
});
