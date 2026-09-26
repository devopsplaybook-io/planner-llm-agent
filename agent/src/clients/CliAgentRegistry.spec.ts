import { Config } from "../Config";
import { createCliAgent } from "./CliAgentRegistry";
import { ClaudeCodeClient } from "./ClaudeCodeClient";
import { CodexClient } from "./CodexClient";
import { CopilotCliClient } from "./CopilotCliClient";
import { GeminiClient } from "./GeminiClient";
import { QoderClient } from "./QoderClient";

jest.mock("../OTelContext", () => ({
  OTelTracer: jest.fn(() => ({
    startSpan: jest.fn(() => ({
      end: jest.fn(),
      setAttribute: jest.fn(),
      recordException: jest.fn(),
    })),
  })),
  OTelLogger: jest.fn(() => ({
    createModuleLogger: jest.fn(() => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    })),
  })),
}));

describe("CliAgentRegistry", () => {
  it("should create the Qoder client by default", () => {
    const config = new Config();
    expect(createCliAgent(config)).toBeInstanceOf(QoderClient);
  });

  it("should create the client matching the AGENT_CLI selector", () => {
    const cases: [string, unknown][] = [
      ["qoder", QoderClient],
      ["claude-code", ClaudeCodeClient],
      ["copilot-cli", CopilotCliClient],
      ["codex", CodexClient],
      ["gemini-cli", GeminiClient],
    ];
    for (const [selector, expected] of cases) {
      const config = new Config();
      config.AGENT_CLI = selector;
      expect(createCliAgent(config)).toBeInstanceOf(expected as never);
    }
  });

  it("should match the selector case-insensitively", () => {
    const config = new Config();
    config.AGENT_CLI = " Claude-Code ";
    expect(createCliAgent(config)).toBeInstanceOf(ClaudeCodeClient);
  });

  it("should allow an action to select a different CLI agent", () => {
    const config = new Config();
    config.AGENT_CLI = "qoder";

    expect(createCliAgent(config, null, "copilot-cli")).toBeInstanceOf(
      CopilotCliClient,
    );
  });

  it("should not apply the default agent model to another CLI", () => {
    const config = new Config();
    const actions = {
      defaultAgent: "qoder",
      defaultModel: "DeepSeek-Flash",
      defaultTimeout: null,
      actions: [],
    };
    const client = createCliAgent(config, actions, "copilot-cli") as
      | CopilotCliClient
      | QoderClient;
    const probeArgs = (
      client as unknown as {
        buildAuthCheckArgs: (prompt: string) => string[];
      }
    ).buildAuthCheckArgs("Reply with exactly: OK");

    expect(probeArgs).not.toContain("DeepSeek-Flash");
  });

  it("should pass the agent actions to the created client", () => {
    const config = new Config();
    const agentActions = {
      defaultModel: "claude-sonnet-4-5",
      defaultTimeout: null,
      actions: [],
    };
    const client = createCliAgent(config, agentActions) as QoderClient;
    expect(client).toBeInstanceOf(QoderClient);
    // The default model is applied to the authentication probe arguments.
    const probeArgs = (
      client as unknown as {
        buildAuthCheckArgs: (probePrompt: string) => string[];
      }
    ).buildAuthCheckArgs("Reply with exactly: OK");
    expect(probeArgs).toEqual([
      "-p",
      "Reply with exactly: OK",
      "--model",
      "claude-sonnet-4-5",
      "--output-format",
      "json",
    ]);
  });

  it("should fail fast for an unsupported CLI", () => {
    const config = new Config();
    config.AGENT_CLI = "unknown-cli";
    expect(() => createCliAgent(config)).toThrow(
      "Agent 'unknown-cli' is not supported (supported CLIs: qoder, claude-code, copilot-cli, codex, gemini-cli)",
    );
  });
});
