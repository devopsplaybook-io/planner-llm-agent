import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import {
  AgentActionsConfig,
  loadAgentActions,
  matchProjectPattern,
  parseAgentActions,
} from "./AgentActions";

describe("AgentActions", () => {
  describe("parseAgentActions", () => {
    it("should parse a full configuration", () => {
      const config = parseAgentActions(
        [
          "default:",
          "  model: default-model",
          "  timeout: 3600",
          "actions:",
          "  - project: Web",
          "    status_start: To Do",
          "    status_end: In Review",
          "    model: action-model",
          "    instruction: Follow the guidelines",
          "    timeout: 1800",
          "  - project: Backend",
          "    status_start: To Do",
          "    status_end: Done",
        ].join("\n"),
      );

      expect(config).toEqual({
        defaultModel: "default-model",
        defaultTimeout: 3600,
        actions: [
          {
            project: "Web",
            statusStart: "To Do",
            statusEnd: "In Review",
            model: "action-model",
            instruction: "Follow the guidelines",
            timeout: 1800,
            weight: null,
          },
          {
            project: "Backend",
            statusStart: "To Do",
            statusEnd: "Done",
            model: "",
            instruction: "",
            timeout: null,
            weight: null,
          },
        ],
      });
    });

    it("should parse default and per-action CLI agents", () => {
      const config = parseAgentActions(
        [
          "default:",
          "  agent: qoder",
          "actions:",
          "  - project: Project*",
          "    status_start: To Do",
          "    status_end: Done",
          "    agent: copilot-cli",
        ].join("\n"),
      );

      expect(config.defaultAgent).toBe("qoder");
      expect(config.actions[0].agent).toBe("copilot-cli");
    });

    it("should parse the default and per-action error statuses", () => {
      const config = parseAgentActions(
        [
          "default:",
          "  status_error: Review",
          "actions:",
          "  - project: Web",
          "    status_start: To Do",
          "    status_end: Done",
          "    status_error: Blocked",
          "  - project: Backend",
          "    status_start: To Do",
          "    status_end: Done",
        ].join("\n"),
      );
      expect(config.defaultStatusError).toBe("Review");
      expect(config.actions[0].statusError).toBe("Blocked");
      expect(config.actions[1].statusError).toBeUndefined();
    });

    it("should trim the configured error statuses", () => {
      const config = parseAgentActions(
        [
          "default:",
          '  status_error: "  Review  "',
          "actions:",
          "  - project: Web",
          "    status_start: To Do",
          "    status_end: Done",
          '    status_error: " Blocked "',
        ].join("\n"),
      );
      expect(config.defaultStatusError).toBe("Review");
      expect(config.actions[0].statusError).toBe("Blocked");
    });

    it("should reject an empty or non-string default status_error", () => {
      const failure = (value: string): (() => unknown) => () =>
        parseAgentActions(
          ["default:", `  status_error: ${value}`, "actions: []"].join("\n"),
        );
      expect(failure('""')).toThrow(
        /'default\.status_error' must be a non-empty string/,
      );
      expect(failure("42")).toThrow(
        /'default\.status_error' must be a non-empty string/,
      );
    });

    it("should reject an empty or non-string action status_error", () => {
      const failure = (value: string): (() => unknown) => () =>
        parseAgentActions(
          [
            "actions:",
            "  - project: Web",
            "    status_start: To Do",
            "    status_end: Done",
            `    status_error: ${value}`,
          ].join("\n"),
        );
      expect(failure('""')).toThrow(
        /'actions\[0\]\.status_error' must be a non-empty string/,
      );
      expect(failure("42")).toThrow(
        /'actions\[0\]\.status_error' must be a non-empty string/,
      );
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
        defaultTimeout: null,
        actions: [
          {
            project: "Web",
            statusStart: "To Do",
            statusEnd: "Done",
            model: "",
            instruction: "",
            timeout: null,
            weight: null,
          },
        ],
      });
    });

    it("should accept an empty actions list", () => {
      const config = parseAgentActions("actions: []");
      expect(config).toEqual({
        defaultModel: "",
        defaultTimeout: null,
        actions: [],
      });
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
    });

    it("should parse actions without a project as matching any project", () => {
      const config = parseAgentActions(
        [
          "actions:",
          "  - status_start: To Do",
          "    status_end: Done",
        ].join("\n"),
      );
      expect(config.actions[0].project).toBe("");
    });

    it("should parse a null or empty project as matching any project", () => {
      const config = parseAgentActions(
        [
          "actions:",
          "  - project:",
          "    status_start: To Do",
          "    status_end: Done",
          '  - project: ""',
          "    status_start: Blocked",
          "    status_end: Done",
          '  - project: "   "',
          "    status_start: In Progress",
          "    status_end: Done",
        ].join("\n"),
      );
      expect(config.actions.map((action) => action.project)).toEqual([
        "",
        "",
        "",
      ]);
    });

    it("should parse project wildcard patterns", () => {
      const config = parseAgentActions(
        [
          "actions:",
          "  - project: Project*",
          "    status_start: To Do",
          "    status_end: Done",
          "  - project: '*'",
          "    status_start: Blocked",
          "    status_end: Done",
          "  - project: '*Reader'",
          "    status_start: In Progress",
          "    status_end: Done",
        ].join("\n"),
      );
      expect(config.actions.map((action) => action.project)).toEqual([
        "Project*",
        "*",
        "*Reader",
      ]);
    });

    it("should throw on a non-string project", () => {
      expect(() =>
        parseAgentActions(
          [
            "actions:",
            "  - project: 42",
            "    status_start: To Do",
            "    status_end: Done",
          ].join("\n"),
        ),
      ).toThrow(/actions\[0\]\.project' must be a string/);
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

    it("should reject an empty configured agent", () => {
      expect(() =>
        parseAgentActions(
          [
            "default:",
            '  agent: " "',
            "actions: []",
          ].join("\n"),
        ),
      ).toThrow(/'default.agent' must be a non-empty string/);
    });

    it("should reject an unsupported configured agent", () => {
      expect(() =>
        parseAgentActions(
          [
            "actions:",
            "  - status_start: To Do",
            "    status_end: Done",
            "    agent: unknown-cli",
          ].join("\n"),
        ),
      ).toThrow(/'actions\[0\]\.agent' must be one of qoder/);
    });

    it("should throw on invalid default timeout values", () => {
      const failure = (value: string): (() => unknown) => () =>
        parseAgentActions(
          ["default:", `  timeout: ${value}`, "actions: []"].join("\n"),
        );
      expect(failure('"3600"')).toThrow(
        /'default\.timeout' must be a positive integer \(seconds\)/,
      );
      expect(failure("0")).toThrow(
        /'default\.timeout' must be a positive integer \(seconds\)/,
      );
      expect(failure("-1")).toThrow(
        /'default\.timeout' must be a positive integer \(seconds\)/,
      );
      expect(failure("1.5")).toThrow(
        /'default\.timeout' must be a positive integer \(seconds\)/,
      );
    });

    it("should throw on invalid action timeout values", () => {
      const failure = (value: string): (() => unknown) => () =>
        parseAgentActions(
          [
            "actions:",
            "  - project: Web",
            "    status_start: To Do",
            "    status_end: Done",
            `    timeout: ${value}`,
          ].join("\n"),
        );
      expect(failure('"600"')).toThrow(
        /'actions\[0\]\.timeout' must be a positive integer \(seconds\)/,
      );
      expect(failure("0")).toThrow(
        /'actions\[0\]\.timeout' must be a positive integer \(seconds\)/,
      );
      expect(failure("-5")).toThrow(
        /'actions\[0\]\.timeout' must be a positive integer \(seconds\)/,
      );
      expect(failure("0.5")).toThrow(
        /'actions\[0\]\.timeout' must be a positive integer \(seconds\)/,
      );
    });

    it("should parse the action weight", () => {
      const config = parseAgentActions(
        [
          "actions:",
          "  - project: Web",
          "    status_start: To Do",
          "    status_end: Done",
          "    weight: 0.5",
          "  - project: Backend",
          "    status_start: To Do",
          "    status_end: Done",
          "    weight: 1",
        ].join("\n"),
      );
      expect(config.actions[0].weight).toBe(0.5);
      expect(config.actions[1].weight).toBe(1);
    });

    it("should throw on invalid action weight values", () => {
      const failure = (value: string): (() => unknown) => () =>
        parseAgentActions(
          [
            "actions:",
            "  - project: Web",
            "    status_start: To Do",
            "    status_end: Done",
            `    weight: ${value}`,
          ].join("\n"),
        );
      // Weights above 1 would let a single task consume more than one slot
      // of the parallel budget, so the action weight is bounded to (0, 1].
      expect(failure("0")).toThrow(
        /'actions\[0\]\.weight' must be a number greater than 0 and at most 1/,
      );
      expect(failure("-0.5")).toThrow(
        /'actions\[0\]\.weight' must be a number greater than 0 and at most 1/,
      );
      expect(failure("1.5")).toThrow(
        /'actions\[0\]\.weight' must be a number greater than 0 and at most 1/,
      );
      expect(failure('"big"')).toThrow(
        /'actions\[0\]\.weight' must be a number greater than 0 and at most 1/,
      );
    });

    it("should parse the action priority", () => {
      const config = parseAgentActions(
        [
          "actions:",
          "  - project: Web",
          "    status_start: To Do",
          "    status_end: Done",
          "    priority: low",
          "  - project: Backend",
          "    status_start: To Do",
          "    status_end: Done",
          "    priority: high",
        ].join("\n"),
      );
      expect(config.actions[0].priority).toBe("low");
      expect(config.actions[1].priority).toBe("high");
    });

    it("should normalize the action priority case and whitespace", () => {
      const config = parseAgentActions(
        [
          "actions:",
          "  - project: Web",
          "    status_start: To Do",
          "    status_end: Done",
          '    priority: " High "',
        ].join("\n"),
      );
      expect(config.actions[0].priority).toBe("high");
    });

    it("should leave the action priority unset when omitted", () => {
      const config = parseAgentActions(
        [
          "actions:",
          "  - project: Web",
          "    status_start: To Do",
          "    status_end: Done",
        ].join("\n"),
      );
      expect(config.actions[0].priority).toBeUndefined();
    });

    it("should throw on invalid action priority values", () => {
      const failure = (value: string): (() => unknown) => () =>
        parseAgentActions(
          [
            "actions:",
            "  - project: Web",
            "    status_start: To Do",
            "    status_end: Done",
            `    priority: ${value}`,
          ].join("\n"),
        );
      expect(failure("urgent")).toThrow(
        /'actions\[0\]\.priority' must be one of high, medium, low/,
      );
      expect(failure('""')).toThrow(
        /'actions\[0\]\.priority' must be one of high, medium, low/,
      );
      expect(failure("5")).toThrow(
        /'actions\[0\]\.priority' must be one of high, medium, low/,
      );
    });

    it("should reject a default priority", () => {
      expect(() =>
        parseAgentActions(
          [
            "default:",
            "  model: m",
            "  priority: low",
            "actions: []",
          ].join("\n"),
        ),
      ).toThrow(/Unknown 'default' field 'priority'/);
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
      expect(failure).toThrow(/actions\[0\]\.project' must be a string/);
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

    it("should throw on duplicate project patterns with the same start status", () => {
      expect(() =>
        parseAgentActions(
          [
            "actions:",
            "  - project: Project*",
            "    status_start: To Do",
            "    status_end: Done",
            "  - project: Project*",
            "    status_start: To Do",
            "    status_end: In Review",
          ].join("\n"),
        ),
      ).toThrow(
        /actions\[1\] duplicates the project 'Project\*' and status_start 'To Do'/,
      );
    });

    it("should throw on duplicate any-project actions with the same start status", () => {
      expect(() =>
        parseAgentActions(
          [
            "actions:",
            "  - status_start: To Do",
            "    status_end: Done",
            "  - status_start: To Do",
            "    status_end: In Review",
          ].join("\n"),
        ),
      ).toThrow(/actions\[1\] duplicates the project '' and status_start 'To Do'/);
    });
  });

  describe("matchProjectPattern", () => {
    it("should match any project with an empty pattern", () => {
      expect(matchProjectPattern("", "Web")).toBe(true);
      expect(matchProjectPattern("", "")).toBe(true);
    });

    it("should match any project with a bare wildcard", () => {
      expect(matchProjectPattern("*", "Web")).toBe(true);
      expect(matchProjectPattern("*", "Projects")).toBe(true);
      expect(matchProjectPattern("*", "")).toBe(true);
    });

    it("should match prefix wildcards", () => {
      expect(matchProjectPattern("Project*", "Projects")).toBe(true);
      expect(matchProjectPattern("Project*", "Projects - Planner")).toBe(true);
      expect(matchProjectPattern("Project*", "Project")).toBe(true);
      expect(matchProjectPattern("Project*", "Planner")).toBe(false);
    });

    it("should match suffix wildcards", () => {
      expect(matchProjectPattern("*Reader", "ChineseTextReader")).toBe(true);
      expect(matchProjectPattern("*Reader", "Reader")).toBe(true);
      expect(matchProjectPattern("*Reader", "ChineseTextViewer")).toBe(false);
    });

    it("should match inner wildcards", () => {
      expect(matchProjectPattern("Cloud*Manager", "CloudPhotoManager")).toBe(
        true,
      );
      expect(matchProjectPattern("Cloud*Manager", "CloudManager")).toBe(true);
      expect(matchProjectPattern("Cloud*Manager", "PhotoManager")).toBe(false);
    });

    it("should not match partially without a wildcard", () => {
      expect(matchProjectPattern("Project", "Projects")).toBe(false);
      expect(matchProjectPattern("Project", "Project")).toBe(true);
    });

    it("should match case-sensitively", () => {
      expect(matchProjectPattern("project*", "Projects")).toBe(false);
      expect(matchProjectPattern("Project*", "Projects")).toBe(true);
    });

    it("should treat regex special characters literally", () => {
      expect(matchProjectPattern("C++ (dev)", "C++ (dev)")).toBe(true);
      expect(matchProjectPattern("C++ (dev)", "Cxx dev")).toBe(false);
      expect(matchProjectPattern("a.b", "a.b")).toBe(true);
      expect(matchProjectPattern("a.b", "axb")).toBe(false);
    });

    it("should handle consecutive and repeated wildcards", () => {
      expect(matchProjectPattern("**", "Anything")).toBe(true);
      expect(matchProjectPattern("a**b", "ab")).toBe(true);
      expect(matchProjectPattern("a**b", "axxyb")).toBe(true);
      expect(matchProjectPattern("*a*b*", "xaybz")).toBe(true);
      expect(matchProjectPattern("*a*b*", "xab")).toBe(true);
      expect(matchProjectPattern("*a*b*", "bxa")).toBe(false);
    });

    it("should require wildcards to cover the whole name", () => {
      expect(matchProjectPattern("*Cloud*", "ACloudB")).toBe(true);
      expect(matchProjectPattern("*Cloud*", "ACloud")).toBe(true);
      expect(matchProjectPattern("*Cloud*", "CloudB")).toBe(true);
      expect(matchProjectPattern("*Cloud*", "ACloudier")).toBe(true);
      expect(matchProjectPattern("*Cloud*", "ColudX")).toBe(false);
    });

    it("should match an empty name only with an empty or all-wildcard pattern", () => {
      expect(matchProjectPattern("*", "")).toBe(true);
      expect(matchProjectPattern("**", "")).toBe(true);
      expect(matchProjectPattern("Project*", "")).toBe(false);
      expect(matchProjectPattern("*Reader", "")).toBe(false);
      expect(matchProjectPattern("Project", "")).toBe(false);
    });

    it("should match long names with a pathological pattern in linear time", () => {
      // 'a*a*a*...' against a name of 'a' with one 'b' at the end is the
      // classic backtracking blow-up for a regex engine; the scan must
      // return quickly (jest's 5s default timeout guards this).
      const pattern = "a*".repeat(50) + "b";
      const value = `${"a".repeat(10000)}b`;
      expect(matchProjectPattern(pattern, value)).toBe(true);
      expect(matchProjectPattern(pattern, `${"a".repeat(10000)}c`)).toBe(false);
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
        defaultTimeout: null,
        actions: [
          {
            project: "Web",
            statusStart: "To Do",
            statusEnd: "Done",
            model: "",
            instruction: "Do it well",
            timeout: null,
            weight: null,
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
