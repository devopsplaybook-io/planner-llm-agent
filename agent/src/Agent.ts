import { Config } from "./Config";
import { OTelLogger } from "./OTelContext";
import { PlannerClient } from "./PlannerClient";

const logger = OTelLogger().createModuleLogger("agent");

export class Agent {
  private config: Config;
  private planner: PlannerClient;
  private pollingTimer?: NodeJS.Timeout;

  constructor(config: Config) {
    this.config = config;
    this.planner = new PlannerClient(config);
  }

  public start(): void {
    logger.info(
      `Agent '${this.config.AGENT_NAME}' started (polling every ${this.config.TASK_POLLING_INTERVAL} seconds)`,
    );
    void this.pollForTasks();
    this.pollingTimer = setInterval(() => {
      void this.pollForTasks();
    }, this.config.TASK_POLLING_INTERVAL * 1000);
  }

  public stop(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
      logger.info(`Agent '${this.config.AGENT_NAME}' stopped`);
    }
  }

  private async pollForTasks(): Promise<void> {
    try {
      const user = await this.planner.getCurrentUser();
      const tasks = await this.planner.listAssignedTasks(user);
      if (tasks.length === 0) {
        logger.info(`No tasks currently assigned to '${user.name}'`);
        return;
      }
      logger.info(`Tasks assigned to '${user.name}' (${tasks.length}):`);
      for (const task of tasks) {
        logger.info(`  - [${task.status}] ${task.title}`);
      }
    } catch (error) {
      logger.error(
        `Failed to poll tasks from Planner: ${(error as Error).message}`,
      );
    }
  }
}
