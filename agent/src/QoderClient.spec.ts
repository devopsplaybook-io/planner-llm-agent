import { execFile } from "child_process";
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

    const client = new QoderClient(config);
    await expect(client.checkAuthentication()).resolves.toBeUndefined();

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockExecFile.mock.calls[0];
    expect(command).toBe("qoder");
    expect(args).toEqual(["-p", "Reply with exactly: OK"]);
    expect(options).toMatchObject({ timeout: 120000 });
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
});
