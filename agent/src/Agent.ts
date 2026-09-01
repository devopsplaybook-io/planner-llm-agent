import { Config } from "./Config";
import { OTelLogger } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("agent");

export class Agent {
  private config: Config;
  private pollingTimer?: NodeJS.Timeout;

  constructor(config: Config) {
    this.config = config;
  }

  public start(): void {
    logger.info(
      `Agent '${this.config.AGENT_NAME}' started (polling every ${this.config.TASK_POLLING_INTERVAL} seconds)`,
    );
    this.pollingTimer = setInterval(() => {
      this.pollForTask();
    }, this.config.TASK_POLLING_INTERVAL * 1000);
  }

  public stop(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
      logger.info(`Agent '${this.config.AGENT_NAME}' stopped`);
    }
  }

  private pollForTask(): void {
    // Placeholder: the Planner integration is not implemented yet.
    // The next assigned task will be fetched from the Planner instance here.
    logger.info("Polling for assigned task from Planner (placeholder)");
  }
}
