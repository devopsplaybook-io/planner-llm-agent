import * as fs from "fs-extra";
import * as path from "path";

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export class Config {
  public CONFIG_FILE: string;
  public DATA_DIR: string;
  public TMP_DIR: string;
  public DEV_MODE: boolean;

  public SERVICE_ID: string;
  public VERSION: string;

  // Agent
  public AGENT_NAME: string;
  public PLANNER_URL: string;
  public PLANNER_API_KEY: string;
  public TASK_POLLING_INTERVAL: number;
  public TASK_STATUS_START: string;
  public TASK_STATUS_END: string;

  // Qoder CLI
  public QODER_CLI: string;
  public QODER_AUTH_CHECK: string;
  public QODER_MODEL: string;

  // Git and GitHub integration
  public GIT_USER_NAME: string;
  public GIT_USER_EMAIL: string;
  public GITHUB_TOKEN: string;
  public GIT_SSH_PRIVATE_KEY: string;
  public GIT_SSH_SIGNING: string;
  public GIT_GPG_PRIVATE_KEY: string;
  public GIT_GPG_KEY_ID: string;
  public GIT_GPG_PASSPHRASE: string;

  // Agent config repository
  public AGENT_CONFIG_REPOSITORY: string;
  public AGENT_CONFIG_BRANCH: string;
  public AGENT_CONFIG_FOLDER: string;
  public AGENT_CONFIG_SYNC_INTERVAL: number;

  // OpenTelemetry
  public OPENTELEMETRY_COLLECTOR_HTTP_TRACES: string;
  public OPENTELEMETRY_COLLECTOR_HTTP_METRICS: string;
  public OPENTELEMETRY_COLLECTOR_HTTP_LOGS: string;
  public OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER: string;

  constructor() {
    this.DATA_DIR = process.env.DATA_DIR || "/data";
    this.TMP_DIR = process.env.TMP_DIR || "/tmp";
    this.DEV_MODE = process.env.DEV_MODE === "true";

    this.CONFIG_FILE =
      process.env.CONFIG_FILE || path.join(__dirname, "../config.json");

    this.SERVICE_ID = "planner-llm-agent";
    this.VERSION = "1";
    try {
      const pkg = fs.readJsonSync(
        path.resolve(__dirname, "../package.json"),
      );
      if (pkg?.version) {
        this.VERSION = pkg.version;
      }
    } catch {
      // Keep default version when package.json is not available
    }

    this.AGENT_NAME = "planner-llm-agent";
    this.PLANNER_URL = "http://localhost:8080";
    this.PLANNER_API_KEY = "";
    this.TASK_POLLING_INTERVAL = 60;
    this.TASK_STATUS_START = "To Do";
    this.TASK_STATUS_END = "Done";

    this.QODER_CLI = "qoder";
    this.QODER_AUTH_CHECK = "true";
    this.QODER_MODEL = "";

    this.GIT_USER_NAME = "planner-llm-agent";
    this.GIT_USER_EMAIL = "planner-llm-agent@users.noreply.github.com";
    this.GITHUB_TOKEN = "";
    this.GIT_SSH_PRIVATE_KEY = "";
    this.GIT_SSH_SIGNING = "false";
    this.GIT_GPG_PRIVATE_KEY = "";
    this.GIT_GPG_KEY_ID = "";
    this.GIT_GPG_PASSPHRASE = "";

    this.AGENT_CONFIG_REPOSITORY = "";
    this.AGENT_CONFIG_BRANCH = "main";
    this.AGENT_CONFIG_FOLDER = "";
    this.AGENT_CONFIG_SYNC_INTERVAL = 300;

    this.OPENTELEMETRY_COLLECTOR_HTTP_TRACES = "";
    this.OPENTELEMETRY_COLLECTOR_HTTP_METRICS = "";
    this.OPENTELEMETRY_COLLECTOR_HTTP_LOGS = "";
    this.OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER = "";
  }

  public async reload(): Promise<void> {
    let config: Record<string, unknown> = {};
    if (await fs.pathExists(this.CONFIG_FILE)) {
      config = await fs.readJson(this.CONFIG_FILE);
    }

    this.DATA_DIR = (config.DATA_DIR as string) || this.DATA_DIR;
    this.TMP_DIR = (config.TMP_DIR as string) || this.TMP_DIR;
    if (config.DEV_MODE !== undefined) {
      this.DEV_MODE = config.DEV_MODE === true;
    }

    if (config.AGENT_NAME) {
      this.AGENT_NAME = config.AGENT_NAME as string;
    }
    if (config.PLANNER_URL) {
      this.PLANNER_URL = config.PLANNER_URL as string;
    }
    if (config.PLANNER_API_KEY) {
      this.PLANNER_API_KEY = config.PLANNER_API_KEY as string;
    }
    if (config.TASK_POLLING_INTERVAL) {
      this.TASK_POLLING_INTERVAL = config.TASK_POLLING_INTERVAL as number;
    }
    if (config.TASK_STATUS_START) {
      this.TASK_STATUS_START = config.TASK_STATUS_START as string;
    }
    if (config.TASK_STATUS_END) {
      this.TASK_STATUS_END = config.TASK_STATUS_END as string;
    }
    if (config.QODER_CLI) {
      this.QODER_CLI = config.QODER_CLI as string;
    }
    if (config.QODER_AUTH_CHECK) {
      this.QODER_AUTH_CHECK = config.QODER_AUTH_CHECK as string;
    }
    if (config.QODER_MODEL) {
      this.QODER_MODEL = config.QODER_MODEL as string;
    }
    if (config.GIT_USER_NAME) {
      this.GIT_USER_NAME = config.GIT_USER_NAME as string;
    }
    if (config.GIT_USER_EMAIL) {
      this.GIT_USER_EMAIL = config.GIT_USER_EMAIL as string;
    }
    if (config.GITHUB_TOKEN) {
      this.GITHUB_TOKEN = config.GITHUB_TOKEN as string;
    }
    if (config.GIT_SSH_PRIVATE_KEY) {
      this.GIT_SSH_PRIVATE_KEY = config.GIT_SSH_PRIVATE_KEY as string;
    }
    if (config.GIT_SSH_SIGNING) {
      this.GIT_SSH_SIGNING = config.GIT_SSH_SIGNING as string;
    }
    if (config.GIT_GPG_PRIVATE_KEY) {
      this.GIT_GPG_PRIVATE_KEY = config.GIT_GPG_PRIVATE_KEY as string;
    }
    if (config.GIT_GPG_KEY_ID) {
      this.GIT_GPG_KEY_ID = config.GIT_GPG_KEY_ID as string;
    }
    if (config.GIT_GPG_PASSPHRASE) {
      this.GIT_GPG_PASSPHRASE = config.GIT_GPG_PASSPHRASE as string;
    }

    if (config.AGENT_CONFIG_REPOSITORY) {
      this.AGENT_CONFIG_REPOSITORY = config.AGENT_CONFIG_REPOSITORY as string;
    }
    if (config.AGENT_CONFIG_BRANCH) {
      this.AGENT_CONFIG_BRANCH = config.AGENT_CONFIG_BRANCH as string;
    }
    if (config.AGENT_CONFIG_FOLDER) {
      this.AGENT_CONFIG_FOLDER = config.AGENT_CONFIG_FOLDER as string;
    }
    if (config.AGENT_CONFIG_SYNC_INTERVAL) {
      this.AGENT_CONFIG_SYNC_INTERVAL =
        config.AGENT_CONFIG_SYNC_INTERVAL as number;
    }

    if (config.OPENTELEMETRY_COLLECTOR_HTTP_TRACES) {
      this.OPENTELEMETRY_COLLECTOR_HTTP_TRACES =
        config.OPENTELEMETRY_COLLECTOR_HTTP_TRACES as string;
    }
    if (config.OPENTELEMETRY_COLLECTOR_HTTP_METRICS) {
      this.OPENTELEMETRY_COLLECTOR_HTTP_METRICS =
        config.OPENTELEMETRY_COLLECTOR_HTTP_METRICS as string;
    }
    if (config.OPENTELEMETRY_COLLECTOR_HTTP_LOGS) {
      this.OPENTELEMETRY_COLLECTOR_HTTP_LOGS =
        config.OPENTELEMETRY_COLLECTOR_HTTP_LOGS as string;
    }
    if (config.OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER) {
      this.OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER =
        config.OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER as string;
    }

    if (process.env.DATA_DIR) {
      this.DATA_DIR = process.env.DATA_DIR;
    }
    if (process.env.TMP_DIR) {
      this.TMP_DIR = process.env.TMP_DIR;
    }
    if (process.env.DEV_MODE) {
      this.DEV_MODE = process.env.DEV_MODE === "true";
    }
    if (process.env.AGENT_NAME) {
      this.AGENT_NAME = process.env.AGENT_NAME;
    }
    if (process.env.PLANNER_URL) {
      this.PLANNER_URL = process.env.PLANNER_URL;
    }
    if (process.env.PLANNER_API_KEY) {
      this.PLANNER_API_KEY = process.env.PLANNER_API_KEY;
    }
    if (process.env.TASK_POLLING_INTERVAL) {
      this.TASK_POLLING_INTERVAL = parseInt(process.env.TASK_POLLING_INTERVAL);
    }
    if (process.env.TASK_STATUS_START) {
      this.TASK_STATUS_START = process.env.TASK_STATUS_START;
    }
    if (process.env.TASK_STATUS_END) {
      this.TASK_STATUS_END = process.env.TASK_STATUS_END;
    }
    if (process.env.QODER_CLI) {
      this.QODER_CLI = process.env.QODER_CLI;
    }
    if (process.env.QODER_AUTH_CHECK) {
      this.QODER_AUTH_CHECK = process.env.QODER_AUTH_CHECK;
    }
    if (process.env.QODER_MODEL) {
      this.QODER_MODEL = process.env.QODER_MODEL;
    }
    if (process.env.GIT_USER_NAME) {
      this.GIT_USER_NAME = process.env.GIT_USER_NAME;
    }
    if (process.env.GIT_USER_EMAIL) {
      this.GIT_USER_EMAIL = process.env.GIT_USER_EMAIL;
    }
    if (process.env.GITHUB_TOKEN) {
      this.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    }
    if (process.env.GIT_SSH_PRIVATE_KEY) {
      this.GIT_SSH_PRIVATE_KEY = process.env.GIT_SSH_PRIVATE_KEY;
    }
    if (process.env.GIT_SSH_SIGNING) {
      this.GIT_SSH_SIGNING = process.env.GIT_SSH_SIGNING;
    }
    if (process.env.GIT_GPG_PRIVATE_KEY) {
      this.GIT_GPG_PRIVATE_KEY = process.env.GIT_GPG_PRIVATE_KEY;
    }
    if (process.env.GIT_GPG_KEY_ID) {
      this.GIT_GPG_KEY_ID = process.env.GIT_GPG_KEY_ID;
    }
    if (process.env.GIT_GPG_PASSPHRASE) {
      this.GIT_GPG_PASSPHRASE = process.env.GIT_GPG_PASSPHRASE;
    }
    if (process.env.AGENT_CONFIG_REPOSITORY) {
      this.AGENT_CONFIG_REPOSITORY = process.env.AGENT_CONFIG_REPOSITORY;
    }
    if (process.env.AGENT_CONFIG_BRANCH) {
      this.AGENT_CONFIG_BRANCH = process.env.AGENT_CONFIG_BRANCH;
    }
    if (process.env.AGENT_CONFIG_FOLDER) {
      this.AGENT_CONFIG_FOLDER = process.env.AGENT_CONFIG_FOLDER;
    }
    if (process.env.AGENT_CONFIG_SYNC_INTERVAL) {
      this.AGENT_CONFIG_SYNC_INTERVAL = parseInt(
        process.env.AGENT_CONFIG_SYNC_INTERVAL,
      );
    }
    if (process.env.OPENTELEMETRY_COLLECTOR_HTTP_TRACES) {
      this.OPENTELEMETRY_COLLECTOR_HTTP_TRACES =
        process.env.OPENTELEMETRY_COLLECTOR_HTTP_TRACES;
    }
    if (process.env.OPENTELEMETRY_COLLECTOR_HTTP_METRICS) {
      this.OPENTELEMETRY_COLLECTOR_HTTP_METRICS =
        process.env.OPENTELEMETRY_COLLECTOR_HTTP_METRICS;
    }
    if (process.env.OPENTELEMETRY_COLLECTOR_HTTP_LOGS) {
      this.OPENTELEMETRY_COLLECTOR_HTTP_LOGS =
        process.env.OPENTELEMETRY_COLLECTOR_HTTP_LOGS;
    }
    if (process.env.OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER) {
      this.OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER =
        process.env.OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER;
    }
  }

  public validate(): string[] {
    const errors: string[] = [];

    if (!this.AGENT_NAME || this.AGENT_NAME.trim().length === 0) {
      errors.push("AGENT_NAME is required");
    }

    if (!this.PLANNER_URL || this.PLANNER_URL.trim().length === 0) {
      errors.push("PLANNER_URL is required");
    } else if (!isValidHttpUrl(this.PLANNER_URL)) {
      errors.push(
        `PLANNER_URL must be a valid http(s) URL (current value: '${this.PLANNER_URL}')`,
      );
    }

    if (!this.PLANNER_API_KEY || this.PLANNER_API_KEY.trim().length === 0) {
      errors.push("PLANNER_API_KEY is required");
    }

    if (
      !Number.isInteger(this.TASK_POLLING_INTERVAL) ||
      this.TASK_POLLING_INTERVAL <= 0
    ) {
      errors.push(
        `TASK_POLLING_INTERVAL must be a positive integer (current value: '${this.TASK_POLLING_INTERVAL}')`,
      );
    }

    if (this.AGENT_CONFIG_REPOSITORY.trim().length > 0) {
      if (this.AGENT_CONFIG_BRANCH.trim().length === 0) {
        errors.push(
          "AGENT_CONFIG_BRANCH must not be empty when AGENT_CONFIG_REPOSITORY is set",
        );
      }
      if (
        !Number.isInteger(this.AGENT_CONFIG_SYNC_INTERVAL) ||
        this.AGENT_CONFIG_SYNC_INTERVAL <= 0
      ) {
        errors.push(
          `AGENT_CONFIG_SYNC_INTERVAL must be a positive integer (current value: '${this.AGENT_CONFIG_SYNC_INTERVAL}')`,
        );
      }
    }

    return errors;
  }
}
