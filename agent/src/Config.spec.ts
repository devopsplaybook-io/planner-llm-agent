import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { Config, githubTokenEnvName } from "./Config";

describe("Config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    // Clear relevant env vars to test defaults
    delete process.env.DATA_DIR;
    delete process.env.TMP_DIR;
    delete process.env.DEV_MODE;
    delete process.env.CONFIG_FILE;
    delete process.env.AGENT_NAME;
    delete process.env.PLANNER_URL;
    delete process.env.PLANNER_API_KEY;
    delete process.env.TASK_POLLING_INTERVAL;
    delete process.env.OPENTELEMETRY_COLLECTOR_HTTP_TRACES;
    delete process.env.OPENTELEMETRY_COLLECTOR_HTTP_METRICS;
    delete process.env.OPENTELEMETRY_COLLECTOR_HTTP_LOGS;
    delete process.env.OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER;
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
      expect(config.GITHUB_TOKENS).toBe("");
      expect(config.OPENTELEMETRY_COLLECTOR_HTTP_TRACES).toBe("");
      expect(config.OPENTELEMETRY_COLLECTOR_HTTP_METRICS).toBe("");
      expect(config.OPENTELEMETRY_COLLECTOR_HTTP_LOGS).toBe("");
      expect(config.OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER).toBe("");
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

    it("should keep defaults when the config file does not exist", async () => {
      process.env.CONFIG_FILE = path.join(os.tmpdir(), "does-not-exist.json");

      const config = new Config();
      await config.reload();
      expect(config.AGENT_NAME).toBe("planner-llm-agent");
      expect(config.TASK_POLLING_INTERVAL).toBe(60);
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
        "TASK_POLLING_INTERVAL must be a positive integer (current value: '0')",
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
        "TASK_POLLING_INTERVAL must be a positive integer (current value: 'NaN')",
      ]);
    });

    it("should report an invalid TASK_MAX_PARALLEL", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.TASK_MAX_PARALLEL = 0;

      const errors = config.validate();
      expect(errors).toEqual([
        "TASK_MAX_PARALLEL must be a positive integer (current value: '0')",
      ]);
    });

    it("should report an invalid TASK_TIMEOUT", () => {
      const config = new Config();
      config.PLANNER_API_KEY = "key";
      config.TASK_TIMEOUT = 0;

      const errors = config.validate();
      expect(errors).toEqual([
        "TASK_TIMEOUT must be a positive integer (current value: '0')",
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
        "AGENT_NOTE_INTERVAL must be a positive integer or 0 to disable (current value: 'NaN')",
      ]);
    });
  });
});
