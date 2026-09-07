import * as fse from "fs-extra";
import * as path from "path";
import { Config } from "./Config";
import { OTelLogger } from "./OTelContext";
import { PlannerClient, PlannerTask } from "./PlannerClient";
import { QoderClient } from "./QoderClient";

const logger = OTelLogger().createModuleLogger("agent");

const AGENT_NOTES_MARKER =
  "<!-- AGENT-NOTES: the content below is maintained by the Qoder agent. Do not remove this marker. -->";

export class Agent {
  private config: Config;
  private planner: PlannerClient;
  private qoder: QoderClient;
  private pollingTimer?: NodeJS.Timeout;

  constructor(config: Config) {
    this.config = config;
    this.planner = new PlannerClient(config);
    this.qoder = new QoderClient(config);
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
      // Only tasks in the start status are ready: nothing is logged until a
      // task is actually ready to be processed, to keep the logs quiet.
      const actionableTasks = tasks.filter(
        (task) => task.status === this.config.TASK_STATUS_START,
      );
      for (const task of actionableTasks) {
        await this.processTask(task);
      }
    } catch (error) {
      logger.error(
        `Failed to poll tasks from Planner: ${(error as Error).message}`,
      );
    }
  }

  private async processTask(task: PlannerTask): Promise<void> {
    logger.info(
      `Processing task '${task.title}' (${task.id}) in status '${task.status}'`,
    );
    try {
      const notesFile = this.getTaskNotesFile(task.id);
      await this.writeTaskNotes(task, notesFile);
      const summary = await this.qoder.performTask(task, notesFile);
      await this.planner.addTaskComment(task.id, summary);
      await this.planner.updateTaskStatus(task.id, this.config.TASK_STATUS_END);
      logger.info(
        `Task '${task.title}' (${task.id}) completed and moved to status '${this.config.TASK_STATUS_END}'`,
      );
    } catch (error) {
      logger.error(
        `Failed to process task '${task.title}' (${task.id}): ${(error as Error).message}`,
      );
    }
  }

  private getTaskNotesFile(taskId: string): string {
    return path.join(this.config.DATA_DIR, "tasks", `${taskId}-Agent.md`);
  }

  private async writeTaskNotes(
    task: PlannerTask,
    notesFile: string,
  ): Promise<void> {
    // Preserve the agent notes from previous runs; the task brief (description
    // and comments) is always refreshed with the latest Planner content.
    let agentNotes = "\n\n## Agent Notes\n";
    if (await fse.pathExists(notesFile)) {
      const existing = await fse.readFile(notesFile, "utf8");
      const markerIndex = existing.indexOf(AGENT_NOTES_MARKER);
      if (markerIndex >= 0) {
        agentNotes = existing.slice(markerIndex + AGENT_NOTES_MARKER.length);
      }
    }

    const comments = task.comments
      .map(
        (comment) =>
          `- **${comment.userName || comment.userId}** (${comment.dateCreated}): ${comment.text}`,
      )
      .join("\n");
    const brief = [
      `# Task: ${task.title}`,
      "",
      `- **ID**: ${task.id}`,
      `- **Status**: ${task.status}`,
      "",
      "## Description",
      "",
      task.description.trim().length > 0 ? task.description : "*(empty)*",
      "",
      "## Comments",
      "",
      comments.length > 0 ? comments : "*(none)*",
      "",
      AGENT_NOTES_MARKER,
    ].join("\n");

    await fse.ensureDir(path.dirname(notesFile));
    await fse.writeFile(notesFile, brief + agentNotes);
  }
}
