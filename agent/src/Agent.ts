import * as fse from "fs-extra";
import * as path from "path";
import { Config } from "./Config";
import { OTelLogger } from "./OTelContext";
import { PlannerClient, PlannerTask } from "./PlannerClient";
import { QoderClient } from "./QoderClient";

const logger = OTelLogger().createModuleLogger("agent");

const AGENT_NOTES_MARKER =
  "<!-- AGENT-NOTES: the content below is maintained by the Qoder agent. Do not remove this marker. -->";

// Maximum length of the failure explanation posted on a task.
const MAX_FAILURE_EXPLANATION_LENGTH = 1000;

export class Agent {
  private config: Config;
  private planner: PlannerClient;
  private qoder: QoderClient;
  private pollingTimer?: NodeJS.Timeout;
  // Tasks currently being processed: they are never picked again by a
  // subsequent poll while their processing is still running.
  private processingTasks = new Set<string>();

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
      await this.cleanupCompletedTasks(tasks);
      // Only tasks in the start status are ready, and a task already being
      // processed is never picked again by a subsequent poll.
      const actionableTasks = tasks.filter(
        (task) =>
          task.status === this.config.TASK_STATUS_START &&
          !this.processingTasks.has(task.id),
      );
      const freeSlots =
        this.config.TASK_MAX_PARALLEL - this.processingTasks.size;
      if (freeSlots <= 0 || actionableTasks.length === 0) {
        return;
      }
      const tasksToProcess = actionableTasks.slice(0, freeSlots);
      for (const task of tasksToProcess) {
        this.processingTasks.add(task.id);
      }
      // Each task manages its own error handling and in-flight cleanup.
      await Promise.all(
        tasksToProcess.map((task) => this.processTask(task)),
      );
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
      await this.cleanupTaskFolderIfNeeded(task.id);
    } catch (error) {
      const message = (error as Error).message;
      logger.error(
        `Failed to process task '${task.title}' (${task.id}): ${message}`,
      );
      // A failing task must not block the agent by staying in the start
      // status forever: it is moved to the end status with an explanation.
      try {
        await this.planner.addTaskComment(
          task.id,
          buildFailureComment(message, this.config.TASK_STATUS_END),
        );
        await this.planner.updateTaskStatus(task.id, this.config.TASK_STATUS_END);
        logger.info(
          `Task '${task.title}' (${task.id}) moved to status '${this.config.TASK_STATUS_END}' after a processing failure`,
        );
        await this.cleanupTaskFolderIfNeeded(task.id);
      } catch (cleanupError) {
        logger.error(
          `Failed to move task '${task.title}' (${task.id}) to status '${this.config.TASK_STATUS_END}' after the processing failure: ${(cleanupError as Error).message}`,
        );
      }
    } finally {
      this.processingTasks.delete(task.id);
    }
  }

  private getTaskNotesFile(taskId: string): string {
    return path.join(this.config.DATA_DIR, "tasks", `${taskId}-Agent.md`);
  }

  private getTaskSummaryFile(taskId: string): string {
    return path.join(this.config.DATA_DIR, "tasks", `${taskId}-Agent-Summary.md`);
  }

  private getTaskDir(taskId: string): string {
    return path.join(this.config.DATA_DIR, "tasks", taskId);
  }

  private async writeTaskNotes(
    task: PlannerTask,
    notesFile: string,
  ): Promise<void> {
    // Preserve the agent notes from previous runs; the task brief (description,
    // comments and attachments) is always refreshed with the latest Planner content.
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
    const downloadedAttachments = await this.downloadAttachments(task);
    const attachmentLines =
      downloadedAttachments.length > 0
        ? downloadedAttachments.map(
            (filePath) => `- ${path.basename(filePath)} (${filePath})`,
          )
        : task.attachments.length > 0
          ? task.attachments.map(
              (attachment) =>
                `- ${attachment.fileName} (download failed)`,
            )
          : ["*(none)*"];
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
      "## Attachments",
      "",
      ...attachmentLines,
      "",
      AGENT_NOTES_MARKER,
    ].join("\n");

    await fse.ensureDir(path.dirname(notesFile));
    await fse.writeFile(notesFile, brief + agentNotes);
  }

  private async downloadAttachments(task: PlannerTask): Promise<string[]> {
    if (task.attachments.length === 0) {
      return [];
    }
    const attachmentsDir = path.join(this.getTaskDir(task.id), "attachments");
    await fse.ensureDir(attachmentsDir);
    const downloaded: string[] = [];
    for (const attachment of task.attachments) {
      try {
        const data = await this.planner.downloadTaskAttachment(
          task.id,
          attachment.id,
        );
        const filePath = path.join(attachmentsDir, attachment.fileName);
        await fse.writeFile(filePath, data);
        downloaded.push(filePath);
        logger.info(
          `Downloaded attachment '${attachment.fileName}' for task '${task.title}' (${task.id})`,
        );
      } catch (error) {
        logger.error(
          `Failed to download attachment '${attachment.fileName}' for task '${task.title}' (${task.id}): ${(error as Error).message}`,
        );
      }
    }
    return downloaded;
  }

  private async cleanupCompletedTasks(tasks: PlannerTask[]): Promise<void> {
    const tasksDir = path.join(this.config.DATA_DIR, "tasks");
    if (!(await fse.pathExists(tasksDir))) {
      return;
    }
    const assignedStatuses = new Map(
      tasks.map((task) => [task.id, task.status]),
    );
    const taskIdsToCheck = new Set<string>();
    for (const entry of await fse.readdir(tasksDir)) {
      const taskId = extractTaskId(entry);
      if (taskId && !this.processingTasks.has(taskId)) {
        taskIdsToCheck.add(taskId);
      }
    }
    for (const taskId of taskIdsToCheck) {
      const status = assignedStatuses.get(taskId);
      if (status === undefined || status === this.config.TASK_STATUS_CLEANUP) {
        await this.cleanupTaskFolder(taskId, status === undefined);
      }
    }
  }

  private async cleanupTaskFolderIfNeeded(taskId: string): Promise<void> {
    if (this.config.TASK_STATUS_END === this.config.TASK_STATUS_CLEANUP) {
      await this.cleanupTaskFolder(taskId, false);
    }
  }

  private async cleanupTaskFolder(
    taskId: string,
    missingFromPlanner: boolean,
  ): Promise<void> {
    const taskDir = this.getTaskDir(taskId);
    const notesFile = this.getTaskNotesFile(taskId);
    const summaryFile = this.getTaskSummaryFile(taskId);
    try {
      await fse.remove(taskDir);
      await fse.remove(notesFile);
      await fse.remove(summaryFile);
      const reason = missingFromPlanner
        ? "no longer assigned on Planner"
        : `reached status '${this.config.TASK_STATUS_CLEANUP}'`;
      logger.info(`Cleaned up task folder for task '${taskId}' (${reason})`);
    } catch (error) {
      logger.error(
        `Failed to clean up task folder for task '${taskId}': ${(error as Error).message}`,
      );
    }
  }
}

// Extracts a Planner task id (UUID) from a task file or directory name.
function extractTaskId(entry: string): string | undefined {
  const match = entry.match(
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  return match ? match[1].toLowerCase() : undefined;
}

// The comment posted on a task that failed to process: the explanation of
// the error, kept concise, and the resulting status change.
function buildFailureComment(message: string, endStatus: string): string {
  const explanation =
    message.length > MAX_FAILURE_EXPLANATION_LENGTH
      ? `${message.slice(0, MAX_FAILURE_EXPLANATION_LENGTH)}...`
      : message;
  return [
    "Task processing failed:",
    explanation,
    "",
    `The task was moved to '${endStatus}' so it does not block the agent. Check the agent logs for more details.`,
  ].join("\n");
}
