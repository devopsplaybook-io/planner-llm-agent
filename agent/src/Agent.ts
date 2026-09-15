import * as fse from "fs-extra";
import * as path from "path";
import { AgentAction, AgentActionsConfig } from "./AgentActions";
import { Config } from "./Config";
import { createCliAgent } from "./clients/CliAgentRegistry";
import type { CliAgentClient } from "./clients/CliAgent";
import { OTelLogger } from "./OTelContext";
import { PlannerClient, PlannerProject, PlannerTask } from "./PlannerClient";

const logger = OTelLogger().createModuleLogger("agent");

const AGENT_NOTES_MARKER =
  "<!-- AGENT-NOTES: the content below is maintained by the planner agent. Do not remove this marker. -->";

// Maximum length of the failure explanation posted on a task.
const MAX_FAILURE_EXPLANATION_LENGTH = 1000;

export class Agent {
  private config: Config;
  private agentActions: AgentActionsConfig | null;
  private planner: PlannerClient;
  private cliAgent: CliAgentClient;
  private pollingTimer?: NodeJS.Timeout;
  // Tasks currently being processed: they are never picked again by a
  // subsequent poll while their processing is still running.
  private processingTasks = new Set<string>();

  constructor(config: Config, agentActions?: AgentActionsConfig | null) {
    this.config = config;
    this.agentActions = agentActions ?? null;
    this.planner = new PlannerClient(config);
    this.cliAgent = createCliAgent(config, this.agentActions);
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
      const actions = this.getActions();
      if (actions.length === 0 || tasks.length === 0) {
        return;
      }
      // The projects are loaded lazily, once per poll: the project-bound
      // actions match on the project names, and the task brief includes the
      // project name and description.
      let projects: Map<string, PlannerProject> | null = null;
      const loadProjects =
        async (): Promise<Map<string, PlannerProject>> => {
          if (projects === null) {
            const list = await this.planner.listProjects();
            projects = new Map(list.map((project) => [project.id, project]));
          }
          return projects;
        };
      if (actions.some((action) => action.project.length > 0)) {
        await loadProjects();
      }
      // Only tasks matching an action are ready, and a task already being
      // processed is never picked again by a subsequent poll. Every matching
      // (task, action) pair is a candidate; the free slots are then filled
      // from the candidates sorted by queue priority. The parallel limit is
      // shared by every action.
      const freeSlots =
        this.config.TASK_MAX_PARALLEL - this.processingTasks.size;
      const candidates: { task: PlannerTask; action: AgentAction }[] = [];
      for (const action of actions) {
        for (const task of tasks) {
          if (
            !this.matchesAction(task, action, projects) ||
            this.processingTasks.has(task.id) ||
            candidates.some((selected) => selected.task.id === task.id)
          ) {
            continue;
          }
          candidates.push({ task, action });
        }
      }
      // Queue order: higher priorities first; within the same priority the
      // task whose last update is the oldest is picked first. The sort is
      // stable, so equal candidates keep the actions configuration order.
      candidates.sort(
        (a, b) =>
          priorityRank(b.task.priority) - priorityRank(a.task.priority) ||
          dateUpdatedValue(a.task.dateUpdated) -
            dateUpdatedValue(b.task.dateUpdated),
      );
      const tasksToProcess = candidates.slice(0, Math.max(freeSlots, 0));
      if (tasksToProcess.length === 0) {
        return;
      }
      const projectMap = await loadProjects();
      for (const { task } of tasksToProcess) {
        this.processingTasks.add(task.id);
      }
      // Each task manages its own error handling and in-flight cleanup.
      await Promise.all(
        tasksToProcess.map(({ task, action }) =>
          this.processTask(
            task,
            action,
            projectMap.get(task.projectId) ?? null,
          ),
        ),
      );
    } catch (error) {
      logger.error(
        `Failed to poll tasks from Planner: ${(error as Error).message}`,
      );
    }
  }

  // The actions drive which tasks are picked and how they are processed.
  // They come from the agent actions configuration; without it no task
  // is processed.
  private getActions(): AgentAction[] {
    return this.agentActions?.actions ?? [];
  }

  // A task matches an action when its status is the action start status and
  // its project is the action project (an empty project matches any
  // project). A task whose project cannot be resolved never matches a
  // project-bound action.
  private matchesAction(
    task: PlannerTask,
    action: AgentAction,
    projects: Map<string, PlannerProject> | null,
  ): boolean {
    if (task.status !== action.statusStart) {
      return false;
    }
    if (action.project.length === 0) {
      return true;
    }
    if (projects === null || task.projectId.length === 0) {
      return false;
    }
    return projects.get(task.projectId)?.name === action.project;
  }

  private async processTask(
    task: PlannerTask,
    action: AgentAction,
    project: PlannerProject | null,
  ): Promise<void> {
    logger.info(
      `Processing task '${task.title}' (${task.id}) in status '${task.status}'`,
    );
    await this.postStartComment(task);
    try {
      const notesFile = this.getTaskNotesFile(task.id);
      await this.writeTaskNotes(task, notesFile, project);
      // The model resolves to the action model, then the actions default
      // model; the task description still overrides both (see
      // BaseCliAgent.resolveModel).
      const defaultModel =
        action.model || this.agentActions?.defaultModel || "";
      // The timeout resolves to the action timeout, then the actions
      // default timeout; when neither is configured the global TASK_TIMEOUT
      // (which defaults to 1 hour) applies (see BaseCliAgent.performTask).
      const summary = await this.cliAgent.performTask(task, notesFile, {
        model: defaultModel,
        instruction: action.instruction,
        timeoutSeconds:
          action.timeout ??
          this.agentActions?.defaultTimeout ??
          this.config.TASK_TIMEOUT,
      });
      await this.planner.addTaskComment(task.id, summary);
      await this.planner.updateTaskStatus(task.id, action.statusEnd);
      logger.info(
        `Task '${task.title}' (${task.id}) completed and moved to status '${action.statusEnd}'`,
      );
      await this.cleanupTaskFolderIfNeeded(task.id, action.statusEnd);
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
          buildFailureComment(message, action.statusEnd),
        );
        await this.planner.updateTaskStatus(task.id, action.statusEnd);
        logger.info(
          `Task '${task.title}' (${task.id}) moved to status '${action.statusEnd}' after a processing failure`,
        );
        await this.cleanupTaskFolderIfNeeded(task.id, action.statusEnd);
      } catch (cleanupError) {
        logger.error(
          `Failed to move task '${task.title}' (${task.id}) to status '${action.statusEnd}' after the processing failure: ${(cleanupError as Error).message}`,
        );
      }
    } finally {
      this.processingTasks.delete(task.id);
    }
  }

  // Notifies the user that the agent started working on the task.
  // Best-effort: a notification failure is logged but must not fail the
  // task processing.
  private async postStartComment(task: PlannerTask): Promise<void> {
    try {
      await this.planner.addTaskComment(
        task.id,
        `Agent '${this.config.AGENT_NAME}' started working on this task.`,
      );
    } catch (error) {
      logger.error(
        `Failed to post the start notification for task '${task.title}' (${task.id}): ${(error as Error).message}`,
      );
    }
  }

  private getTaskNotesFile(taskId: string): string {
    return path.join(this.config.DATA_DIR, "tasks", `${taskId}-Agent.md`);
  }

  private getTaskSummaryFile(taskId: string): string {
    return path.join(
      this.config.DATA_DIR,
      "tasks",
      `${taskId}-Agent-Summary.md`,
    );
  }

  private getTaskDir(taskId: string): string {
    return path.join(this.config.DATA_DIR, "tasks", taskId);
  }

  private async writeTaskNotes(
    task: PlannerTask,
    notesFile: string,
    project: PlannerProject | null,
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
              (attachment) => `- ${attachment.fileName} (download failed)`,
            )
          : ["*(none)*"];
    const brief = [
      `# Task: ${task.title}`,
      "",
      `- **ID**: ${task.id}`,
      `- **Status**: ${task.status}`,
      `- **Project**: ${project?.name ?? task.projectId}`,
      "",
      "## Description",
      "",
      task.description.trim().length > 0 ? task.description : "*(empty)*",
      "",
      // The project section is only rendered when the project has a
      // description.
      ...(project !== null && project.description.trim().length > 0
        ? ["## Project", "", project.description, ""]
        : []),
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

  private async cleanupTaskFolderIfNeeded(
    taskId: string,
    endStatus: string,
  ): Promise<void> {
    if (endStatus === this.config.TASK_STATUS_CLEANUP) {
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

// Queue order of the priorities: higher ranks are picked first. Unknown or
// missing priorities rank as medium, the Planner default.
const PRIORITY_RANKS: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function priorityRank(priority: string): number {
  return PRIORITY_RANKS[priority] ?? PRIORITY_RANKS.medium;
}

// Sort key of the task last update, ascending: the oldest update comes
// first. A missing or unparsable date sorts as the oldest task.
function dateUpdatedValue(dateUpdated: string): number {
  const time = Date.parse(dateUpdated);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
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
