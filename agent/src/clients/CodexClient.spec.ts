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

// Waits for a condition on the real filesystem (the reply-file cleanup is
// fire-and-forget and may complete shortly after the run settles).
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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
    priority: "medium",
    description,
    dateUpdated: "",
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

  it("should isolate concurrent runs so each captures its own reply", async () => {
    const replyFiles: string[] = [];
    const callbacks: ((
      error: Error | null,
      stdout: string,
      stderr: string,
    ) => void)[] = [];
    mockExecFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const lastIndex = args.indexOf("--output-last-message");
        replyFiles.push(args[lastIndex + 1] as string);
        callbacks.push(callback);
        if (replyFiles.length < 2) {
          return { pid: replyFiles.length };
        }
        // Both runs started before either reply is written: a shared reply
        // file name would make both runs read the same content.
        fse.writeFileSync(replyFiles[0], "Reply of run 1\n");
        fse.writeFileSync(replyFiles[1], "Reply of run 2\n");
        callbacks.forEach((callback) => callback(null, "event stream", ""));
        return { pid: 2 };
      },
    );

    const summaries = await Promise.all([
      client.performTask(
        task(),
        path.join(os.tmpdir(), "codex-spec", "task-1-Agent.md"),
      ),
      client.performTask(
        task(),
        path.join(os.tmpdir(), "codex-spec", "task-2-Agent.md"),
      ),
    ]);

    expect(summaries.sort()).toEqual(["Reply of run 1", "Reply of run 2"]);
  });

  it("should use a unique reply file per run and remove it when the run settles", async () => {
    const replyFiles: string[] = [];
    mockExecFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const lastIndex = args.indexOf("--output-last-message");
        replyFiles.push(args[lastIndex + 1] as string);
        fse.writeFileSync(
          replyFiles[replyFiles.length - 1],
          "Reply of this run\n",
        );
        callback(null, "", "");
        return { pid: replyFiles.length };
      },
    );

    const summary = await client.performTask(
      task(),
      path.join(os.tmpdir(), "codex-spec", "task-1-Agent.md"),
    );
    expect(summary).toBe("Reply of this run");

    // The reply file is removed after the run settles.
    await waitFor(() => !fse.pathExistsSync(replyFiles[0]));
    expect(replyFiles[0]).not.toContain("undefined");

    // A second run gets a different file name.
    const summary2 = await client.performTask(
      task(),
      path.join(os.tmpdir(), "codex-spec", "task-1-Agent.md"),
    );
    expect(summary2).toBe("Reply of this run");
    expect(replyFiles[1]).not.toBe(replyFiles[0]);
    await waitFor(() => !fse.pathExistsSync(replyFiles[1]));
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
