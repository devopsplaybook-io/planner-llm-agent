import { CLI_AGENT_NAMES, Config } from "../Config";
import type { AgentActionsConfig } from "../AgentActions";
import { CliAgentClient } from "./CliAgent";
import { ClaudeCodeClient } from "./ClaudeCodeClient";
import { CodexClient } from "./CodexClient";
import { CopilotCliClient } from "./CopilotCliClient";
import { GeminiClient } from "./GeminiClient";
import { QoderClient } from "./QoderClient";

/**
 * Creates the CLI agent client selected by AGENT_CLI. The value is matched
 * case-insensitively; an unknown value throws so a misconfiguration fails
 * fast at startup.
 */
export function createCliAgent(
  config: Config,
  agentActions?: AgentActionsConfig | null,
): CliAgentClient {
  const selector = config.AGENT_CLI.trim().toLowerCase();
  switch (selector) {
    case "qoder":
      return new QoderClient(config, agentActions);
    case "claude-code":
      return new ClaudeCodeClient(config, agentActions);
    case "copilot-cli":
      return new CopilotCliClient(config, agentActions);
    case "codex":
      return new CodexClient(config, agentActions);
    case "gemini-cli":
      return new GeminiClient(config, agentActions);
    default:
      throw new Error(
        `AGENT_CLI '${config.AGENT_CLI}' is not supported (supported CLIs: ${CLI_AGENT_NAMES.join(", ")})`,
      );
  }
}
