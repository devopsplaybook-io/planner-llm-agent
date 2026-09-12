import { execFile } from "child_process";
import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import { GeminiClient } from "./GeminiClient";
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

describe("GeminiClient", () => {
  const originalEnv = process.env;
  let config: Config;
  let client: GeminiClient;

  beforeEach(() => {
    delete process.env.GEMINI_CLI;
    config = new Config();
    config.GEMINI_CLI = "gemini";
    config.DATA_DIR = path.join(os.tmpdir(), "gemini-spec", "data");
    client = new GeminiClient(config);
    mockExecFile.mockReset();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    fse.removeSync(path.join(os.tmpdir(), "gemini-spec"));
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
      ) => callback(null, JSON.stringify({ response: "OK" }), ""),
    );

    await expect(client.checkAuthentication()).resolves.toBeUndefined();

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [command, args] = mockExecFile.mock.calls[0];
    expect(command).toBe("gemini");
    expect(args).toEqual([
      "-p",
      "Reply with exactly: OK",
      "--output-format",
      "json",
    ]);
  });

  it("should run the task with the yolo approval mode", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) =>
        callback(
          null,
          JSON.stringify({ response: "Done", stats: { total: 1 } }),
          "",
        ),
    );

    const summary = await client.performTask(
      task("Add a feature\nagent-model: gemini-2.5-pro"),
      path.join(os.tmpdir(), "gemini-spec", "task-1-Agent.md"),
    );

    expect(summary).toBe("Done\n\n---\nModel: gemini-2.5-pro");
    const args = promptArgs();
    expect(args.slice(-6)).toEqual([
      "--model",
      "gemini-2.5-pro",
      "--output-format",
      "json",
      "--approval-mode",
      "yolo",
    ]);
  });

  it("should fall back to the raw stdout when the output is not json", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, "  Implemented the feature  \n", ""),
    );

    const summary = await client.performTask(
      task(),
      path.join(os.tmpdir(), "gemini-spec", "task-1-Agent.md"),
    );

    expect(summary).toBe("Implemented the feature");
  });

  it("should append no usage to the footer (not reported by the CLI)", async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, JSON.stringify({ response: "Done" }), ""),
    );

    const summary = await client.performTask(
      task(),
      path.join(os.tmpdir(), "gemini-spec", "task-1-Agent.md"),
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
          Object.assign(new Error("spawn gemini ENOENT"), { code: "ENOENT" }),
          "",
          "",
        ),
    );

    await expect(client.checkAuthentication()).rejects.toThrow(
      "Gemini CLI 'gemini' not found in PATH",
    );
  });
});
