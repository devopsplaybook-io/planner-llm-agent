import * as fse from "fs-extra";
import * as path from "path";
import type { AgentActionsConfig } from "../AgentActions";
import { getAgentConfigContentPath } from "../AgentConfigRepository";
import { Config, githubTokenEnvName } from "../Config";
import { ExecFileError, extractErrorDetail, runCli, RunCliOptions } from "../CliUtils";
import { OTelLogger, OTelTracer } from "../OTelContext";
import type { PlannerTask } from "../PlannerClient";
import { CliAgentClient, PromptOptions, TaskOptions } from "./CliAgent";

const logger = OTelLogger().createModuleLogger("cli-agent");

const AUTH_CHECK_TIMEOUT_MS = 120000;
const PROMPT_TIMEOUT_MS = 600000;
export const PROBE_PROMPT = "Reply with exactly: OK";

const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * CLI-agnostic implementation of a coding-agent client: task prompt
 * composition, model resolution, summary capture, footer building and usage
 * persistence. The concrete adapters only describe how their CLI is invoked
 * (command, arguments, output parsing).
 */
export abstract class BaseCliAgent implements CliAgentClient {
  protected config: Config;
  protected agentActions: AgentActionsConfig | null;
  // Models available to the account, fetched once from the CLI and cached
  // for the lifetime of the client (undefined until the first fetch).
  private availableModels: string[] | undefined;

  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly authHint: string;

  // The constructor stays public: the abstract class cannot be
  // instantiated directly and the adapters re-expose it.
  constructor(config: Config, agentActions?: AgentActionsConfig | null) {
    this.config = config;
    this.agentActions = agentActions ?? null;
  }

  // The CLI command invoked for every request.
  protected abstract cliCommand(): string;

  // Arguments of the startup authentication probe (the probe prompt is
  // provided by the caller so every adapter checks the same thing).
  protected abstract buildAuthCheckArgs(probePrompt: string): string[];

  // Arguments of a headless prompt with the resolved model (null runs the
  // CLI with its own default model).
  protected abstract buildPromptArgs(
    prompt: string,
    model: string | null,
  ): string[];

  // Reply extraction from the CLI output; null when no reply can be parsed
  // (the caller falls back to the raw stdout).
  protected abstract parseReply(result: {
    stdout: string;
    stderr: string;
  }): string | null;

  // Usage metric reported by this run (credits balance, cost, ...); null
  // when the CLI does not report one.
  protected abstract extractUsage(stdout: string): number | null;

  // Label of the usage metric in logs and in the task footer.
  protected abstract usageLabel(): string;

  // Arguments listing the models available to the account, or null when
  // the CLI has no model listing (validation is then skipped).
  protected abstract buildListModelArgs(): string[] | null;

  // Parses the model listing output into model names.
  protected abstract parseModelList(stdout: string): string[];

  // File persisting the usage metric between runs.
  protected usageFilePath(): string {
    return path.join(this.config.DATA_DIR, `${this.name}-usage.json`);
  }

  public async readUsage(): Promise<number | null> {
    try {
      const content = await fse.readJson(this.usageFilePath());
      const usage = content?.usage;
      return typeof usage === "number" && Number.isFinite(usage)
        ? usage
        : null;
    } catch {
      return null;
    }
  }

  protected async writeUsage(usage: number): Promise<void> {
    try {
      await fse.outputJson(this.usageFilePath(), { usage });
    } catch {
      // Non-fatal: the usage display is best-effort.
    }
  }

  public async usageSummary(): Promise<string> {
    const usage = await this.readUsage();
    return usage !== null
      ? `${this.usageLabel()}: ${this.formatUsage(usage)}`
      : `${this.usageLabel()} not reported by the CLI`;
  }

  protected formatUsage(usage: number): string {
    return usage.toFixed(2);
  }

  // The actions default.model is the only configurable default model; an
  // empty string means the CLI default model is used.
  protected defaultModel(): string {
    return this.agentActions?.defaultModel ?? "";
  }

  public async checkAuthentication(): Promise<void> {
    const span = OTelTracer().startSpan(`${this.name}-client.check-authentication`);
    // Apply the default model to the probe too, so a misconfigured model
    // fails fast at startup instead of on the first task.
    const args = this.buildAuthCheckArgs(PROBE_PROMPT);
    try {
      const result = await this.runAgentCli(args, {
        timeout: AUTH_CHECK_TIMEOUT_MS,
        windowsHide: true,
        killProcessGroup: true,
      }, "authentication check");
      // A zero exit code is not enough: verify that the probe actually
      // produced a reply so an empty-output CLI fails visibly at startup.
      const reply = this.parseReply(result) ?? result.stdout;
      if (!reply.includes("OK")) {
        throw new Error(
          `${this.displayName} authentication probe did not return the expected reply. CLI output:\n${formatCliOutput(result)}`,
        );
      }
      // Capture the usage metric reported by the probe so the first task
      // can display the "before" value.
      const usage = this.extractUsage(result.stdout);
      if (usage !== null) {
        await this.writeUsage(usage);
        logger.info(
          `${this.usageLabel()} at startup: ${this.formatUsage(usage)}`,
        );
      }
    } finally {
      span.end();
    }
  }

