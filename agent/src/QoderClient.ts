import { execFile } from "child_process";
import type { ExecFileOptionsWithStringEncoding } from "child_process";
import * as fse from "fs-extra";
import * as path from "path";
import { Config } from "./Config";
import { OTelTracer } from "./OTelContext";
import { PlannerTask } from "./PlannerClient";

const AUTH_CHECK_TIMEOUT_MS = 120000;
const TASK_TIMEOUT_MS = 1800000;
const PROBE_PROMPT = "Reply with exactly: OK";

interface ExecFileError extends Error {
  code?: string | number;
  killed?: boolean;
  stderr?: string;
  stdout?: string;
}

export class QoderClient {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  public async checkAuthentication(): Promise<void> {
    const span = OTelTracer().startSpan("qoder-client.check-authentication");
    try {
      await runCli(
        this.config.QODER_CLI,
        ["-p", PROBE_PROMPT],
        { timeout: AUTH_CHECK_TIMEOUT_MS, windowsHide: true },
      );
    } catch (error) {
      const execError = error as ExecFileError;
      span.recordException(execError);
      if (execError.code === "ENOENT") {
        throw new Error(
          `Qoder CLI '${this.config.QODER_CLI}' not found in PATH`,
          { cause: error },
        );
      }
      if (execError.killed) {
        throw new Error(
          `Qoder authentication check timed out after ${AUTH_CHECK_TIMEOUT_MS / 1000} seconds`,
          { cause: error },
        );
      }
      throw new Error(
        `Qoder authentication check failed:\n${extractErrorDetail(execError)}`,
        { cause: error },
      );
    } finally {
      span.end();
    }
  }

  public async performTask(
    task: PlannerTask,
    notesFile: string,
  ): Promise<string> {
    const span = OTelTracer().startSpan("qoder-client.perform-task");
    const summaryFile = getSummaryFile(notesFile);
    try {
      // Remove any summary file left over from a previous run so only the
      // output of this run is picked up.
      try {
        await fse.remove(summaryFile);
      } catch {
        // Non-fatal: qoder overwrites the file anyway.
      }
      const prompt = [
        "You are an autonomous agent working on an assigned task.",
        `Task documentation file: ${notesFile}`,
        "Read the documentation file first: it contains the task description and all comments.",
        "1. Perform the task described in the documentation file.",
        '2. Keep the "Agent Notes" section of the documentation file updated with what you did and learned, so future runs know the state of the task.',
        `3. Write a concise summary of what has been done to the file: ${summaryFile}. The summary will be posted as a comment on the task.`,
      ].join("\n");
      const result = await runCli(
        this.config.QODER_CLI,
        ["-p", prompt],
        {
          timeout: TASK_TIMEOUT_MS,
          windowsHide: true,
          cwd: path.dirname(notesFile),
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      // Prefer the summary file qoder was asked to write; headless CLI
      // output on stdout is not reliable and is only a fallback.
      let summary = "";
      try {
        if (await fse.pathExists(summaryFile)) {
          summary = (await fse.readFile(summaryFile, "utf8")).trim();
          await fse.remove(summaryFile);
        }
      } catch {
        // Fall back to stdout when the summary file cannot be read.
      }
      if (summary.length === 0) {
        summary = result.stdout.trim();
      }
      return summary.length > 0
        ? summary
        : "Task executed (no output returned by Qoder)";
    } catch (error) {
      const execError = error as ExecFileError;
      span.recordException(execError);
      if (execError.code === "ENOENT") {
        throw new Error(
          `Qoder CLI '${this.config.QODER_CLI}' not found in PATH`,
          { cause: error },
        );
      }
      if (execError.killed) {
        throw new Error(
          `Qoder task execution timed out after ${TASK_TIMEOUT_MS / 1000} seconds`,
          { cause: error },
        );
      }
      throw new Error(
        `Qoder task execution failed:\n${extractErrorDetail(execError)}`,
        { cause: error },
      );
    } finally {
      span.end();
    }
  }
}

function getSummaryFile(notesFile: string): string {
  if (notesFile.endsWith("-Agent.md")) {
    return `${notesFile.slice(0, -"-Agent.md".length)}-Agent-Summary.md`;
  }
  return `${notesFile}-Summary.md`;
}

function runCli(
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

function extractErrorDetail(error: ExecFileError): string {
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
