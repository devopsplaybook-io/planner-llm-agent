import * as fse from "fs-extra";
import * as path from "path";
import { Config } from "./Config";
import { getAgentConfigContentPath } from "./AgentConfigRepository";
import { ExecFileError, extractErrorDetail, runCli } from "./CliUtils";
import { OTelLogger, OTelTracer } from "./OTelContext";
import { PlannerTask } from "./PlannerClient";

const logger = OTelLogger().createModuleLogger("qoder-client");

const AUTH_CHECK_TIMEOUT_MS = 120000;
const TASK_TIMEOUT_MS = 1800000;
const PROBE_PROMPT = "Reply with exactly: OK";

export class QoderClient {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  public async checkAuthentication(): Promise<void> {
    const span = OTelTracer().startSpan("qoder-client.check-authentication");
    let result: { stdout: string; stderr: string };
    // Apply the default model to the probe too, so a misconfigured model
    // fails fast at startup instead of on the first task.
    const args = ["-p", PROBE_PROMPT];
    if (this.config.QODER_MODEL.trim().length > 0) {
      args.push("--model", this.config.QODER_MODEL.trim());
    }
    args.push("--output-format", "json");
    try {
      result = await runCli(this.config.QODER_CLI, args, {
        timeout: AUTH_CHECK_TIMEOUT_MS,
        windowsHide: true,
      });
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
      const promptLines = [
        "You are an autonomous agent working on an assigned task.",
        `Task documentation file: ${notesFile}`,
        "Read the documentation file first: it contains the task description and all comments.",
        "Git and the GitHub CLI (gh) are already configured with authentication for Git and GitHub operations.",
      ];
      if (this.config.AGENT_CONFIG_REPOSITORY.trim().length > 0) {
        promptLines.push(
          `Agent configuration (skills, configuration files and other resources) is synced locally at: ${getAgentConfigContentPath(this.config)}. Use it whenever it is relevant to the task.`,
        );
      }
      promptLines.push(
        "1. Perform the task described in the documentation file.",
        '2. Keep the "Agent Notes" section of the documentation file updated with what you did and learned, so future runs know the state of the task.',
        `3. Write a concise summary of what has been done to the file: ${summaryFile}. The summary will be posted as a comment on the task.`,
      );
      const prompt = promptLines.join("\n");
      const args = ["-p", prompt];
      const model = resolveModel(task, this.config.QODER_MODEL);
      if (model !== null) {
        logger.info(`Qoder model: ${model.model} (from ${model.source})`);
        args.push("--model", model.model);
      }
      args.push(
        "--output-format",
        "json",
        "--permission-mode",
        "bypass_permissions",
      );
      const result = await runCli(this.config.QODER_CLI, args, {
        timeout: TASK_TIMEOUT_MS,
        windowsHide: true,
        cwd: path.dirname(notesFile),
        maxBuffer: 10 * 1024 * 1024,
      });
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

// The model is resolved with the task description taking priority over the
// configured default: a task can request a specific model with a
// 'qoder-model: <model>' line in its description.
function resolveModel(
  task: PlannerTask,
  defaultModel: string,
): { model: string; source: string } | null {
  const fromTask = extractTaskModel(task.description);
  if (fromTask !== null) {
    return { model: fromTask, source: "task description" };
  }
  const trimmed = defaultModel.trim();
  if (trimmed.length > 0) {
    return { model: trimmed, source: "default" };
  }
  return null;
}

function extractTaskModel(description: string): string | null {
  const match = description.match(/^\s*qoder-model:\s*(\S+)/im);
  return match ? match[1] : null;
}

function extractJsonResponse(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed.includes("{")) {
    return null;
  }
  // The CLI may print extra lines around the JSON envelope, so also try the
  // slice between the outermost braces.
  const candidates = [trimmed];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(trimmed.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        result?: unknown;
        response?: unknown;
      };
      // The qoder CLI reports the reply in the 'result' field; 'response'
      // is kept for compatibility with older CLI versions.
      for (const field of ["result", "response"]) {
        const value = parsed[field];
        if (typeof value === "string" && value.trim().length > 0) {
          return value.trim();
        }
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
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
