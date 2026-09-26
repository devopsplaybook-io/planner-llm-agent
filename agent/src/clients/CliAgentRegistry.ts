import { CLI_AGENT_NAMES, Config } from "../Config";
import type { AgentActionsConfig } from "../AgentActions";
import { CliAgentClient } from "./CliAgent";
import { ClaudeCodeClient } from "./ClaudeCodeClient";
import { CodexClient } from "./CodexClient";
import { CopilotCliClient } from "./CopilotCliClient";
import { GeminiClient } from "./GeminiClient";
import { QoderClient } from "./QoderClient";

/**
 * Creates the requested CLI agent client. The value is matched
 * case-insensitively; an unknown value throws so a misconfiguration fails
 * fast at startup.
 */
export function createCliAgent(
  config: Config,
  agentActions?: AgentActionsConfig | null,
  agentName: string = config.AGENT_CLI,
): CliAgentClient {
  const selector = agentName.trim().toLowerCase();
  const defaultAgent = (
    agentActions?.defaultAgent || config.AGENT_CLI
  ).trim().toLowerCase();
  const clientActions =
    agentActions && selector !== defaultAgent
      ? { ...agentActions, defaultModel: "" }
      : agentActions;
  switch (selector) {
    case "qoder":
      return new QoderClient(config, clientActions);
    case "claude-code":
      return new ClaudeCodeClient(config, clientActions);
    case "copilot-cli":
      return new CopilotCliClient(config, clientActions);
    case "codex":
      return new CodexClient(config, clientActions);
    case "gemini-cli":
      return new GeminiClient(config, clientActions);
    default:
      throw new Error(
        `Agent '${agentName}' is not supported (supported CLIs: ${CLI_AGENT_NAMES.join(", ")})`,
      );
  }
}
