import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { Config } from "./Config";

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
      expect(config.PLANNER_URL).toBe("http://localhost:8080");
      expect(config.PLANNER_API_KEY).toBe("");
      expect(config.TASK_POLLING_INTERVAL).toBe(60);
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
        OPENTELEMETRY_COLLECTOR_HTTP_TRACES: "http://otel:4318/v1/traces",
      });
      process.env.CONFIG_FILE = configFile;

      const config = new Config();
      await config.reload();
      expect(config.AGENT_NAME).toBe("file-agent");
      expect(config.PLANNER_URL).toBe("http://planner:8080");
      expect(config.PLANNER_API_KEY).toBe("file-key");
      expect(config.TASK_POLLING_INTERVAL).toBe(120);
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
