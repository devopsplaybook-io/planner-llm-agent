import { execFile } from "child_process";
import {
  ExecFileError,
  extractErrorDetail,
  PROCESS_GROUP_KILL_GRACE_MS,
  runCli,
} from "./CliUtils";

jest.mock("child_process", () => ({
  execFile: jest.fn(),
}));

const mockExecFile = execFile as unknown as jest.Mock;

// The spawned pid reported by the fake child process.
const FAKE_PID = 4242;

type ExecCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

describe("CliUtils", () => {
  let killSpy: jest.SpyInstance;
  // The execFile completion callback captured from the fake spawn, invoked
  // by the tests to simulate the end of the CLI process.
  let execCallback: ExecCallback = () => undefined;

  beforeEach(() => {
    jest.useFakeTimers();
    mockExecFile.mockReset();
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: ExecCallback,
      ) => {
        execCallback = callback;
        return { pid: FAKE_PID };
      },
    );
    killSpy = jest.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    jest.useRealTimers();
    killSpy.mockRestore();
  });

  it("should pass the options through without the process-group kill", async () => {
    const options = {
      timeout: 1000,
      windowsHide: true,
      encoding: "utf8" as const,
    };
    const promise = runCli("cli", ["arg"], options);

    expect(mockExecFile).toHaveBeenCalledWith(
      "cli",
      ["arg"],
      options,
      expect.any(Function),
    );
    execCallback(null, "out", "");
    await expect(promise).resolves.toEqual({ stdout: "out", stderr: "" });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("should strip the kill option and reject on failure without the process-group kill", async () => {
    const promise = runCli("cli", ["arg"], {
      encoding: "utf8",
      killProcessGroup: true,
      // Without a positive timeout the kill behavior stays opt-out.
    });

    const [, , spawnOptions] = mockExecFile.mock.calls[0];
    expect(spawnOptions).toEqual({ encoding: "utf8" });

    const failure = Object.assign(new Error("Command failed"), {
      code: 1,
      killed: false,
    });
    execCallback(failure, "", "");
    await expect(promise).rejects.toBe(failure);
  });

  it("should spawn the CLI detached and manage the timeout itself with the process-group kill", async () => {
    const promise = runCli("cli", ["arg"], {
      timeout: 5000,
      windowsHide: true,
      encoding: "utf8",
      killProcessGroup: true,
    });

    const [, , spawnOptions] = mockExecFile.mock.calls[0];
    expect(spawnOptions).toMatchObject({
      detached: true,
      windowsHide: true,
      encoding: "utf8",
    });
    expect(spawnOptions).not.toHaveProperty("timeout");
    expect(spawnOptions).not.toHaveProperty("killProcessGroup");

    // At the timeout the whole process group receives SIGTERM and the run
    // is reported as killed even when the CLI exits successfully.
    jest.advanceTimersByTime(5000);
    expect(killSpy).toHaveBeenCalledWith(-FAKE_PID, "SIGTERM");
    execCallback(null, "out", "");
    await expect(promise).rejects.toMatchObject({ killed: true });
  });

  it("should escalate to SIGKILL after the grace period", async () => {
    const promise = runCli("cli", ["arg"], {
      timeout: 5000,
      encoding: "utf8",
      killProcessGroup: true,
    });

    jest.advanceTimersByTime(5000);
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenLastCalledWith(-FAKE_PID, "SIGTERM");

    jest.advanceTimersByTime(PROCESS_GROUP_KILL_GRACE_MS);
    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenLastCalledWith(-FAKE_PID, "SIGKILL");

    execCallback(Object.assign(new Error("Command failed"), { code: null }), "", "");
    await expect(promise).rejects.toMatchObject({ killed: true });
  });

  it("should not signal the process group when the command completes before the timeout", async () => {
    const promise = runCli("cli", ["arg"], {
      timeout: 5000,
      encoding: "utf8",
      killProcessGroup: true,
    });

    execCallback(null, "out", "");
    await expect(promise).resolves.toEqual({ stdout: "out", stderr: "" });

    jest.advanceTimersByTime(60000 + PROCESS_GROUP_KILL_GRACE_MS);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("should not arm the timeout when the process group cannot be signaled", async () => {
    killSpy.mockImplementation(() => {
      throw new Error("kill ESRCH");
    });

    const promise = runCli("cli", ["arg"], {
      timeout: 5000,
      encoding: "utf8",
      killProcessGroup: true,
    });

    jest.advanceTimersByTime(5000);
    execCallback(null, "out", "");
    await expect(promise).rejects.toMatchObject({ killed: true });
  });

  it("should attach the captured output to the rejected error without the process-group kill", async () => {
    const promise = runCli("cli", ["arg"], { encoding: "utf8" });

    const failure = Object.assign(new Error("Command failed"), { code: 1 });
    execCallback(failure, "partial output", "Error: boom\n");

    await expect(promise).rejects.toMatchObject({
      stdout: "partial output",
      stderr: "Error: boom\n",
    });
  });

  it("should keep the output already carried by the error", async () => {
    const promise = runCli("cli", ["arg"], { encoding: "utf8" });

    const failure = Object.assign(new Error("Command failed"), {
      code: 1,
      stderr: "original stderr",
    });
    execCallback(failure, "callback stdout", "callback stderr");

    await expect(promise).rejects.toMatchObject({
      stdout: "callback stdout",
      stderr: "original stderr",
    });
  });

  it("should attach the captured output to the rejected error with the process-group kill", async () => {
    const promise = runCli("cli", ["arg"], {
      timeout: 5000,
      encoding: "utf8",
      killProcessGroup: true,
    });

    const failure = Object.assign(new Error("Command failed"), { code: 1 });
    execCallback(failure, "out", "Error: boom\n");

    await expect(promise).rejects.toMatchObject({
      stdout: "out",
      stderr: "Error: boom\n",
    });
  });

  describe("extractErrorDetail", () => {
    const failure = (
      message: string,
      fields: Partial<ExecFileError> = {},
    ): ExecFileError => Object.assign(new Error(message), fields);

    it("should report stderr before stdout", () => {
      expect(
        extractErrorDetail(
          failure("Command failed: cli", {
            stderr: "Error: boom",
            stdout: "out line",
          }),
        ),
      ).toBe("Error: boom\nout line");
    });

    it("should drop the Command failed header and keep the error lines", () => {
      expect(
        extractErrorDetail(
          failure(
            'Command failed: copilot -p Do the task --model "GPT-6 Luna"\nError: Model "GPT-6 Luna" from --model flag is not available.',
          ),
        ),
      ).toBe('Error: Model "GPT-6 Luna" from --model flag is not available.');
    });

    it("should keep a message without the Command failed header", () => {
      expect(
        extractErrorDetail(
          failure("GITHUB_TOKENS token for organization 'myorg' is too short"),
        ),
      ).toBe("GITHUB_TOKENS token for organization 'myorg' is too short");
    });

    it("should drop stack frames and deprecation noise", () => {
      const stderr = [
        "Error: boom",
        "    at Object.<anonymous> (/app/index.js:1:1)",
        "DeprecationWarning: fs.lstat is deprecated",
        "Run with --trace-deprecation for details",
      ].join("\n");
      expect(extractErrorDetail(failure("Command failed: cli", { stderr }))).toBe(
        "Error: boom",
      );
    });

    it("should cap the number of lines", () => {
      const stderr = Array.from(
        { length: 8 },
        (_, index) => `line ${index + 1}`,
      ).join("\n");

      expect(extractErrorDetail(failure("Command failed: cli", { stderr }))).toBe(
        "line 1\nline 2\nline 3\nline 4\nline 5",
      );
    });

    it("should cap the length of each line", () => {
      const longLine = "x".repeat(500);

      expect(
        extractErrorDetail(
          failure("Command failed: cli", { stderr: longLine }),
        ),
      ).toBe(`${"x".repeat(300)}...`);
    });

    it("should cap the total length", () => {
      const stderr = Array.from({ length: 5 }, () => "y".repeat(250)).join(
        "\n",
      );

      const detail = extractErrorDetail(
        failure("Command failed: cli", { stderr }),
      );
      expect(detail).toHaveLength(803);
      expect(detail.endsWith("...")).toBe(true);
    });

    it("should keep the maxBuffer message as-is", () => {
      expect(
        extractErrorDetail(
          failure("stdout maxBuffer length exceeded", {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            stdout: "truncated output",
          }),
        ),
      ).toBe("stdout maxBuffer length exceeded");
    });

    it("should fall back to the exit code when the CLI printed nothing", () => {
      expect(extractErrorDetail(failure("Command failed: cli", { code: 1 }))).toBe(
        "the CLI exited with code 1 and produced no error output",
      );
    });
  });
});
