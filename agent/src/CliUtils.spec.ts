import { execFile } from "child_process";
import { PROCESS_GROUP_KILL_GRACE_MS, runCli } from "./CliUtils";

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
});
