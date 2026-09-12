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

  // File receiving the final reply of the current run, set when the prompt
  // arguments are built and read when the reply is parsed.
  private lastMessageFile: string | null = null;

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
      this.lastMessageFile = path.join(
        os.tmpdir(),
        `codex-last-message-${process.pid}-${Date.now()}.txt`,
      );
      args.push("--output-last-message", this.lastMessageFile);
    }
    args.push(prompt);
    return args;
  }

  protected parseReply(result: {
    stdout: string;
    stderr: string;
  }): string | null {
    if (this.lastMessageFile !== null) {
      try {
        const reply = fse
          .readFileSync(this.lastMessageFile, "utf8")
          .trim();
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
