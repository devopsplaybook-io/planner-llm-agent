import { execFile } from "child_process";
import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import { CodexClient } from "./CodexClient";
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

// The CLI call carrying the task prompt (task and standalone prompt calls
// capture the last message; the authentication probe does not).
const promptCall = (): { command: string; args: string[] } => {
  const call = mockExecFile.mock.calls.find((call) =>
    (call[1] as string[]).includes("--output-last-message"),
  );
  if (!call) {
    throw new Error("No task prompt call recorded");
  }
  return { command: call[0] as string, args: call[1] as string[] };
};

describe("CodexClient", () => {
  const originalEnv = process.env;
  let config: Config;
  let client: CodexClient;

  beforeEach(() => {
    delete process.env.CODEX_CLI;
    config = new Config();
    config.CODEX_CLI = "codex";
    config.DATA_DIR = path.join(os.tmpdir(), "codex-spec", "data");
    client = new CodexClient(config);
    mockExecFile.mockReset();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    fse.removeSync(path.join(os.tmpdir(), "codex-spec"));
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

  it("should run a headless exec prompt to verify authentication", async () => {
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
    expect(command).toBe("codex");
    expect(args).toEqual([
      "exec",
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "never",
      "--skip-git-repo-check",
      "Reply with exactly: OK",
    ]);
  });

  it("should run the task with the full-access sandbox and capture the last message", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        // The CLI writes the final reply to the --output-last-message file.
        const lastIndex = args.indexOf("--output-last-message");
        fse.writeFileSync(args[lastIndex + 1] as string, "Implemented the feature\n");
        callback(null, "codex event stream output", "");
      },
    );

    const summary = await client.performTask(
      task("Add a feature\nagent-model: gpt-5-codex"),
      path.join(os.tmpdir(), "codex-spec", "task-1-Agent.md"),
    );

    expect(summary).toBe(
      "Implemented the feature\n\n---\nModel: gpt-5-codex",
    );
    const { args } = promptCall();
    // Everything before the trailing '--output-last-message <file> <prompt>'.
    expect(args.slice(0, args.length - 3)).toEqual([
      "exec",
      "-m",
      "gpt-5-codex",
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "never",
      "--skip-git-repo-check",
    ]);
    expect(args[args.length - 1]).toContain("Task documentation file:");
  });

  it("should run without a model flag when none is configured", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const lastIndex = args.indexOf("--output-last-message");
        fse.writeFileSync(args[lastIndex + 1] as string, "Done");
        callback(null, "", "");
      },
    );

    await client.performTask(
      task(),
      path.join(os.tmpdir(), "codex-spec", "task-1-Agent.md"),
    );

    const { args } = promptCall();
    expect(args).not.toContain("-m");
    expect(await client.listModels()).toBeNull();
  });

  it("should fall back to the raw stdout when the last message file is missing", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, "Implemented the feature\n", ""),
    );

    const summary = await client.performTask(
      task(),
      path.join(os.tmpdir(), "codex-spec", "task-1-Agent.md"),
    );

    expect(summary).toBe("Implemented the feature");
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
          Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }),
          "",
          "",
        ),
    );

    await expect(client.checkAuthentication()).rejects.toThrow(
      "Codex CLI 'codex' not found in PATH",
    );
  });
});
