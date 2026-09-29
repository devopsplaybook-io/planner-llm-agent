import { extractEnvelopeString } from "./CliOutput";
import { BaseCliAgent } from "./BaseCliAgent";

// Gemini CLI (https://google-gemini.github.io/gemini-cli/docs/cli/headless.html):
// a headless run prints a JSON envelope whose 'response' field carries the
// reply. Authentication uses GEMINI_API_KEY or the OAuth login; the usage
// metric is not reported by the CLI.
export class GeminiClient extends BaseCliAgent {
  readonly name = "gemini-cli";
  readonly displayName = "Gemini";
  readonly authHint =
    "Ensure GEMINI_API_KEY is set or that the OAuth login is complete (gemini)";

  protected cliCommand(): string {
    return this.config.GEMINI_CLI;
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
    args.push("--output-format", "json", "--approval-mode", "yolo");
    return args;
  }

  protected parseReply(result: { stdout: string; stderr: string }): string | null {
    return extractEnvelopeString(result.stdout, ["response", "result"]);
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
    return "Gemini usage";
  }
}
