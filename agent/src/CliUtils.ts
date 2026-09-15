import { execFile } from "child_process";
import type { ExecFileOptionsWithStringEncoding } from "child_process";

export interface ExecFileError extends Error {
  code?: string | number;
  killed?: boolean;
  signal?: string;
  stderr?: string;
  stdout?: string;
}

export interface RunCliOptions extends ExecFileOptionsWithStringEncoding {
  // POSIX only: run the command as its own process-group leader and, when
  // the timeout expires, kill the whole process group (SIGTERM, then
  // SIGKILL after a grace period) so spawned children do not survive the
  // timeout. Requires 'timeout' to be set.
  killProcessGroup?: boolean;
}

// Grace period between the SIGTERM and the SIGKILL sent to a timed-out
// process group, so a SIGTERM-trapping CLI can still shut down cleanly.
export const PROCESS_GROUP_KILL_GRACE_MS = 10000;

/**
 * Run an external CLI command and capture its output.
 *
 * Uses an explicit promise wrapper around execFile (instead of promisify) so
 * the semantics stay identical to the real callback API, including when the
 * execFile function is replaced by a test mock.
 */
export function runCli(
  command: string,
  args: string[],
  options: RunCliOptions,
): Promise<{ stdout: string; stderr: string }> {
  if (
    options.killProcessGroup === true &&
    process.platform !== "win32" &&
    typeof options.timeout === "number" &&
    options.timeout > 0
  ) {
    return runCliWithProcessGroupKill(command, args, options);
  }
  const execOptions = { ...options };
  delete execOptions.killProcessGroup;
  return new Promise((resolve, reject) => {
    execFile(command, args, execOptions, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout: stdout, stderr: stderr });
      }
    });
  });
}

/**
 * runCli with the process-group kill behavior: the command is spawned
 * detached (POSIX: it becomes the leader of its own process group) and the
 * timeout is implemented here instead of by execFile's built-in one, which
 * only signals the direct child and lets spawned grandchildren survive.
 */
function runCliWithProcessGroupKill(
  command: string,
  args: string[],
  options: RunCliOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let terminateTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      if (terminateTimer) {
        clearTimeout(terminateTimer);
        terminateTimer = undefined;
      }
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    };

    const execOptions = { ...options };
    delete execOptions.killProcessGroup;
    // The timeout is implemented above with the process-group kill, so it
    // must not be handed to execFile as well.
    delete execOptions.timeout;
    // 'detached' is accepted by execFile at runtime (the options are
    // forwarded to spawn) but is missing from its TypeScript overloads.
    const child = execFile(
      command,
      args,
      { ...execOptions, detached: true } as ExecFileOptionsWithStringEncoding,
      (error, stdout, stderr) => {
        clearTimers();
        if (timedOut) {
          // Preserve the killed-by-timeout semantics of execFile's built-in
          // timeout so callers keep reporting a timeout error.
          const timeoutError = (error ??
            new Error(
              `Command timed out after ${options.timeout} ms`,
            )) as ExecFileError;
          timeoutError.killed = true;
          reject(timeoutError);
        } else if (error) {
          reject(error);
        } else {
          resolve({ stdout: stdout, stderr: stderr });
        }
      },
    );

    const pid = child.pid;
    if (typeof pid === "number") {
      terminateTimer = setTimeout(() => {
        timedOut = true;
        signalProcessGroup(pid, "SIGTERM");
        killTimer = setTimeout(() => {
          signalProcessGroup(pid, "SIGKILL");
        }, PROCESS_GROUP_KILL_GRACE_MS);
        killTimer.unref();
      }, options.timeout);
      terminateTimer.unref();
    }
  });
}

// Signals a whole process group; a missing group (already exited) or a
// permission error is tolerated.
function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Nothing more to do: the process group is already gone or cannot be
    // signaled.
  }
}

/**
 * Extract the most relevant lines from a failed CLI execution for logging.
 */
export function extractErrorDetail(error: ExecFileError): string {
  const output = [error.stderr, error.stdout]
    .filter((value) => value && value.trim().length > 0)
    .join("\n");
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith("at ") &&
        !line.startsWith("DeprecationWarning") &&
        !line.includes("--trace-deprecation"),
    )
    .slice(0, 5);
  return lines.length > 0 ? lines.join("\n") : error.message;
}
