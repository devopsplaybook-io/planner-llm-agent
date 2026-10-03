import { execFile } from "child_process";
import type { ChildProcess, ExecException, ExecFileOptionsWithStringEncoding } from "child_process";

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
  // Content written to the command's standard input: secret values (like a
  // GPG passphrase) can be piped to a CLI without a shell and without
  // appearing in the process list or the environment.
  input?: string;
}

// Grace period between the SIGTERM and the SIGKILL sent to a timed-out
// process group, so a SIGTERM-trapping CLI can still shut down cleanly.
export const PROCESS_GROUP_KILL_GRACE_MS = 10000;

// Grace period given to the live CLI process groups at shutdown, between
// the SIGTERM and the SIGKILL sweep (aligned with the Kubernetes
// terminationGracePeriodSeconds, which must stay above it).
export const SHUTDOWN_KILL_GRACE_MS = 10000;

// How often the shutdown sweep re-checks whether the process groups have
// all settled, so an idle agent shuts down without waiting the full grace.
const SHUTDOWN_POLL_MS = 500;

// Live detached process groups spawned by runCli: registered when the
// command is spawned, removed when it settles. Detached process groups are
// not killed when the agent process exits, so a shutdown must signal them
// explicitly or in-flight CLI runs keep working on repositories and
// Planner state as orphans.
const liveProcessGroups = new Set<number>();

// Set during shutdown: a CLI run must not start while the process is dying.
let spawnsAccepted = true;

export function stopAcceptingNewSpawns(): void {
  spawnsAccepted = false;
}

/**
 * Kills every live detached process group (SIGTERM, then SIGKILL after the
 * grace period) and resolves once the sweep is done, immediately when every
 * group settles during the grace. The wait timers are not unref'd: the
 * shutdown flow awaits this function before exiting.
 */
export async function killLiveProcessGroups(
  graceMs: number = SHUTDOWN_KILL_GRACE_MS,
): Promise<void> {
  const pgids = [...liveProcessGroups];
  if (pgids.length === 0) {
    return;
  }
  for (const pgid of pgids) {
    signalProcessGroup(pgid, "SIGTERM");
  }
  const deadline = Date.now() + graceMs;
  while (liveProcessGroups.size > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, SHUTDOWN_POLL_MS),
    );
  }
  for (const pgid of liveProcessGroups) {
    signalProcessGroup(pgid, "SIGKILL");
  }
}

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
  if (!spawnsAccepted) {
    return Promise.reject(
      new Error("The agent is shutting down: no new CLI process can be started"),
    );
  }
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
  delete execOptions.input;
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, execOptions, (error, stdout, stderr) => {
      if (error) {
        reject(attachCliOutput(error, stdout, stderr));
      } else {
        resolve({ stdout: stdout, stderr: stderr });
      }
    });
    writeCliStdin(child, options.input);
  });
}

// Writes the stdin content of a spawned command. The child may exit before
// consuming the input (EPIPE): the error is swallowed here, the execFile
// callback remains the single error surface.
function writeCliStdin(child: ChildProcess | undefined, input: string | undefined): void {
  if (input === undefined) {
    return;
  }
  const stdin = child?.stdin;
  if (!stdin) {
    return;
  }
  stdin.on("error", () => {
    // The exit status reported by the execFile callback is authoritative.
  });
  stdin.end(input);
}

// Node's execFile does not attach the captured output to the error handed
// to the callback (verified on Node 26): without them the error detail can
// only fall back to the 'Command failed: <full argv>' message, which embeds
// the whole prompt. Attach them when the error does not carry them already.
function attachCliOutput<T extends ExecException>(
  error: T,
  stdout: string,
  stderr: string,
): T {
  if (error.stdout === undefined) {
    error.stdout = stdout;
  }
  if (error.stderr === undefined) {
    error.stderr = stderr;
  }
  return error;
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
    delete execOptions.input;
    // The timeout is implemented above with the process-group kill, so it
    // must not be handed to execFile as well.
    delete execOptions.timeout;
    // 'detached' is accepted by execFile at runtime (the options are
    // forwarded to spawn) but is missing from its TypeScript overloads.
    let pid: number | undefined;
    const child = execFile(
      command,
      args,
      { ...execOptions, detached: true } as ExecFileOptionsWithStringEncoding,
      (error, stdout, stderr) => {
        clearTimers();
        if (typeof pid === "number") {
          liveProcessGroups.delete(pid);
        }
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
          reject(attachCliOutput(error, stdout, stderr));
        } else {
          resolve({ stdout: stdout, stderr: stderr });
        }
      },
    );
    writeCliStdin(child, options.input);

    pid = child.pid;
    if (typeof pid === "number") {
      liveProcessGroups.add(pid);
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

// Maximum size of the error detail posted on a task: it must survive the
// failure-comment truncation (see Agent.buildFailureComment) so the real
// error line is never cut off.
const ERROR_DETAIL_MAX_LINES = 5;
const ERROR_DETAIL_MAX_LINE_LENGTH = 300;
const ERROR_DETAIL_MAX_LENGTH = 800;

/**
 * Extract the most relevant lines from a failed CLI execution for logging.
 * The captured stderr then stdout output is preferred; without output the
 * error message is used, minus its 'Command failed: <full argv>' header
 * (which embeds the whole prompt and is never an error detail).
 */
export function extractErrorDetail(error: ExecFileError): string {
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return error.message;
  }
  const output = [error.stderr, error.stdout]
    .filter((value) => value && value.trim().length > 0)
    .join("\n");
  const source =
    output.length > 0 ? output : stripCommandFailedHeader(error.message);
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith("at ") &&
        !line.startsWith("DeprecationWarning") &&
        !line.includes("--trace-deprecation"),
    )
    .slice(0, ERROR_DETAIL_MAX_LINES)
    .map((line) =>
      line.length > ERROR_DETAIL_MAX_LINE_LENGTH
        ? `${line.slice(0, ERROR_DETAIL_MAX_LINE_LENGTH)}...`
        : line,
    );
  const detail = lines.join("\n");
  if (detail.length > ERROR_DETAIL_MAX_LENGTH) {
    return `${detail.slice(0, ERROR_DETAIL_MAX_LENGTH)}...`;
  }
  return detail.length > 0
    ? detail
    : `the CLI exited with code ${error.code === undefined ? "unknown" : String(error.code)} and produced no error output`;
}

// Node's execFile builds the message as 'Command failed: <full argv>'
// followed by the captured stderr; only the text after the header line is
// an error detail.
function stripCommandFailedHeader(message: string): string {
  const lines = message.split("\n");
  if (lines[0]?.startsWith("Command failed:")) {
    return lines.slice(1).join("\n");
  }
  return message;
}
