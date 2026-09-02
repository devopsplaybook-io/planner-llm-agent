import { execFile } from "child_process";
import type { ExecFileOptionsWithStringEncoding } from "child_process";
import * as fse from "fs-extra";
import * as path from "path";
import { Config } from "./Config";
import { OTelLogger, OTelTracer } from "./OTelContext";
import { PlannerTask } from "./PlannerClient";

const logger = OTelLogger().createModuleLogger("qoder-client");

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
    let result: { stdout: string; stderr: string };
    try {
      result = await runCli(
        this.config.QODER_CLI,
        ["-p", PROBE_PROMPT, "--output-format", "json"],
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
    // A zero exit code is not enough: verify that the probe actually
    // produced a reply so an empty-output CLI fails visibly at startup.
    const reply = extractJsonResponse(result.stdout) ?? result.stdout;
    if (!reply.includes("OK")) {
      throw new Error(
        `Qoder authentication probe did not return the expected reply. CLI output:\n${formatCliOutput(result)}`,
      );
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
        [
          "-p",
          prompt,
          "--output-format",
          "json",
          "--permission-mode",
          "bypass_permissions",
        ],
        {
          timeout: TASK_TIMEOUT_MS,
          windowsHide: true,
          cwd: path.dirname(notesFile),
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      // Prefer the summary file qoder was asked to write, then the JSON
      // response field, then the raw stdout as a last resort.
      let summary = "";
      let source = "";
      try {
        if (await fse.pathExists(summaryFile)) {
          summary = (await fse.readFile(summaryFile, "utf8")).trim();
          await fse.remove(summaryFile);
          source = "summary file";
        }
      } catch {
        // Fall back to the CLI output when the file cannot be read.
      }
      if (summary.length === 0) {
        const jsonResponse = extractJsonResponse(result.stdout);
        if (jsonResponse !== null && jsonResponse.length > 0) {
          summary = jsonResponse;
          source = "json response";
        } else {
          summary = result.stdout.trim();
          source = summary.length > 0 ? "stdout" : "";
        }
      }
      if (summary.length === 0) {
        logger.error(
          `Qoder produced no summary (stdout: ${result.stdout.length} chars, stderr: ${result.stderr.length} chars)`,
        );
        if (result.stdout.trim().length > 0) {
          logger.error(`Qoder stdout: ${result.stdout.trim().slice(0, 500)}`);
        }
        if (result.stderr.trim().length > 0) {
          logger.error(`Qoder stderr: ${result.stderr.trim().slice(0, 500)}`);
        }
        return "Task executed (no output returned by Qoder)";
      }
      logger.info(
        `Qoder summary captured from ${source} (${summary.length} chars)`,
      );
      return summary;
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

function extractJsonResponse(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as { response?: unknown };
    if (typeof parsed.response === "string") {
      return parsed.response.trim();
    }
    return null;
  } catch {
    // Not JSON - treat the output as plain text.
    return null;
  }
}

function formatCliOutput(result: { stdout: string; stderr: string }): string {
  const parts: string[] = [];
  if (result.stdout.trim().length > 0) {
    parts.push(`stdout: ${result.stdout.trim().slice(0, 500)}`);
  }
  if (result.stderr.trim().length > 0) {
    parts.push(`stderr: ${result.stderr.trim().slice(0, 500)}`);
  }
  return parts.length > 0 ? parts.join("\n") : "(no output)";
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
