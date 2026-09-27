import type { AgentSessionTokens } from "../AgentSessionMetrics";
import {
  extractEnvelopeObject,
  extractEnvelopeString,
  tokenCount,
} from "./CliOutput";
import { BaseCliAgent } from "./BaseCliAgent";

// Token counts of one model of the run stats; null when the model reports
// none. 'input' is the non-cached prompt count (the 'prompt' total minus
// 'cached'); older CLI versions only report 'prompt'.
function modelTokens(model: unknown): AgentSessionTokens | null {
  if (model === null || typeof model !== "object" || Array.isArray(model)) {
    return null;
  }
  const rawTokens = (model as Record<string, unknown>)["tokens"];
  if (
    rawTokens === null ||
    typeof rawTokens !== "object" ||
    Array.isArray(rawTokens)
  ) {
    return null;
  }
  const counts = rawTokens as Record<string, unknown>;
  const input = tokenCount(counts["input"]) ?? tokenCount(counts["prompt"]);
  const candidates = tokenCount(counts["candidates"]);
  const thoughts = tokenCount(counts["thoughts"]);
  const cacheRead = tokenCount(counts["cached"]);
  const tokens: AgentSessionTokens = {};
  if (input !== undefined) {
    tokens.input = input;
  }
  if (candidates !== undefined || thoughts !== undefined) {
    tokens.output = (candidates ?? 0) + (thoughts ?? 0);
  }
  if (cacheRead !== undefined) {
    tokens.cacheRead = cacheRead;
  }
  return Object.keys(tokens).length > 0 ? tokens : null;
}

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

  // The run stats aggregate the token counts of every model used by the
  // session ('stats.models.*.tokens').
  protected extractTokenUsage(stdout: string): AgentSessionTokens | null {
    const stats = extractEnvelopeObject(stdout, "stats");
    const models = stats !== null ? stats["models"] : null;
    if (models === null || typeof models !== "object" || Array.isArray(models)) {
      return null;
    }
    const tokens: AgentSessionTokens = {};
    for (const model of Object.values(models as Record<string, unknown>)) {
      const counts = modelTokens(model);
      if (counts === null) {
        continue;
      }
      if (counts.input !== undefined) {
        tokens.input = (tokens.input ?? 0) + counts.input;
      }
      if (counts.output !== undefined) {
        tokens.output = (tokens.output ?? 0) + counts.output;
      }
      if (counts.cacheRead !== undefined) {
        tokens.cacheRead = (tokens.cacheRead ?? 0) + counts.cacheRead;
      }
    }
    return Object.keys(tokens).length > 0 ? tokens : null;
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
