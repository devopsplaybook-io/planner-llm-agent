import * as fs from "fs-extra";
import * as path from "path";

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
}
