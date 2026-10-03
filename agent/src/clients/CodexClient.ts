import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { BaseCliAgent, PromptInvocationContext } from "./BaseCliAgent";

// OpenAI Codex CLI (https://developers.openai.com/codex): 'codex exec' runs
// a non-interactive execution with full access and no approvals, and
// '--output-last-message' writes the final reply to a file. Authentication
// uses OPENAI_API_KEY or the ChatGPT login (codex login).
export class CodexClient extends BaseCliAgent {
  readonly name = "codex";
  readonly displayName = "Codex";
  readonly authHint =
    "Ensure OPENAI_API_KEY is set or that the ChatGPT authentication is complete (codex login)";

  protected cliCommand(): string {
    return this.config.CODEX_CLI;
  }

  protected buildAuthCheckArgs(
    probePrompt: string,
    context: PromptInvocationContext,
  ): string[] {
    return this.buildExecArgs(probePrompt, null, false, context);
  }

  protected buildPromptArgs(
    prompt: string,
    model: string | null,
    context: PromptInvocationContext,
  ): string[] {
    return this.buildExecArgs(prompt, model, true, context);
  }

  private buildExecArgs(
    prompt: string,
    model: string | null,
    captureLastMessage: boolean,
    context: PromptInvocationContext,
  ): string[] {
    const args = ["exec"];
    if (model !== null) {
      args.push("-m", model);
    }
    args.push(
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "never",
      // The task working directory is not a Git repository: skip the check
      // so the CLI does not refuse to run.
      "--skip-git-repo-check",
    );
    if (captureLastMessage) {
      // Per-invocation file stored on the invocation context (never on the
      // client instance): parallel tasks share one client and must not read
      // each other's reply.
      context.lastMessageFile = path.join(
        os.tmpdir(),
        `codex-last-message-${process.pid}-${randomUUID()}.txt`,
      );
      args.push("--output-last-message", context.lastMessageFile);
    }
    args.push(prompt);
    return args;
  }

  protected parseReply(
    result: {
      stdout: string;
      stderr: string;
    },
    context: PromptInvocationContext,
  ): string | null {
    const lastMessageFile = context.lastMessageFile;
    if (lastMessageFile !== undefined) {
      try {
        const reply = fse.readFileSync(lastMessageFile, "utf8").trim();
        if (reply.length > 0) {
          return reply;
        }
      } catch {
        // Fall back to the raw output when the file is missing.
      } finally {
        try {
          // The file is read once per invocation: remove it immediately so
          // no temp file survives the run.
          fse.removeSync(lastMessageFile);
        } catch {
          // The base class removes it again once the run settles.
        }
      }
    }
    const trimmed = result.stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  protected extractUsage(): number | null {
    return null;
  }

  protected buildListModelArgs(): string[] | null {
    return null;
  }

  protected parseModelList(): string[] {
    return [];
  }

  protected usageLabel(): string {
    return "Codex usage";
  }
}
