import { extractEnvelopeNumber, extractEnvelopeString } from "./CliOutput";
import { BaseCliAgent } from "./BaseCliAgent";

// Claude Code (https://code.claude.com/docs/en/headless): a headless run
// prints a JSON envelope whose 'result' field carries the reply and whose
// 'total_cost_usd' field carries the cost of the run. Authentication uses
// ANTHROPIC_API_KEY or a Claude OAuth token (CLAUDE_CODE_OAUTH_TOKEN).
export class ClaudeCodeClient extends BaseCliAgent {
  readonly name = "claude-code";
  readonly displayName = "Claude Code";
  readonly authHint =
    "Ensure ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is set to a valid credential";

  protected cliCommand(): string {
    return this.config.CLAUDE_CLI;
  }

  protected buildAuthCheckArgs(probePrompt: string): string[] {
    const args = ["-p", probePrompt];
    const defaultModel = this.defaultModel();
    if (defaultModel.length > 0) {
      args.push("--model", defaultModel);
    }
    args.push("--output-format", "json");
    return args;
  }

  protected buildPromptArgs(prompt: string, model: string | null): string[] {
    const args = ["-p", prompt];
    if (model !== null) {
      args.push("--model", model);
    }
    args.push(
      "--output-format",
      "json",
      "--permission-mode",
      "bypassPermissions",
    );
    return args;
  }

  protected parseReply(result: { stdout: string; stderr: string }): string | null {
    return extractEnvelopeString(result.stdout, ["result", "response"]);
  }

  protected extractUsage(stdout: string): number | null {
    return extractEnvelopeNumber(stdout, "total_cost_usd");
  }

  protected buildListModelArgs(): string[] | null {
    return null;
  }

  protected parseModelList(): string[] {
    return [];
  }

  protected usageLabel(): string {
    return "Claude cost";
  }

  protected formatUsage(usage: number): string {
    return `$${usage.toFixed(2)}`;
  }

  // The cost is the cost of the run itself, not a remaining balance: the
  // footer only displays the value of the current run.
  protected usageFooter(
    _usageBefore: number | null,
    usageAfter: number | null,
  ): string | null {
    return usageAfter !== null
      ? `${this.usageLabel()}: ${this.formatUsage(usageAfter)}`
      : null;
  }

  public async usageSummary(): Promise<string> {
    const usage = await this.readUsage();
    return usage !== null
      ? `Claude cost of the last run: ${this.formatUsage(usage)}`
      : "Claude cost not reported by the CLI";
  }
}