  public async performTask(
    task: PlannerTask,
    notesFile: string,
    options?: TaskOptions,
  ): Promise<string> {
    const span = OTelTracer().startSpan(`${this.name}-client.perform-task`);
    // Every task runs in its own working directory (provided by the caller)
    // so parallel tasks never share one and cannot collide on the
    // filesystem; the notes file directory is the fallback.
    const workingDir = options?.cwd ?? path.dirname(notesFile);
    const summaryFile = getSummaryFile(notesFile);
    try {
      // Remove any summary file left over from a previous run so only the
      // output of this run is picked up.
      try {
        await fse.remove(summaryFile);
      } catch {
        // Non-fatal: the CLI overwrites the file anyway.
      }
      const prompt = this.buildTaskPrompt(notesFile, workingDir, options);
      // The model of the matching action or the actions default model; the
      // task description still takes priority over both.
      const model = resolveModel(task, options?.model?.trim() ?? "");
      if (model !== null) {
        logger.info(
          `${this.displayName} model: ${model.model} (from ${model.source})`,
        );
        await this.warnIfModelInvalid(model.model);
      }
      const args = this.buildPromptArgs(prompt, model?.model ?? null);
      const usageBefore = await this.readUsage();
      logger.info(
        `${this.usageLabel()} before task: ${formatUsageValue(usageBefore)}`,
      );
      // The task timeout is configurable (per-action timeout, then the
      // actions default.timeout, then the global TASK_TIMEOUT, in seconds)
      // so long-running tasks are not cut off by a hardcoded limit.
      const result = await this.runAgentCli(
        args,
        {
          timeout:
            (options?.timeoutSeconds ?? this.config.TASK_TIMEOUT) * 1000,
          windowsHide: true,
          cwd: workingDir,
          maxBuffer: MAX_BUFFER_BYTES,
          killProcessGroup: true,
        },
        "task execution",
      );
      const usageAfter = this.extractUsage(result.stdout);
      if (usageAfter !== null) {
        await this.writeUsage(usageAfter);
      }
      logger.info(
        `${this.usageLabel()} after task: ${formatUsageValue(usageAfter)}`,
      );
      // Prefer the summary file the CLI was asked to write, then the parsed
      // reply, then the raw stdout as a last resort.
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
        const reply = this.parseReply(result);
        if (reply !== null && reply.length > 0) {
          summary = reply;
          source = "cli reply";
        } else {
          summary = result.stdout.trim();
          source = summary.length > 0 ? "stdout" : "";
        }
      }
      if (summary.length === 0) {
        logger.error(
          `${this.displayName} produced no summary (stdout: ${result.stdout.length} chars, stderr: ${result.stderr.length} chars)`,
        );
        if (result.stdout.trim().length > 0) {
          logger.error(
            `${this.displayName} stdout: ${result.stdout.trim().slice(0, 500)}`,
          );
        }
        if (result.stderr.trim().length > 0) {
          logger.error(
            `${this.displayName} stderr: ${result.stderr.trim().slice(0, 500)}`,
          );
        }
        const emptyFooter = this.buildFooter(model, usageBefore, usageAfter);
        return emptyFooter.length > 0
          ? emptyFooter
          : `Task executed (no output returned by ${this.displayName})`;
      }
      logger.info(
        `${this.displayName} summary captured from ${source} (${summary.length} chars)`,
      );
      const footer = this.buildFooter(model, usageBefore, usageAfter);
      return footer.length > 0 ? `${summary}\n\n${footer}` : summary;
    } finally {
      span.end();
    }
  }

  // Run a standalone prompt through the CLI and return the reply text.
  // Used for content generation outside of task execution (agent note,
  // utility-model evaluations, ...). The model defaults to the actions
  // default model and the timeout to the prompt timeout.
  public async runPrompt(
    prompt: string,
    options?: PromptOptions,
  ): Promise<string> {
    const span = OTelTracer().startSpan(`${this.name}-client.run-prompt`);
    const model = options?.model?.trim() || this.defaultModel();
    const args = this.buildPromptArgs(
      prompt,
      model.length > 0 ? model : null,
    );
    const timeoutMs = options?.timeoutMs ?? PROMPT_TIMEOUT_MS;
    try {
      const usageBefore = await this.readUsage();
      logger.info(
        `${this.usageLabel()} before prompt: ${formatUsageValue(usageBefore)}`,
      );
      const result = await this.runAgentCli(args, {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: MAX_BUFFER_BYTES,
        killProcessGroup: true,
      }, "prompt");
      const usageAfter = this.extractUsage(result.stdout);
      if (usageAfter !== null) {
        await this.writeUsage(usageAfter);
      }
      logger.info(
        `${this.usageLabel()} after prompt: ${formatUsageValue(usageAfter)}`,
      );
      const reply = this.parseReply(result);
      if (reply !== null && reply.length > 0) {
        return reply;
      }
      return result.stdout.trim();
    } finally {
      span.end();
    }
  }

  // The models available to the account, listed once by the CLI and
  // cached for the lifetime of the client. Returns null when the list
  // cannot be obtained or the CLI has no listing: the model validation is
  // best-effort and is then skipped.
  public async listModels(): Promise<string[] | null> {
    if (this.availableModels !== undefined) {
      return this.availableModels;
    }
    const args = this.buildListModelArgs();
    if (args === null) {
      return null;
    }
    try {
      const result = await runCli(this.cliCommand(), args, {
        timeout: AUTH_CHECK_TIMEOUT_MS,
        windowsHide: true,
        killProcessGroup: true,
      });
      const models = this.parseModelList(result.stdout);
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
        `Task model '${model}' is not available to this ${this.displayName} account (available models: ${models.join(", ")})`,
      );
    }
  }

  private async runAgentCli(
    args: string[],
    options: RunCliOptions,
    action: string,
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      return await runCli(this.cliCommand(), args, options);
    } catch (error) {
      const execError = error as ExecFileError;
      if (execError.code === "ENOENT") {
        throw new Error(
          `${this.displayName} CLI '${this.cliCommand()}' not found in PATH`,
          { cause: error },
        );
      }
      if (execError.killed) {
        throw new Error(
          `${this.displayName} ${action} timed out after ${Math.round((options.timeout ?? 0) / 1000)} seconds`,
          { cause: error },
        );
      }
      throw new Error(
        `${this.displayName} ${action} failed:\n${extractErrorDetail(execError)}`,
        { cause: error },
      );
    }
  }

  // The footer appended to every task comment displays the model used and
  // the usage metric before and after the task execution.
  protected buildFooter(
    model: { model: string; source: string } | null,
    usageBefore: number | null,
    usageAfter: number | null,
  ): string {
    const usage = this.usageFooter(usageBefore, usageAfter);
    if (model === null && usage === null) {
      return "";
    }
    const parts = [`Model: ${model !== null ? model.model : "auto"}`];
    if (usage !== null) {
      parts.push(usage);
    }
    return `---\n${parts.join(" · ")}`;
  }

  protected usageFooter(
    usageBefore: number | null,
    usageAfter: number | null,
  ): string | null {
    if (usageBefore === null && usageAfter === null) {
      return null;
    }
    return `${this.usageLabel()}: ${formatUsageValue(usageBefore)} -> ${formatUsageValue(usageAfter)}`;
  }

  private buildTaskPrompt(
    notesFile: string,
    workingDir: string,
    options?: TaskOptions,
  ): string {
    const summaryFile = getSummaryFile(notesFile);
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
      `Working directory: ${workingDir} (this task runs in its own working directory; create all task files there — other tasks may run in parallel in their own directories).`,
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
    return promptLines.join("\n");
  }
}

function getSummaryFile(notesFile: string): string {
  if (notesFile.endsWith("-Agent.md")) {
    return `${notesFile.slice(0, -"-Agent.md".length)}-Agent-Summary.md`;
  }
  return `${notesFile}-Summary.md`;
}

// The model is resolved with the task description taking priority over the
// configured default: a task can request a specific model with an
// 'agent-model: <model>' line in its description (the legacy
// 'qoder-model:' line is still accepted). Exported so the Agent can fill
// the running-task metadata with the model that will be used.
export function resolveModel(
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

export function extractTaskModel(description: string): string | null {
  const generic = description.match(/^\s*agent-model:\s*(\S+)/im);
  if (generic) {
    return generic[1];
  }
  const legacy = description.match(/^\s*qoder-model:\s*(\S+)/im);
  return legacy ? legacy[1] : null;
}

function formatUsageValue(usage: number | null): string {
  return usage !== null ? usage.toFixed(2) : "unknown";
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
