import * as fse from "fs-extra";
import * as path from "path";
import { Config, githubTokenEnvName } from "./Config";
import { getAgentConfigContentPath } from "./AgentConfigRepository";
import { ExecFileError, extractErrorDetail, runCli } from "./CliUtils";
import { OTelLogger, OTelTracer } from "./OTelContext";
import { PlannerTask } from "./PlannerClient";

const logger = OTelLogger().createModuleLogger("qoder-client");

const AUTH_CHECK_TIMEOUT_MS = 120000;
const PROMPT_TIMEOUT_MS = 600000;
const PROBE_PROMPT = "Reply with exactly: OK";

// Task execution options coming from the matching action of the agent
// actions configuration: the model is the action model or the configured
// default model, and the instruction is prepended to the task information.
export interface TaskOptions {
  model?: string;
  instruction?: string;
}

export class QoderClient {
  private config: Config;
  // Models available to the Qoder account, fetched once from the CLI and
  // cached for the lifetime of the client (undefined until the first fetch).
  private availableModels: string[] | undefined;

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
    // Capture the account credit balance reported by the probe so the first
    // task can display the "before" value.
    const credits = extractCredits(result.stdout);
    if (credits !== null) {
      await writeCredits(this.config, credits);
      logger.info(`Qoder credits at startup: ${formatCredits(credits)}`);
    }
  }

  public async performTask(
    task: PlannerTask,
    notesFile: string,
    options?: TaskOptions,
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
      ];
      const instruction = options?.instruction?.trim();
      if (instruction) {
        // The instruction comes on top of the task information: it refines
        // how the task documented in the notes file must be executed.
        promptLines.push(
          "Instructions for this task (apply them on top of the task information):",
          instruction,
        );
      }
      promptLines.push(
        `Task documentation file: ${notesFile}`,
        "Read the documentation file first: it contains the task description and all comments.",
        "Git and the GitHub CLI (gh) are already configured with authentication for Git and GitHub operations.",
      );
      const githubTokenEntries = this.config.githubTokenEntries();
      if (githubTokenEntries.length > 0) {
        promptLines.push(
          "The default GH_TOKEN does not necessarily have the rights for every GitHub organization.",
          'Dedicated tokens are available per organization: for gh operations on repositories of an organization listed below, prefix the command with its token variable, e.g. GH_TOKEN="$GH_TOKEN_MY_ORG" gh pr create.',
          `Organizations and token variables: ${githubTokenEntries
            .map(
              (entry) =>
                `${entry.organization} -> ${githubTokenEnvName(entry.organization)}`,
            )
            .join(", ")}.`,
        );
      }
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
      // The model of the matching action (or the configured default model)
      // replaces the QODER_MODEL fallback; the task description still takes
      // priority over both.
      const actionModel = options?.model?.trim() ?? "";
      const model = resolveModel(
        task,
        actionModel.length > 0 ? actionModel : this.config.QODER_MODEL,
      );
      if (model !== null) {
        logger.info(`Qoder model: ${model.model} (from ${model.source})`);
        await this.warnIfModelInvalid(model.model);
        args.push("--model", model.model);
      }
      args.push(
        "--output-format",
        "json",
        "--permission-mode",
        "bypass_permissions",
      );
      const creditsBefore = await readCredits(this.config);
      logger.info(`Qoder credits before task: ${formatCredits(creditsBefore)}`);
      // The task timeout is configurable (TASK_TIMEOUT, in seconds) so
      // long-running tasks are not cut off by a hardcoded limit.
      const result = await runCli(this.config.QODER_CLI, args, {
        timeout: this.config.TASK_TIMEOUT * 1000,
        windowsHide: true,
        cwd: path.dirname(notesFile),
        maxBuffer: 10 * 1024 * 1024,
      });
      const creditsAfter = extractCredits(result.stdout);
      if (creditsAfter !== null) {
        await writeCredits(this.config, creditsAfter);
      }
      logger.info(`Qoder credits after task: ${formatCredits(creditsAfter)}`);
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
        const emptyFooter = buildFooter(model, creditsBefore, creditsAfter);
        return emptyFooter.length > 0
          ? emptyFooter
          : "Task executed (no output returned by Qoder)";
      }
      logger.info(
        `Qoder summary captured from ${source} (${summary.length} chars)`,
      );
      const footer = buildFooter(model, creditsBefore, creditsAfter);
      return footer.length > 0 ? `${summary}\n\n${footer}` : summary;
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
          `Qoder task execution timed out after ${this.config.TASK_TIMEOUT} seconds`,
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

  // The models available to the Qoder account, listed once by the CLI and
  // cached for the lifetime of the client. Returns null when the list
  // cannot be obtained: the model validation is best-effort and is then
  // skipped.
  public async listModels(): Promise<string[] | null> {
    if (this.availableModels !== undefined) {
      return this.availableModels;
    }
    try {
      const result = await runCli(this.config.QODER_CLI, ["--list-models"], {
        timeout: AUTH_CHECK_TIMEOUT_MS,
        windowsHide: true,
      });
      const models = parseModelList(result.stdout);
      if (models.length === 0) {
        return null;
      }
      this.availableModels = models;
      return models;
    } catch {
      // A failed listing only disables the validation for this call.
      return null;
    }
  }

  // When a task starts, the resolved model is checked against the models
  // available to the account: a typo in the configuration would otherwise
  // only surface as an obscure CLI failure during the task. The task still
  // runs: the CLI remains the authority on what it can execute.
  private async warnIfModelInvalid(model: string): Promise<void> {
    const models = await this.listModels();
    if (models === null) {
      return;
    }
    const known = models.some(
      (entry) => entry.toLowerCase() === model.toLowerCase(),
    );
    if (!known) {
      logger.warn(
        `Task model '${model}' is not available to this Qoder account (available models: ${models.join(", ")})`,
      );
    }
  }

  // Run a standalone prompt through the qoder CLI and return the reply text.
  // Used for content generation outside of task execution.
  public async runPrompt(prompt: string): Promise<string> {
    const span = OTelTracer().startSpan("qoder-client.run-prompt");
    const args = ["-p", prompt];
    if (this.config.QODER_MODEL.trim().length > 0) {
      args.push("--model", this.config.QODER_MODEL.trim());
    }
    args.push(
      "--output-format",
      "json",
      "--permission-mode",
      "bypass_permissions",
    );
    try {
      const creditsBefore = await readCredits(this.config);
      logger.info(
        `Qoder credits before prompt: ${formatCredits(creditsBefore)}`,
      );
      const result = await runCli(this.config.QODER_CLI, args, {
        timeout: PROMPT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });
      const creditsAfter = extractCredits(result.stdout);
      if (creditsAfter !== null) {
        await writeCredits(this.config, creditsAfter);
      }
      logger.info(`Qoder credits after prompt: ${formatCredits(creditsAfter)}`);
      const reply = extractJsonResponse(result.stdout);
      if (reply !== null && reply.length > 0) {
        return reply;
      }
      return result.stdout.trim();
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
          `Qoder prompt timed out after ${PROMPT_TIMEOUT_MS / 1000} seconds`,
          { cause: error },
        );
      }
      throw new Error(
        `Qoder prompt failed:\n${extractErrorDetail(execError)}`,
        {
          cause: error,
        },
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

// The CLI lists the available models as plain lines after a 'MODEL' header.
function parseModelList(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.toLowerCase() !== "model");
}

