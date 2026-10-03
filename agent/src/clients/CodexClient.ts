import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import { BaseCliAgent } from "./BaseCliAgent";

// OpenAI Codex CLI (https://developers.openai.com/codex): 'codex exec' runs
// a non-interactive execution with full access and no approvals, and
// '--output-last-message' writes the final reply to a file. Authentication
// uses OPENAI_API_KEY or the ChatGPT login (codex login).
export class CodexClient extends BaseCliAgent {
  readonly name = "codex";
  readonly displayName = "Codex";
  readonly authHint =
    "Ensure OPENAI_API_KEY is set or that the ChatGPT authentication is complete (codex login)";

  // Counter making the reply file name unique per invocation: concurrent
  // invocations starting within the same millisecond must never share one
  // (the shared mutable file name was a race that could return the reply
  // of another run).
  private replyFileCounter = 0;

  protected cliCommand(): string {
    return this.config.CODEX_CLI;
  }

  protected buildAuthCheckArgs(probePrompt: string): string[] {
    return this.buildExecArgs(probePrompt, null, false);
  }

  protected buildPromptArgs(prompt: string, model: string | null): string[] {
    return this.buildExecArgs(prompt, model, true);
  }

  private buildExecArgs(
    prompt: string,
    model: string | null,
    captureLastMessage: boolean,
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
      args.push("--output-last-message", this.buildReplyFile());
    }
    args.push(prompt);
    return args;
  }

  private buildReplyFile(): string {
    this.replyFileCounter++;
    return path.join(
      os.tmpdir(),
      `codex-last-message-${process.pid}-${Date.now()}-${this.replyFileCounter}.txt`,
    );
  }

  // The reply file of the current invocation is located from the invocation
  // arguments (never from instance state, which concurrent runs would race
  // on).
  private replyFileOf(args?: string[]): string | null {
    if (!args) {
      return null;
    }
    const index = args.indexOf("--output-last-message");
    return index !== -1 && index + 1 < args.length ? args[index + 1] : null;
  }

  protected parseReply(
    result: { stdout: string; stderr: string },
    args?: string[],
  ): string | null {
    const replyFile = this.replyFileOf(args);
    if (replyFile !== null) {
      try {
        const reply = fse.readFileSync(replyFile, "utf8").trim();
        if (reply.length > 0) {
          return reply;
        }
      } catch {
        // Fall back to the raw output when the file is missing.
      }
    }
    const trimmed = result.stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  // Removes the reply file of the settled invocation: per-invocation names
  // would otherwise accumulate in the temp directory.
  protected onInvocationSettled(args: string[]): void {
    const replyFile = this.replyFileOf(args);
    if (replyFile !== null) {
      fse.remove(replyFile).catch(() => undefined);
    }
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
