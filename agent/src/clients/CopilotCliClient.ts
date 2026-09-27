import { getAgentSkillsPath } from "../AgentConfigRepository";
import { ExecFileError, extractErrorDetail, runCli } from "../CliUtils";
import { OTelLogger } from "../OTelContext";
import { BaseCliAgent } from "./BaseCliAgent";

const logger = OTelLogger().createModuleLogger("copilot-cli");

const SKILL_ADD_TIMEOUT_MS = 30000;

// GitHub Copilot CLI (https://docs.github.com/copilot/concepts/agents/about-copilot-cli):
// a headless run prints only the final assistant reply with
// '--output-format text --silent' (the JSONL event stream of
// '--output-format json' can exceed the stdout buffer on long runs).
// Authentication relies on the GitHub token already provided to the agent
// (GH_TOKEN); the usage metric is not reported by the CLI.
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
    args.push("--output-format", "text", "--silent");
    return args;
  }

  protected buildPromptArgs(prompt: string, model: string | null): string[] {
    const args = ["-p", prompt];
    if (model !== null) {
      args.push("--model", model);
    }
    args.push("--output-format", "text", "--silent", "--yolo");
    return args;
  }

  protected parseReply(result: { stdout: string; stderr: string }): string | null {
    const reply = result.stdout.trim();
    return reply.length > 0 ? reply : null;
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

  // Registers the synced skills directory with the Copilot CLI: unlike the
  // other CLIs it does not discover the agent-config repository on its own,
  // so without this registration the model never sees the synced skills.
  // Best-effort: a failure is logged and the agent keeps running.
  public async prepare(): Promise<void> {
    if (this.config.AGENT_CONFIG_REPOSITORY.trim().length === 0) {
      return;
    }
    const skillsDir = getAgentSkillsPath(this.config);
    try {
      await runCli(this.cliCommand(), ["skill", "add", skillsDir], {
        timeout: SKILL_ADD_TIMEOUT_MS,
        windowsHide: true,
      });
      logger.info(`Copilot skills directory registered: ${skillsDir}`);
    } catch (error) {
      logger.warn(
        `Copilot skills directory registration failed (the skills stay usable through the task prompt): ${extractErrorDetail(error as ExecFileError)}`,
      );
    }
  }
}
