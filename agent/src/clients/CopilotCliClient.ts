import { extractJsonlString } from "./CliOutput";
import { BaseCliAgent } from "./BaseCliAgent";

// GitHub Copilot CLI (https://docs.github.com/copilot/concepts/agents/about-copilot-cli):
// a headless run streams JSONL events and the final assistant reply is the
// last event carrying the response text. Authentication relies on the
// GitHub token already provided to the agent (GH_TOKEN); the usage metric
// is not reported by the CLI.
export class CopilotCliClient extends BaseCliAgent {
  readonly name = "copilot-cli";
  readonly displayName = "Copilot";
  readonly authHint =
    "Ensure GH_TOKEN is set to a GitHub token with a Copilot subscription";

  protected cliCommand(): string {
    return this.config.COPILOT_CLI;
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
    args.push("--output-format", "json", "--yolo");
    return args;
  }

  protected parseReply(result: { stdout: string; stderr: string }): string | null {
    return extractJsonlString(result.stdout, [
      "response",
      "result",
      "content",
      "text",
      "message",
    ]);
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
    return "Copilot usage";
  }
}
