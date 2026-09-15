import { execFile } from "child_process";
import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import { ClaudeCodeClient } from "./ClaudeCodeClient";
import { Config } from "../Config";

// The shared logger is created inside the factory because the mocked
// module is first required during the import evaluation, before any
// declaration of this file has run; it is retrieved with requireMock below.
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

// The CLI call carrying the task prompt.
const promptArgs = (): string[] => {
  const call = mockExecFile.mock.calls.find((call) =>
    (call[1] as string[]).includes("-p"),
  );
  if (!call) {
    throw new Error("No task prompt call recorded");
  }
  return call[1] as string[];
};

describe("ClaudeCodeClient", () => {
  const originalEnv = process.env;
  let config: Config;
  let client: ClaudeCodeClient;

  beforeEach(() => {
    delete process.env.CLAUDE_CLI;
    config = new Config();
    config.CLAUDE_CLI = "claude";
    config.DATA_DIR = path.join(os.tmpdir(), "claude-code-spec", "data");
    client = new ClaudeCodeClient(config);
    mockExecFile.mockReset();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    fse.removeSync(path.join(os.tmpdir(), "claude-code-spec"));
  });

  const task = (description = "Add a feature") => ({
    id: "task-1",
    projectId: "project-1",
    title: "Implement feature",
    status: "To Do",
    description,
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
      ) =>
        callback(
          null,
          JSON.stringify({ result: "OK", total_cost_usd: 0.01 }),
          "",
        ),
    );

    await expect(client.checkAuthentication()).resolves.toBeUndefined();

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockExecFile.mock.calls[0];
    expect(command).toBe("claude");
    expect(args).toEqual([
      "-p",
      "Reply with exactly: OK",
      "--output-format",
      "json",
    ]);
    expect(options).toMatchObject({ detached: true });
  });

  it("should use the default model for the authentication probe", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, JSON.stringify({ result: "OK" }), ""),
    );

    const clientWithModel = new ClaudeCodeClient(config, {
      defaultModel: "claude-sonnet-4-5",
      defaultTimeout: null,
      actions: [],
    });
    await expect(clientWithModel.checkAuthentication()).resolves.toBeUndefined();

    const [, args] = mockExecFile.mock.calls[0];
    expect(args).toEqual([
      "-p",
      "Reply with exactly: OK",
      "--model",
      "claude-sonnet-4-5",
      "--output-format",
      "json",
    ]);
  });

  it("should capture the run cost from the authentication probe", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) =>
        callback(null, JSON.stringify({ result: "OK", total_cost_usd: 0.05 }), ""),
    );

    await expect(client.checkAuthentication()).resolves.toBeUndefined();

    const usageFile = path.join(
      os.tmpdir(),
      "claude-code-spec",
      "data",
      "claude-code-usage.json",
    );
    expect(await fse.readJson(usageFile)).toEqual({ usage: 0.05 });
  });

  it("should fail authentication when the probe reply is missing", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, "", ""),
    );

    await expect(client.checkAuthentication()).rejects.toThrow(
      "Claude Code authentication probe did not return the expected reply. CLI output:\n(no output)",
    );
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
          Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
          "",
          "",
        ),
    );

    await expect(client.checkAuthentication()).rejects.toThrow(
      "Claude Code CLI 'claude' not found in PATH",
    );
  });

  it("should run the task with the Claude Code autonomy flags", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, JSON.stringify({ result: "Done" }), ""),
    );

    const summary = await client.performTask(
      task("Add a feature\nagent-model: claude-sonnet-4-5"),
      path.join(os.tmpdir(), "claude-code-spec", "task-1-Agent.md"),
    );

    expect(summary).toBe("Done\n\n---\nModel: claude-sonnet-4-5");
    const args = promptArgs();
    expect(args.slice(-6)).toEqual([
      "--model",
      "claude-sonnet-4-5",
      "--output-format",
      "json",
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  it("should display the run cost in the task footer", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) =>
        callback(
          null,
          JSON.stringify({ result: "Done", total_cost_usd: 0.4233 }),
          "",
        ),
    );

    const summary = await client.performTask(
      task(),
      path.join(os.tmpdir(), "claude-code-spec", "task-1-Agent.md"),
    );

    expect(summary).toBe("Done\n\n---\nModel: auto · Claude cost: $0.42");
  });

  it("should fall back to the json result field when no summary file is written", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) =>
        callback(
          null,
          JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "Implemented the feature",
          }),
          "",
        ),
    );

    const summary = await client.performTask(
      task(),
      path.join(os.tmpdir(), "claude-code-spec", "task-1-Agent.md"),
    );

    expect(summary).toBe("Implemented the feature");
  });

  it("should not run a model listing (validation is skipped without a warning)", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, JSON.stringify({ result: "Done" }), ""),
    );

    const summary = await client.performTask(
      task("Add a feature\nagent-model: claude-opus-4-1"),
      path.join(os.tmpdir(), "claude-code-spec", "task-1-Agent.md"),
    );

    expect(summary).toBe("Done\n\n---\nModel: claude-opus-4-1");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(await client.listModels()).toBeNull();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("should run a standalone prompt and return the reply", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) =>
        callback(null, JSON.stringify({ result: "Generated note" }), ""),
    );

    const reply = await client.runPrompt("Write a note about the agent");

    expect(reply).toBe("Generated note");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockExecFile.mock.calls[0];
    expect(command).toBe("claude");
    expect(args).toEqual([
      "-p",
      "Write a note about the agent",
      "--output-format",
      "json",
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(options).toMatchObject({ detached: true });
  });
});
