import * as fse from "fs-extra";
import * as path from "path";
import { Config } from "../Config";
import {
  extractEnvelopeNumber,
  extractEnvelopeString,
} from "./CliOutput";
import { BaseCliAgent } from "./BaseCliAgent";

// The credits consumed by the last run are persisted so each task can
// report the spend of the previous execution.
function getCreditsFile(config: Config): string {
  return path.join(config.DATA_DIR, "qoder-credits.json");
}

// The CLI lists the available models as plain lines after a 'MODEL' header.
function parseQoderModelList(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.toLowerCase() !== "model");
}

function extractJsonResponse(stdout: string): string | null {
  // The qoder CLI reports the reply in the 'result' field; 'response' is
  // kept for compatibility with older CLI versions.
  return extractEnvelopeString(stdout, ["result", "response"]);
}

function extractCredits(stdout: string): number | null {
  return extractEnvelopeNumber(stdout, "total_credits");
}

export class QoderClient extends BaseCliAgent {
  readonly name = "qoder";
  readonly displayName = "Qoder";
  readonly authHint =
    "Ensure QODER_PERSONAL_ACCESS_TOKEN is set to a valid Personal Access Token (https://qoder.com/account/integrations)";

  protected cliCommand(): string {
    return this.config.QODER_CLI;
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
      "bypass_permissions",
    );
    return args;
  }

  protected parseReply(result: { stdout: string; stderr: string }): string | null {
    return extractJsonResponse(result.stdout);
  }

  protected extractUsage(stdout: string): number | null {
    return extractCredits(stdout);
  }

  protected usageLabel(): string {
    return "Qoder credits";
  }

  protected buildListModelArgs(): string[] | null {
    return ["--list-models"];
  }

  protected parseModelList(stdout: string): string[] {
    return parseQoderModelList(stdout);
  }

  // The file keeps its legacy name and format so values persisted by
  // previous agent versions (last-run spends) stay readable.
  public async readUsage(): Promise<number | null> {
    try {
      const content = await fse.readJson(getCreditsFile(this.config));
      const credits = content?.credits;
      return typeof credits === "number" && Number.isFinite(credits)
        ? credits
        : null;
    } catch {
      return null;
    }
  }

  protected async writeUsage(credits: number): Promise<void> {
    try {
      await fse.outputJson(getCreditsFile(this.config), { credits });
    } catch {
      // Non-fatal: the credits display is best-effort.
    }
  }

  // The CLI reports the credits consumed by the run itself, not a remaining
  // balance: the footer only displays the value of the current run.
  protected usageFooter(
    _usageBefore: number | null,
    usageAfter: number | null,
  ): string | null {
    return usageAfter !== null
      ? `Qoder credits used: ${this.formatUsage(usageAfter)}`
      : null;
  }

  public async usageSummary(): Promise<string> {
    const credits = await this.readUsage();
    return credits !== null
      ? `Qoder credits used by the last run: ${this.formatUsage(credits)}`
      : "Qoder credits not reported by the CLI";
  }
}
