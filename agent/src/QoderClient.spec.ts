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
        },
        "/tmp/qoder-spec/task-1-Agent.md",
      ),
    ).rejects.toThrow("Qoder task execution failed:\nboom");
  });
});
