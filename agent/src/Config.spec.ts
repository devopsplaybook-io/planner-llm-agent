import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { Config, githubTokenEnvName } from "./Config";
import { clearConfigEnvironment } from "../jest.setup";

describe("Config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    // The snapshot restore above reintroduces the ambient environment:
    // clear every configuration-relevant variable to test the defaults.
    clearConfigEnvironment();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("constructor defaults", () => {
    it("should set default values", () => {
      const config = new Config();
      expect(config.DATA_DIR).toBe("/data");
      expect(config.TMP_DIR).toBe("/tmp");
      expect(config.DEV_MODE).toBe(false);
      expect(config.SERVICE_ID).toBe("planner-llm-agent");
      expect(config.AGENT_NAME).toBe("planner-llm-agent");
      expect(config.AGENT_ACTIONS_FILE).toBe("/etc/planner/llm-agent.yaml");
      expect(config.PLANNER_URL).toBe("http://localhost:8080");
      expect(config.PLANNER_API_KEY).toBe("");
      expect(config.TASK_POLLING_INTERVAL).toBe(60);
      expect(config.TASK_STATUS_CLEANUP).toBe("Done");
      expect(config.TASK_TIMEOUT).toBe(3600);
      expect(config.TASK_MAX_PARALLEL).toBe(1);
      expect(config.TASK_SMART_SCHEDULING).toBe(true);
      expect(config.TASK_CONFLICT_MODE).toBe("repo");
      expect(config.TASK_ADJUSTMENT_MAX_ROUNDS).toBe(2);
      expect(config.TASK_LABELS).toBe(true);
      expect(config.TASK_RUNNING_LABEL).toBe("agent:running");
      expect(config.TASK_MODEL_LABEL_PREFIX).toBe("model:");
      expect(config.TASK_CLI_LABEL_PREFIX).toBe("");
      expect(config.AGENT_START_COMMENT).toBe(false);
      expect(config.AGENT_UTILITY_MODEL).toBe("");
      expect(config.GITHUB_TOKENS).toBe("");
      expect(config.AGENT_CLI).toBe("qoder");
      expect(config.AGENT_AUTH_CHECK).toBe("true");
      expect(config.QODER_CLI).toBe("qoder");
      expect(config.CLAUDE_CLI).toBe("claude");
      expect(config.COPILOT_CLI).toBe("copilot");
      expect(config.CODEX_CLI).toBe("codex");
      expect(config.GEMINI_CLI).toBe("gemini");
      expect(config.OPENTELEMETRY_COLLECTOR_HTTP_TRACES).toBe("");
      expect(config.OPENTELEMETRY_COLLECTOR_HTTP_METRICS).toBe("");
      expect(config.OPENTELEMETRY_COLLECTOR_HTTP_LOGS).toBe("");
      expect(config.OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER).toBe("");
      expect(config.CORE_SKILLS_PATH).toBe("");
    });

    it("should respect environment variables in constructor", () => {
      process.env.DATA_DIR = "/custom/data";
      process.env.TMP_DIR = "/custom/tmp";
      process.env.DEV_MODE = "true";

      const config = new Config();
      expect(config.DATA_DIR).toBe("/custom/data");
      expect(config.TMP_DIR).toBe("/custom/tmp");
      expect(config.DEV_MODE).toBe(true);
    });
  });

  describe("reload", () => {
    it("should load values from the config file", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-config-"));
      const configFile = path.join(tmpDir, "config.json");
      await fs.writeJson(configFile, {
        AGENT_NAME: "file-agent",
        PLANNER_URL: "http://planner:8080",
        PLANNER_API_KEY: "file-key",
        TASK_POLLING_INTERVAL: 120,
        TASK_STATUS_CLEANUP: "Archived",
        OPENTELEMETRY_COLLECTOR_HTTP_TRACES: "http://otel:4318/v1/traces",
      });
      process.env.CONFIG_FILE = configFile;

      const config = new Config();
      await config.reload();
      expect(config.AGENT_NAME).toBe("file-agent");
      expect(config.PLANNER_URL).toBe("http://planner:8080");
      expect(config.PLANNER_API_KEY).toBe("file-key");
      expect(config.TASK_POLLING_INTERVAL).toBe(120);
      expect(config.TASK_STATUS_CLEANUP).toBe("Archived");
      expect(config.OPENTELEMETRY_COLLECTOR_HTTP_TRACES).toBe(
        "http://otel:4318/v1/traces",
      );

      await fs.remove(tmpDir);
    });

    it("should give priority to environment variables over config file", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-config-"));
      const configFile = path.join(tmpDir, "config.json");
      await fs.writeJson(configFile, {
        AGENT_NAME: "file-agent",
        TASK_POLLING_INTERVAL: 120,
      });
      process.env.CONFIG_FILE = configFile;
      process.env.AGENT_NAME = "env-agent";

      const config = new Config();
      await config.reload();
      expect(config.AGENT_NAME).toBe("env-agent");
      expect(config.TASK_POLLING_INTERVAL).toBe(120);

      await fs.remove(tmpDir);
    });

    it("should load the agent actions file path from the config file and environment", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-config-"));
      const configFile = path.join(tmpDir, "config.json");
      await fs.writeJson(configFile, {
        AGENT_ACTIONS_FILE: "/opt/planner/llm-agent.yaml",
      });
      process.env.CONFIG_FILE = configFile;
      process.env.AGENT_ACTIONS_FILE = "/tmp/llm-agent.yaml";

      const config = new Config();
      await config.reload();
      expect(config.AGENT_ACTIONS_FILE).toBe("/tmp/llm-agent.yaml");

      await fs.remove(tmpDir);
    });

    it("should load the task timeout from the config file and environment", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-config-"));
      const configFile = path.join(tmpDir, "config.json");
      await fs.writeJson(configFile, {
        TASK_TIMEOUT: 1800,
      });
      process.env.CONFIG_FILE = configFile;
      process.env.TASK_TIMEOUT = "7200";

      const config = new Config();
      await config.reload();
      expect(config.TASK_TIMEOUT).toBe(7200);

      await fs.remove(tmpDir);
    });

    it("should load the scheduling settings from the config file and environment", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-config-"));
      const configFile = path.join(tmpDir, "config.json");
      await fs.writeJson(configFile, {
        TASK_MAX_PARALLEL: 1.5,
        TASK_SMART_SCHEDULING: false,
        TASK_CONFLICT_MODE: "project",
        AGENT_UTILITY_MODEL: "file-utility-model",
      });
      process.env.CONFIG_FILE = configFile;
      // The environment wins over the config file; the parallel budget keeps
      // its decimals and the boolean flag accepts 0/1 as well as true/false.
      process.env.TASK_MAX_PARALLEL = "1.9";
      process.env.TASK_SMART_SCHEDULING = "true";
      process.env.TASK_CONFLICT_MODE = "none";
      process.env.AGENT_UTILITY_MODEL = "env-utility-model";

      const config = new Config();
      await config.reload();
      expect(config.TASK_MAX_PARALLEL).toBe(1.9);
      expect(config.TASK_SMART_SCHEDULING).toBe(true);
      expect(config.TASK_CONFLICT_MODE).toBe("none");
      expect(config.AGENT_UTILITY_MODEL).toBe("env-utility-model");

      await fs.remove(tmpDir);
    });

    it("should load the new-comment adjustment budget from the config file and environment", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-config-"));
      const configFile = path.join(tmpDir, "config.json");
      await fs.writeJson(configFile, {
        TASK_ADJUSTMENT_MAX_ROUNDS: 1,
      });
      process.env.CONFIG_FILE = configFile;

      const config = new Config();
      await config.reload();
      // The kill switch (0) is a valid configured value.
      expect(config.TASK_ADJUSTMENT_MAX_ROUNDS).toBe(1);
      process.env.TASK_ADJUSTMENT_MAX_ROUNDS = "0";

      const envConfig = new Config();
      await envConfig.reload();
      expect(envConfig.TASK_ADJUSTMENT_MAX_ROUNDS).toBe(0);

      await fs.remove(tmpDir);
    });

    it("should parse the boolean scheduling flag from the environment", async () => {
      const reload = async (): Promise<Config> => {
        const config = new Config();
        await config.reload();
        return config;
      };

      process.env.TASK_SMART_SCHEDULING = "0";
      expect((await reload()).TASK_SMART_SCHEDULING).toBe(false);

      process.env.TASK_SMART_SCHEDULING = "false";
      expect((await reload()).TASK_SMART_SCHEDULING).toBe(false);

      process.env.TASK_SMART_SCHEDULING = "1";
      expect((await reload()).TASK_SMART_SCHEDULING).toBe(true);

      process.env.TASK_SMART_SCHEDULING = "anything-else";
      expect((await reload()).TASK_SMART_SCHEDULING).toBe(true);

      delete process.env.TASK_SMART_SCHEDULING;
      expect((await reload()).TASK_SMART_SCHEDULING).toBe(true);
    });

    it("should load the agent note settings from the config file", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-config-"));
      const configFile = path.join(tmpDir, "config.json");
      await fs.writeJson(configFile, {
        AGENT_NOTE_PROJECT: "File Project",
        AGENT_NOTE_INTERVAL: 3600,
      });
      process.env.CONFIG_FILE = configFile;
      process.env.AGENT_NOTE_INTERVAL = "1800";

      const config = new Config();
      await config.reload();
      expect(config.AGENT_NOTE_PROJECT).toBe("File Project");
      expect(config.AGENT_NOTE_INTERVAL).toBe(1800);

      await fs.remove(tmpDir);
    });

    it("should give priority to the environment for the GitHub organization tokens", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-config-"));
      const configFile = path.join(tmpDir, "config.json");
      await fs.writeJson(configFile, {
        GITHUB_TOKENS: "file-org=github_pat_aaaaaaaaaaaaaaaaaaaa",
      });
      process.env.CONFIG_FILE = configFile;
      process.env.GITHUB_TOKENS = "env-org=github_pat_bbbbbbbbbbbbbbbbbbbb";

      const config = new Config();
      await config.reload();
      expect(config.GITHUB_TOKENS).toBe(
        "env-org=github_pat_bbbbbbbbbbbbbbbbbbbb",
      );

      await fs.remove(tmpDir);
    });

    it("should load the CLI agent settings from the config file and environment", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-config-"));
      const configFile = path.join(tmpDir, "config.json");
      await fs.writeJson(configFile, {
        AGENT_CLI: "claude-code",
        CLAUDE_CLI: "claude-code-bin",
      });
      process.env.CONFIG_FILE = configFile;
      process.env.AGENT_CLI = "codex";
      process.env.CODEX_CLI = "codex-bin";

      const config = new Config();
      await config.reload();
      // The environment wins over the config file.
      expect(config.AGENT_CLI).toBe("codex");
      expect(config.CODEX_CLI).toBe("codex-bin");
      expect(config.CLAUDE_CLI).toBe("claude-code-bin");

      await fs.remove(tmpDir);
    });

    it("should load the label settings from the config file and environment", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-config-"));
      const configFile = path.join(tmpDir, "config.json");
      await fs.writeJson(configFile, {
        TASK_LABELS: false,
        TASK_RUNNING_LABEL: "file:running",
        TASK_MODEL_LABEL_PREFIX: "file-model:",
        TASK_CLI_LABEL_PREFIX: "file-cli:",
        AGENT_START_COMMENT: true,
      });
      process.env.CONFIG_FILE = configFile;

      const fileConfig = new Config();
      await fileConfig.reload();
      expect(fileConfig.TASK_LABELS).toBe(false);
      expect(fileConfig.TASK_RUNNING_LABEL).toBe("file:running");
      expect(fileConfig.TASK_MODEL_LABEL_PREFIX).toBe("file-model:");
      expect(fileConfig.TASK_CLI_LABEL_PREFIX).toBe("file-cli:");
      expect(fileConfig.AGENT_START_COMMENT).toBe(true);

      // The environment wins over the config file; an empty string disables
      // the running label and an empty prefix disables the CLI provenance
      // label.
      process.env.TASK_LABELS = "true";
      process.env.TASK_RUNNING_LABEL = "";
      process.env.TASK_MODEL_LABEL_PREFIX = "model:";
      process.env.TASK_CLI_LABEL_PREFIX = "";
      process.env.AGENT_START_COMMENT = "false";

      const envConfig = new Config();
      await envConfig.reload();
      expect(envConfig.TASK_LABELS).toBe(true);
      expect(envConfig.TASK_RUNNING_LABEL).toBe("");
      expect(envConfig.TASK_MODEL_LABEL_PREFIX).toBe("model:");
      expect(envConfig.TASK_CLI_LABEL_PREFIX).toBe("");
      expect(envConfig.AGENT_START_COMMENT).toBe(false);

      await fs.remove(tmpDir);
    });

    it("should keep defaults when the config file does not exist", async () => {
      process.env.CONFIG_FILE = path.join(os.tmpdir(), "does-not-exist.json");

      const config = new Config();
      await config.reload();
      expect(config.AGENT_NAME).toBe("planner-llm-agent");
      expect(config.TASK_POLLING_INTERVAL).toBe(60);
    });

    it("should load the core skills path from the config file and environment", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-config-"));
      const configFile = path.join(tmpDir, "config.json");
      await fs.writeJson(configFile, {
        CORE_SKILLS_PATH: "/file/skills",
      });
      process.env.CONFIG_FILE = configFile;
      process.env.CORE_SKILLS_PATH = "/env/skills";

      const config = new Config();
      await config.reload();
      // The environment wins over the config file.
      expect(config.CORE_SKILLS_PATH).toBe("/env/skills");

      await fs.remove(tmpDir);
    });
  });

  describe("validate", () => {
    it("should return no errors for a valid configuration", () => {
      const config = new Config();
      config.AGENT_NAME = "agent";
      config.PLANNER_URL = "http://planner:8080";
      config.PLANNER_API_KEY = "key";
      config.TASK_POLLING_INTERVAL = 60;
      expect(config.validate()).toEqual([]);
    });

    it("should report all missing required values", () => {
      const config = new Config();
      config.AGENT_NAME = "";
      config.PLANNER_URL = "";
      config.PLANNER_API_KEY = "";
      config.TASK_POLLING_INTERVAL = 0;

      const errors = config.validate();
      expect(errors).toHaveLength(4);
      expect(errors).toContain("AGENT_NAME is required");
      expect(errors).toContain("PLANNER_URL is required");
      expect(errors).toContain("PLANNER_API_KEY is required");
      expect(errors).toContain(
        "TASK_POLLING_INTERVAL must be a positive integer of at most 2147483 seconds (current value: '0')",
      );
    });

    it("should report invalid PLANNER_URL", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.PLANNER_URL = "not-a-url";

      const errors = config.validate();
      expect(errors).toEqual([
        "PLANNER_URL must be a valid http(s) URL (current value: 'not-a-url')",
      ]);
    });

    it("should report non-integer TASK_POLLING_INTERVAL", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.TASK_POLLING_INTERVAL = NaN;

      const errors = config.validate();
      expect(errors).toEqual([
        "TASK_POLLING_INTERVAL must be a positive integer of at most 2147483 seconds (current value: 'NaN')",
      ]);
    });

    it("should report an invalid TASK_MAX_PARALLEL", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.TASK_MAX_PARALLEL = 0;

      const errors = config.validate();
      expect(errors).toEqual([
        "TASK_MAX_PARALLEL must be a positive number (current value: '0')",
      ]);
    });

    it("should accept a fractional TASK_MAX_PARALLEL", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.TASK_MAX_PARALLEL = 1.9;

      expect(config.validate()).toEqual([]);
    });

    it("should report an invalid TASK_CONFLICT_MODE", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.TASK_CONFLICT_MODE = "serial";

      const errors = config.validate();
      expect(errors).toEqual([
        "TASK_CONFLICT_MODE must be one of repo, project, none (current value: 'serial')",
      ]);
    });

    it("should report an invalid TASK_TIMEOUT", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.TASK_TIMEOUT = 0;

      const errors = config.validate();
      expect(errors).toEqual([
        "TASK_TIMEOUT must be a positive integer of at most 2147483 seconds (current value: '0')",
      ]);
    });

    it("should report an invalid TASK_ADJUSTMENT_MAX_ROUNDS", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.TASK_ADJUSTMENT_MAX_ROUNDS = -1;

      const errors = config.validate();
      expect(errors).toEqual([
        "TASK_ADJUSTMENT_MAX_ROUNDS must be a non-negative integer (current value: '-1')",
      ]);
    });

    it("should accept the default label settings", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";

      expect(config.validate()).toEqual([]);
    });

    it("should accept disabled label settings", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.TASK_RUNNING_LABEL = "";
      config.TASK_MODEL_LABEL_PREFIX = "";
      config.TASK_CLI_LABEL_PREFIX = "";

      expect(config.validate()).toEqual([]);
    });

    it("should report a label setting containing a comma", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.TASK_RUNNING_LABEL = "agent:running,in-progress";

      expect(config.validate()).toEqual([
        "TASK_RUNNING_LABEL must not contain a comma (current value: 'agent:running,in-progress')",
      ]);
    });

    it("should report a label setting longer than 100 characters", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.TASK_MODEL_LABEL_PREFIX = `model:${"a".repeat(95)}`;

      expect(config.validate()).toEqual([
        `TASK_MODEL_LABEL_PREFIX must be at most 100 characters (current value: 'model:${"a".repeat(95)}')`,
      ]);
    });

    it("should report a label setting with surrounding whitespace", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.TASK_CLI_LABEL_PREFIX = "cli: ";

      expect(config.validate()).toEqual([
        "TASK_CLI_LABEL_PREFIX must not start or end with whitespace (current value: 'cli: ')",
      ]);
    });

    it("should accept well-formed GitHub organization tokens", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.GITHUB_TOKENS =
        "org-a=github_pat_aaaaaaaaaaaaaaaaaaaa, org-b=github_pat_bbbbbbbbbbbbbbbbbbbb";

      expect(config.validate()).toEqual([]);
      expect(config.githubTokenEntries()).toEqual([
        { organization: "org-a", token: "github_pat_aaaaaaaaaaaaaaaaaaaa" },
        { organization: "org-b", token: "github_pat_bbbbbbbbbbbbbbbbbbbb" },
      ]);
    });

    it("should skip malformed entries when parsing the GitHub organization tokens", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.GITHUB_TOKENS =
        "just-a-token,,org=github_pat_aaaaaaaaaaaaaaaaaaaa";

      expect(config.githubTokenEntries()).toEqual([
        { organization: "org", token: "github_pat_aaaaaaaaaaaaaaaaaaaa" },
      ]);
      expect(config.validate()).toEqual([
        "GITHUB_TOKENS entry 'just-a-token' must be in the format 'organization=token'",
      ]);
    });

    it("should derive unambiguous token environment variable names", () => {
      expect(githubTokenEnvName("devopsplaybook-io")).toBe(
        "GH_TOKEN_DEVOPSPLAYBOOK_IO",
      );
      expect(githubTokenEnvName("MyOrg")).toBe("GH_TOKEN_MYORG");
    });

    it("should report an empty GITHUB_TOKENS token", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.GITHUB_TOKENS = "org-a=";

      expect(config.validate()).toEqual([
        "GITHUB_TOKENS token must not be empty for organization 'org-a'",
      ]);
    });

    it("should report an invalid GITHUB_TOKENS organization name", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.GITHUB_TOKENS = "not an org=github_pat_aaaaaaaaaaaaaaaaaaaa";

      expect(config.validate()).toEqual([
        "GITHUB_TOKENS organization 'not an org' is not a valid GitHub organization name (alphanumeric characters and hyphens only)",
      ]);
    });

    it("should report a GITHUB_TOKENS token with unsupported characters", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.GITHUB_TOKENS = 'org-a=github_pat_"token"';

      expect(config.validate()).toEqual([
        "GITHUB_TOKENS token for organization 'org-a' contains unsupported characters (whitespace, quotes or backslashes)",
      ]);
    });

    it("should report a duplicate GITHUB_TOKENS organization", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.GITHUB_TOKENS =
        "org-a=github_pat_aaaaaaaaaaaaaaaaaaaa,ORG-A=github_pat_bbbbbbbbbbbbbbbbbbbb";

      expect(config.validate()).toEqual([
        "GITHUB_TOKENS contains a duplicate organization 'ORG-A'",
      ]);
    });

    it("should not require agent note configuration by default", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      expect(config.AGENT_NOTE_PROJECT).toBe("");
      expect(config.AGENT_NOTE_INTERVAL).toBe(86400);
      expect(config.validate()).toEqual([]);
    });

    it("should accept the agent note with the daily default interval", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.AGENT_NOTE_PROJECT = "Agent";
      expect(config.validate()).toEqual([]);
    });

    it("should accept an explicitly disabled agent note interval", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.AGENT_NOTE_PROJECT = "Agent";
      config.AGENT_NOTE_INTERVAL = 0;
      expect(config.validate()).toEqual([]);
    });

    it("should report an invalid agent note interval", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.AGENT_NOTE_PROJECT = "Agent";
      config.AGENT_NOTE_INTERVAL = NaN;

      const errors = config.validate();
      expect(errors).toEqual([
        "AGENT_NOTE_INTERVAL must be a positive integer of at most 2147483 seconds or 0 to disable (current value: 'NaN')",
      ]);
    });

    it("should accept the maximum seconds-based delay and reject one second more", () => {
      const secondsKeys: [string, number][] = [
        ["TASK_POLLING_INTERVAL", 2147483],
        ["TASK_POLLING_MAX_INTERVAL", 2147483],
        ["TASK_TIMEOUT", 2147483],
        ["AGENT_EVALUATION_TIMEOUT", 2147483],
        ["TASK_PROGRESS_COMMENT_INTERVAL", 2147483],
        ["AGENT_NOTE_INTERVAL", 2147483],
        ["AGENT_CONFIG_SYNC_INTERVAL", 2147483],
      ];
      for (const [key, value] of secondsKeys) {
        const accepted = new Config();
        accepted.PLANNER_API_KEY = "key";
        accepted.AGENT_NOTE_PROJECT = "Agent";
        accepted.AGENT_CONFIG_REPOSITORY =
          "https://github.com/acme/agent-config.git";
        (accepted as unknown as Record<string, number>)[key] = value;
        expect(accepted.validate()).toEqual([]);

        const rejected = new Config();
        rejected.PLANNER_API_KEY = "key";
        rejected.AGENT_NOTE_PROJECT = "Agent";
        rejected.AGENT_CONFIG_REPOSITORY =
          "https://github.com/acme/agent-config.git";
        (rejected as unknown as Record<string, number>)[key] = value + 1;
        const errors = rejected.validate();
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain(`${key} must be a`);
        expect(errors[0]).toContain("integer of at most 2147483 seconds");
      }
    });

    it("should keep accepting a disabled progress or note interval", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.AGENT_NOTE_PROJECT = "Agent";
      config.TASK_PROGRESS_COMMENT_INTERVAL = 0;
      config.AGENT_NOTE_INTERVAL = 0;
      expect(config.validate()).toEqual([]);
    });

    it("should default the attachment size cap to 50 MiB", () => {
      const config = new Config();
      expect(config.TASK_ATTACHMENT_MAX_BYTES).toBe(50 * 1024 * 1024);
    });

    it("should accept a disabled attachment size cap", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.TASK_ATTACHMENT_MAX_BYTES = 0;
      expect(config.validate()).toEqual([]);
    });

    it("should report an invalid attachment size cap", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.TASK_ATTACHMENT_MAX_BYTES = -1;
      expect(config.validate()).toEqual([
        "TASK_ATTACHMENT_MAX_BYTES must be a non-negative integer (0 disables the cap) (current value: '-1')",
      ]);

      config.TASK_ATTACHMENT_MAX_BYTES = 1.5;
      expect(config.validate()).toEqual([
        "TASK_ATTACHMENT_MAX_BYTES must be a non-negative integer (0 disables the cap) (current value: '1.5')",
      ]);
    });

    it("should accept a relative agent config folder", () => {
      for (const folder of ["", "skills", "skills/", "a/b"]) {
        const config = new Config();
        config.PLANNER_API_KEY = "key";
        config.AGENT_CONFIG_FOLDER = folder;
        expect(config.validate()).toEqual([]);
      }
    });

    it("should report an unsafe agent config folder", () => {
      for (const folder of ["../x", "/abs", "a/../b", "a//b", "C:\\x", "a\\b"]) {
        const config = new Config();
        config.PLANNER_API_KEY = "key";
        config.AGENT_CONFIG_FOLDER = folder;
        expect(config.validate()).toEqual([
          `AGENT_CONFIG_FOLDER must be a relative path without '..' or empty segments (current value: '${folder}')`,
        ]);
      }
    });

    it("should accept every supported CLI agent", () => {
      for (const cli of [
        "qoder",
        "claude-code",
        "copilot-cli",
        "codex",
        "gemini-cli",
      ]) {
        const config = new Config();
        config.PLANNER_API_KEY = "key";
        config.AGENT_CLI = cli;
        expect(config.validate()).toEqual([]);
      }
    });

    it("should report an unsupported CLI agent", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.AGENT_CLI = "unknown-cli";

      expect(config.validate()).toEqual([
        "AGENT_CLI 'unknown-cli' is not supported (supported CLIs: qoder, claude-code, copilot-cli, codex, gemini-cli)",
      ]);
    });
  });
});
