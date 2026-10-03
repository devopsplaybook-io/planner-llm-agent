import { writeFileSync } from "fs";
import { join } from "path";
import { OTelLogger } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("heartbeat");

// The heartbeat file is the liveness/readiness signal of the Kubernetes
// deployment (exec probes fail when the file is older than their freshness
// threshold): a hung event loop stops the timer, the file goes stale and
// the pod is marked unready then restarted. The interval must stay well
// below the probe thresholds of the deployment manifest.
const HEARTBEAT_INTERVAL_MS = 15000;

export class Heartbeat {
  private readonly filePath: string;
  private timer?: NodeJS.Timeout;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "agent-heartbeat");
  }

  start(): void {
    this.touch();
    this.timer = setInterval(() => this.touch(), HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
  }

  // Best-effort: a transient write failure must not kill the agent; the
  // next tick retries and the probes catch a persistently unwritable data
  // directory.
  private touch(): void {
    try {
      writeFileSync(this.filePath, new Date().toISOString());
    } catch (error) {
      logger.warn(
        `Failed to refresh the heartbeat file '${this.filePath}': ${(error as Error).message}`,
      );
    }
  }
}
