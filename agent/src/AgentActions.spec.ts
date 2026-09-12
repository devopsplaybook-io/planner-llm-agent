import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import {
  AgentActionsConfig,
  loadAgentActions,
  parseAgentActions,
} from "./AgentActions";

describe("AgentActions", () => {
  describe("parseAgentActions", () => {
    it("should parse a full configuration", () => {
      const config = parseAgentActions(
        [
          "default:",
          "  model: default-model",
          "actions:",
          "  - project: Web",
          "    status_start: To Do",
          "    status_end: In Review",
          "    model: action-model",
          "    instruction: Follow the guidelines",
          "  - project: Backend",
          "    status_start: To Do",
          "    status_end: Done",
        ].join("\n"),
      );

      expect(config).toEqual({
        defaultModel: "default-model",
        actions: [
          {
            project: "Web",
            statusStart: "To Do",
            statusEnd: "In Review",
            model: "action-model",
            instruction: "Follow the guidelines",
          },
          {
            project: "Backend",
            statusStart: "To Do",
            statusEnd: "Done",
            model: "",
            instruction: "",
          },
        ],
      });
    });

    it("should parse a minimal configuration without defaults", () => {
      const config = parseAgentActions(
        [
          "actions:",
          "  - project: Web",
          "    status_start: To Do",
          "    status_end: Done",
        ].join("\n"),
      );

      expect(config).toEqual({
        defaultModel: "",
        actions: [
          {
            project: "Web",
            statusStart: "To Do",
            statusEnd: "Done",
            model: "",
            instruction: "",
          },
        ],
      });
    });

    it("should accept an empty actions list", () => {
      const config = parseAgentActions("actions: []");
      expect(config).toEqual({ defaultModel: "", actions: [] });
    });

    it("should trim the configured values", () => {
      const config = parseAgentActions(
        [
          "default:",
          '  model: "  default-model  "',
          "actions:",
          '  - project: " Web "',
          "    status_start: To Do",
          "    status_end: Done",
        ].join("\n"),
      );
      expect(config.defaultModel).toBe("default-model");
      expect(config.actions[0].project).toBe("Web");
    });

    it("should throw on invalid YAML", () => {
      expect(() => parseAgentActions("actions: [unclosed")).toThrow(
        /Invalid YAML/,
      );
    });

    it("should throw on an empty configuration", () => {
      expect(() => parseAgentActions("")).toThrow("The configuration is empty");
    });

    it("should throw when the root is not a mapping", () => {
      expect(() => parseAgentActions("- a\n- b")).toThrow(
        "The configuration must be a mapping with 'default' and 'actions'",
      );
    });

    it("should throw when actions is missing", () => {
      expect(() => parseAgentActions("default:\n  model: m")).toThrow(
        /'actions' is required/,
      );
    });

    it("should throw when actions is not a list", () => {
      expect(() => parseAgentActions("actions: nope")).toThrow(
        /'actions' must be a list/,
      );
    });

    it("should throw when an action is not a mapping", () => {
      expect(() => parseAgentActions("actions:\n  - 42")).toThrow(
        /actions\[0\] must be a mapping/,
      );
    });

    it("should report missing required fields", () => {
      const failure = (): unknown =>
        parseAgentActions(
          [
            "actions:",
            "  - project: Web",
            "    status_end: Done",
            "  - status_start: To Do",
            "    status_end: Done",
          ].join("\n"),
        );
      expect(failure).toThrow(/actions\[0\]\.status_start' is required/);
      expect(failure).toThrow(/actions\[1\]\.project' is required/);
    });

    it("should throw on unknown action fields", () => {
      expect(() =>
        parseAgentActions(
          [
            "actions:",
            "  - project: Web",
            "    status_start: To Do",
            "    status_end: Done",
            "    statusStart: Typo",
          ].join("\n"),
        ),
      ).toThrow(/actions\[0\] has unknown field 'statusStart'/);
    });

    it("should throw on unknown default fields", () => {
      expect(() =>
        parseAgentActions(
          [
            "default:",
            "  model: m",
            "  instruction: not supported",
            "actions: []",
          ].join("\n"),
        ),
      ).toThrow(/Unknown 'default' field 'instruction'/);
    });

    it("should throw on empty or non-string values", () => {
      const failure = (): unknown =>
        parseAgentActions(
          [
            "default:",
            '  model: ""',
            "actions:",
            "  - project: 42",
            "    status_start: To Do",
            '    status_end: ""',
          ].join("\n"),
        );
      expect(failure).toThrow(/'default\.model' must be a non-empty string/);
      expect(failure).toThrow(
        /actions\[0\]\.project' must be a non-empty string/,
      );
      expect(failure).toThrow(
        /actions\[0\]\.status_end' must be a non-empty string/,
      );
    });

    it("should throw on duplicate project and start status", () => {
      expect(() =>
        parseAgentActions(
          [
            "actions:",
            "  - project: Web",
            "    status_start: To Do",
            "    status_end: Done",
            "  - project: Web",
            "    status_start: To Do",
            "    status_end: In Review",
          ].join("\n"),
        ),
      ).toThrow(
        /actions\[1\] duplicates the project 'Web' and status_start 'To Do'/,
      );
    });

    it("should accept the same project with different start statuses", () => {
      const config = parseAgentActions(
        [
          "actions:",
          "  - project: Web",
          "    status_start: To Do",
          "    status_end: Done",
          "  - project: Web",
          "    status_start: Blocked",
          "    status_end: Done",
        ].join("\n"),
      );
      expect(config.actions).toHaveLength(2);
    });
  });

  describe("loadAgentActions", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = path.join(os.tmpdir(), `agent-actions-spec-${Date.now()}`);
    });

    afterEach(() => {
      fse.removeSync(tmpDir);
    });

    it("should return null when the file does not exist", async () => {
      const config = await loadAgentActions(path.join(tmpDir, "missing.yaml"));
      expect(config).toBeNull();
    });

    it("should load and parse an existing file", async () => {
      const filePath = path.join(tmpDir, "llm-agent.yaml");
      await fse.outputFile(
        filePath,
        [
          "default:",
          "  model: default-model",
          "actions:",
          "  - project: Web",
          "    status_start: To Do",
          "    status_end: Done",
          "    instruction: Do it well",
        ].join("\n"),
      );

      const config: AgentActionsConfig | null =
        await loadAgentActions(filePath);
      expect(config).toEqual({
        defaultModel: "default-model",
        actions: [
          {
            project: "Web",
            statusStart: "To Do",
            statusEnd: "Done",
            model: "",
            instruction: "Do it well",
          },
        ],
      });
    });

    it("should throw when the file is invalid", async () => {
      const filePath = path.join(tmpDir, "llm-agent.yaml");
      await fse.outputFile(filePath, "actions:\n  - project: Web");

      await expect(loadAgentActions(filePath)).rejects.toThrow(
        /Invalid agent actions configuration/,
      );
    });
  });
});
