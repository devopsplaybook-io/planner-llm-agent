import { execFile } from "child_process";
import type { ExecFileOptionsWithStringEncoding } from "child_process";

export interface ExecFileError extends Error {
  code?: string | number;
  killed?: boolean;
  stderr?: string;
  stdout?: string;
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
  options: ExecFileOptionsWithStringEncoding,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout: stdout, stderr: stderr });
      }
    });
  });
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