// The qoder account credit balance is persisted so each task can display
// the balance before and after its execution.
function getCreditsFile(config: Config): string {
  return path.join(config.DATA_DIR, "qoder-credits.json");
}

export async function readCredits(config: Config): Promise<number | null> {
  try {
    const content = await fse.readJson(getCreditsFile(config));
    const credits = content?.credits;
    return typeof credits === "number" && Number.isFinite(credits)
      ? credits
      : null;
  } catch {
    return null;
  }
}

async function writeCredits(config: Config, credits: number): Promise<void> {
  try {
    await fse.outputJson(getCreditsFile(config), { credits });
  } catch {
    // Non-fatal: the credits display is best-effort.
  }
}

function formatCredits(credits: number | null): string {
  return credits !== null ? credits.toFixed(2) : "unknown";
}

// The footer appended to every task comment displays the model used and the
// qoder account credits before and after the task execution.
function buildFooter(
  model: { model: string; source: string } | null,
  creditsBefore: number | null,
  creditsAfter: number | null,
): string {
  const creditsKnown = creditsBefore !== null || creditsAfter !== null;
  if (model === null && !creditsKnown) {
    return "";
  }
  const parts = [`Model: ${model !== null ? model.model : "auto"}`];
  if (creditsKnown) {
    parts.push(
      `Qoder credits: ${formatCredits(creditsBefore)} -> ${formatCredits(creditsAfter)}`,
    );
  }
  return `---\n${parts.join(" · ")}`;
}

function parseJsonEnvelope(stdout: string): Record<string, unknown> | null {
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
      const parsed: unknown = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function extractJsonResponse(stdout: string): string | null {
  const parsed = parseJsonEnvelope(stdout);
  if (parsed === null) {
    return null;
  }
  // The qoder CLI reports the reply in the 'result' field; 'response' is
  // kept for compatibility with older CLI versions.
  for (const field of ["result", "response"]) {
    const value = parsed[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function extractCredits(stdout: string): number | null {
  const parsed = parseJsonEnvelope(stdout);
  if (parsed === null) {
    return null;
  }
  const value = parsed.total_credits;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
