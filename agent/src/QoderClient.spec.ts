import { execFile } from "child_process";
import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import { QoderClient } from "./QoderClient";
import { Config } from "./Config";

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
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    })),
  })),
}));

jest.mock("child_process", () => ({
  execFile: jest.fn(),
}));

const mockExecFile = execFile as unknown as jest.Mock;

describe("QoderClient", () => {
  const originalEnv = process.env;
  let config: Config;

  beforeEach(() => {
    delete process.env.QODER_CLI;
    config = new Config();
    config.QODER_CLI = "qoder";
    config.DATA_DIR = path.join(os.tmpdir(), "qoder-spec", "data");
    mockExecFile.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
    fse.removeSync(path.join(os.tmpdir(), "qoder-spec"));
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
          JSON.stringify({ response: "OK", stats: { total: 1 } }),
          "",
        ),
    );

    const client = new QoderClient(config);
    await expect(client.checkAuthentication()).resolves.toBeUndefined();

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockExecFile.mock.calls[0];
    expect(command).toBe("qoder");
    expect(args).toEqual([
      "-p",
      "Reply with exactly: OK",
      "--output-format",
      "json",
    ]);
    expect(options).toMatchObject({ timeout: 120000 });
  });

  it("should use the default model for the authentication probe", async () => {
    config.QODER_MODEL = "claude-sonnet-4-5";
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, JSON.stringify({ response: "OK" }), ""),
    );

    const client = new QoderClient(config);
    await expect(client.checkAuthentication()).resolves.toBeUndefined();

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

  it("should capture the account credits from the authentication probe", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) =>
        callback(
          null,
          JSON.stringify({ response: "OK", total_credits: 16.41 }),
          "",
        ),
    );

    const client = new QoderClient(config);
    await expect(client.checkAuthentication()).resolves.toBeUndefined();

    const creditsFile = path.join(
      os.tmpdir(),
      "qoder-spec",
      "data",
      "qoder-credits.json",
    );
    expect(await fse.readJson(creditsFile)).toEqual({ credits: 16.41 });
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

    const client = new QoderClient(config);
    await expect(client.checkAuthentication()).rejects.toThrow(
      "Qoder authentication probe did not return the expected reply. CLI output:\n(no output)",
    );
  });

  it("should include the CLI output when authentication fails", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) =>
        callback(
          Object.assign(new Error("Command failed"), {
            code: 1,
            killed: false,
            stderr:
              "DeprecationWarning: something\n    at someStackFrame\nNot logged in · Please run /login",
            stdout: "",
          }),
          "",
          "",
        ),
    );

    const client = new QoderClient(config);
    await expect(client.checkAuthentication()).rejects.toThrow(
      "Qoder authentication check failed:\nNot logged in · Please run /login",
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
          Object.assign(new Error("spawn qoder ENOENT"), { code: "ENOENT" }),
          "",
          "",
        ),
    );

    const client = new QoderClient(config);
    await expect(client.checkAuthentication()).rejects.toThrow(
      "Qoder CLI 'qoder' not found in PATH",
    );
  });

  it("should read the task summary from the file written by qoder", async () => {
    const taskDir = path.join(os.tmpdir(), "qoder-spec");
    const notesFile = path.join(taskDir, "task-1-Agent.md");
    const summaryFile = path.join(taskDir, "task-1-Agent-Summary.md");
    await fse.ensureDir(taskDir);
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        fse.writeFileSync(summaryFile, "  Implemented the feature  \n");
        callback(null, "", "");
      },
    );

    const client = new QoderClient(config);
    const summary = await client.performTask(
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
      notesFile,
    );

    expect(summary).toBe("Implemented the feature");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockExecFile.mock.calls[0];
    expect(command).toBe("qoder");
    expect(args[0]).toBe("-p");
    expect(String(args[1])).toContain(
      `Task documentation file: ${notesFile}`,
    );
    expect(String(args[1])).toContain(`to the file: ${summaryFile}`);
    expect(args.slice(2)).toEqual([
      "--output-format",
      "json",
      "--permission-mode",
      "bypass_permissions",
    ]);
    expect(options).toMatchObject({
      timeout: 1800000,
      cwd: taskDir,
    });
    expect(await fse.pathExists(summaryFile)).toBe(false);
  });

  it("should document the organization token variables in the task prompt", async () => {
    config.GITHUB_TOKENS =
      "my-org=github_pat_aaaaaaaaaaaaaaaaaaaa,other-org=github_pat_bbbbbbbbbbbbbbbbbbbb";
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, JSON.stringify({ result: "Done" }), ""),
    );

    const client = new QoderClient(config);
    await client.performTask(
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
      path.join(os.tmpdir(), "qoder-spec", "task-1-Agent.md"),
    );

    const [, args] = mockExecFile.mock.calls[0];
    const prompt = String(args[1]);
    expect(prompt).toContain('GH_TOKEN="$GH_TOKEN_MY_ORG" gh pr create');
    expect(prompt).toContain(
      "my-org -> GH_TOKEN_MY_ORG, other-org -> GH_TOKEN_OTHER_ORG",
    );
  });

  it("should not document organization token variables when none are configured", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, JSON.stringify({ result: "Done" }), ""),
    );

    const client = new QoderClient(config);
    await client.performTask(
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
      path.join(os.tmpdir(), "qoder-spec", "task-1-Agent.md"),
    );

    const [, args] = mockExecFile.mock.calls[0];
    expect(String(args[1])).not.toContain("GH_TOKEN_");
  });

  it("should fall back to the json response when qoder does not write a summary file", async () => {
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
            response: "  Implemented the feature  ",
            stats: { total: 1 },
          }),
          "",
        ),
    );

    const client = new QoderClient(config);
    const summary = await client.performTask(
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
      path.join(os.tmpdir(), "qoder-spec", "task-1-Agent.md"),
    );

    expect(summary).toBe("Implemented the feature");
  });

  it("should run the task with the model requested in the task description", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, JSON.stringify({ result: "Done" }), ""),
    );

    const client = new QoderClient(config);
    await client.performTask(
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature\nqoder-model: claude-opus-4-1\n",
        comments: [],
        attachments: [],
      },
      path.join(os.tmpdir(), "qoder-spec", "task-1-Agent.md"),
    );

    const [, args] = mockExecFile.mock.calls[0];
    expect(args.slice(-6)).toEqual([
      "--model",
      "claude-opus-4-1",
      "--output-format",
      "json",
      "--permission-mode",
      "bypass_permissions",
    ]);
  });

  it("should run the task with the default model when the description has no request", async () => {
    config.QODER_MODEL = "claude-sonnet-4-5";
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, JSON.stringify({ result: "Done" }), ""),
    );

    const client = new QoderClient(config);
    await client.performTask(
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
      path.join(os.tmpdir(), "qoder-spec", "task-1-Agent.md"),
    );

    const [, args] = mockExecFile.mock.calls[0];
    expect(args.slice(-6)).toEqual([
      "--model",
      "claude-sonnet-4-5",
      "--output-format",
      "json",
      "--permission-mode",
      "bypass_permissions",
    ]);
  });

  it("should prioritize the task description model over the default model", async () => {
    config.QODER_MODEL = "claude-sonnet-4-5";
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, JSON.stringify({ result: "Done" }), ""),
    );

    const client = new QoderClient(config);
    await client.performTask(
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature\nQoder-Model: claude-opus-4-1",
        comments: [],
        attachments: [],
      },
      path.join(os.tmpdir(), "qoder-spec", "task-1-Agent.md"),
    );

    const [, args] = mockExecFile.mock.calls[0];
    expect(args.slice(-6)).toEqual([
      "--model",
      "claude-opus-4-1",
      "--output-format",
      "json",
      "--permission-mode",
      "bypass_permissions",
    ]);
  });

  it("should append the model and credits footer to the task summary", async () => {
    const dataDir = path.join(os.tmpdir(), "qoder-spec", "data");
    await fse.outputJson(path.join(dataDir, "qoder-credits.json"), {
      credits: 16.41,
    });
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) =>
        callback(
          null,
          JSON.stringify({ result: "Done", total_credits: 16.35 }),
          "",
        ),
    );

    const client = new QoderClient(config);
    const summary = await client.performTask(
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature\nqoder-model: claude-opus-4-1",
        comments: [],
        attachments: [],
      },
      path.join(os.tmpdir(), "qoder-spec", "task-1-Agent.md"),
    );

    expect(summary).toBe(
      "Done\n\n---\nModel: claude-opus-4-1 · Qoder credits: 16.41 -> 16.35",
    );
    expect(await fse.readJson(path.join(dataDir, "qoder-credits.json"))).toEqual(
      { credits: 16.35 },
    );
  });

  it("should display the auto model and unknown previous credits on the first task", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) =>
        callback(
          null,
          JSON.stringify({ result: "Done", total_credits: 16.35 }),
          "",
        ),
    );

    const client = new QoderClient(config);
    const summary = await client.performTask(
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
      path.join(os.tmpdir(), "qoder-spec", "task-1-Agent.md"),
    );

    expect(summary).toBe(
      "Done\n\n---\nModel: auto · Qoder credits: unknown -> 16.35",
    );
  });

  it("should accept the probe reply from the json result field", async () => {
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
            result: "OK",
          }),
          "",
        ),
    );

    const client = new QoderClient(config);
    await expect(client.checkAuthentication()).resolves.toBeUndefined();
  });

  it("should fall back to the json result field when qoder does not write a summary file", async () => {
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
            duration_ms: 118561,
            is_error: false,
            num_turns: 21,
            result:
              "Documented eight prioritized skill recommendations in the task's Agent Notes.",
            stop_reason: "end_turn",
            session_id: "2e853ece-ff3b-42b4-8e2d-61a9fee59f3e",
          }),
          "",
        ),
    );

    const client = new QoderClient(config);
    const summary = await client.performTask(
      {
        id: "task-1",
        title: "Suggest skills",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
      path.join(os.tmpdir(), "qoder-spec", "task-1-Agent.md"),
    );

    expect(summary).toBe(
      "Documented eight prioritized skill recommendations in the task's Agent Notes.",
    );
  });

  it("should extract the reply when the json envelope is surrounded by other output", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) =>
        callback(
          null,
          `Warning: deprecated flag\n${JSON.stringify({ result: "Implemented the feature" })}\n`,
          "",
        ),
    );

    const client = new QoderClient(config);
    const summary = await client.performTask(
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
      path.join(os.tmpdir(), "qoder-spec", "task-1-Agent.md"),
    );

    expect(summary).toBe("Implemented the feature");
  });

  it("should fall back to plain stdout when the output is not json", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, "  Implemented the feature  \n", ""),
    );

    const client = new QoderClient(config);
    const summary = await client.performTask(
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
      path.join(os.tmpdir(), "qoder-spec", "task-1-Agent.md"),
    );

    expect(summary).toBe("Implemented the feature");
  });

  it("should return a fallback summary when qoder returns no output", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, "", ""),
    );

    const client = new QoderClient(config);
    const summary = await client.performTask(
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
      "/tmp/qoder-spec/task-1-Agent.md",
    );

    expect(summary).toBe("Task executed (no output returned by Qoder)");
  });

  it("should include the CLI output when task execution fails", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) =>
        callback(
          Object.assign(new Error("Command failed"), {
            code: 1,
            killed: false,
            stderr: "boom",
            stdout: "",
          }),
          "",
          "",
        ),
    );

    const client = new QoderClient(config);
    await expect(
      client.performTask(
        {
          id: "task-1",
          title: "Implement feature",
          status: "To Do",
          description: "",
          comments: [],
          attachments: [],
        },
        "/tmp/qoder-spec/task-1-Agent.md",
      ),
    ).rejects.toThrow("Qoder task execution failed:\nboom");
  });

  it("should run a standalone prompt and return the reply", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) =>
        callback(
          null,
          JSON.stringify({ result: "Generated note", total_credits: 15.5 }),
          "",
        ),
    );

    const client = new QoderClient(config);
    const reply = await client.runPrompt("Write a note about the agent");

    expect(reply).toBe("Generated note");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockExecFile.mock.calls[0];
    expect(command).toBe("qoder");
    expect(args).toEqual([
      "-p",
      "Write a note about the agent",
      "--output-format",
      "json",
      "--permission-mode",
      "bypass_permissions",
    ]);
    expect(options).toMatchObject({ timeout: 600000 });
  });

  it("should apply the default model to standalone prompts", async () => {
    config.QODER_MODEL = "claude-sonnet-4-5";
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, JSON.stringify({ result: "reply" }), ""),
    );

    const client = new QoderClient(config);
    await expect(client.runPrompt("hello")).resolves.toBe("reply");

    const [, args] = mockExecFile.mock.calls[0];
    expect(args).toEqual([
      "-p",
      "hello",
      "--model",
      "claude-sonnet-4-5",
      "--output-format",
      "json",
      "--permission-mode",
      "bypass_permissions",
    ]);
  });

  it("should persist the credits reported by standalone prompts", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) =>
        callback(
          null,
          JSON.stringify({ result: "reply", total_credits: 14.25 }),
          "",
        ),
    );

    const client = new QoderClient(config);
    await client.runPrompt("hello");

    const creditsFile = path.join(
      os.tmpdir(),
      "qoder-spec",
      "data",
      "qoder-credits.json",
    );
    expect(await fse.readJson(creditsFile)).toEqual({ credits: 14.25 });
  });

  it("should fall back to the raw stdout for standalone prompts without a JSON envelope", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, "plain text reply", ""),
    );

    const client = new QoderClient(config);
    await expect(client.runPrompt("hello")).resolves.toBe(
      "plain text reply",
    );
  });

  it("should report a missing CLI for standalone prompts", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) =>
        callback(
          Object.assign(new Error("spawn qoder ENOENT"), {
            code: "ENOENT",
          }),
          "",
          "",
        ),
    );

    const client = new QoderClient(config);
    await expect(client.runPrompt("hello")).rejects.toThrow(
      "Qoder CLI 'qoder' not found in PATH",
    );
  });
});
