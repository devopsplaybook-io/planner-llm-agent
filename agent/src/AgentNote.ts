import * as fse from "fs-extra";
import * as path from "path";
import { AgentActionsConfig } from "./AgentActions";
import { getAgentConfigContentPath } from "./AgentConfigRepository";
import { Config, githubTokenEnvName } from "./Config";
import { OTelLogger, OTelTracer } from "./OTelContext";
import { PlannerClient, PlannerNote, PlannerProject } from "./PlannerClient";
import { QoderClient, readCredits } from "./QoderClient";

const logger = OTelLogger().createModuleLogger("agent-note");

const MAX_SKILLS_LISTED = 20;
const MAX_RECENT_TASKS = 10;
const MAX_INSTRUCTION_SHOWN = 100;
const NOTE_TITLE_PREFIX = "Planner LLM Agent: ";

export class AgentNote {
  private config: Config;
  private planner: PlannerClient;
  private qoder: QoderClient;
  private agentActions: AgentActionsConfig | null;
  private updating = false;

  constructor(
    config: Config,
    planner: PlannerClient,
    qoder: QoderClient,
    agentActions: AgentActionsConfig | null,
  ) {
    this.config = config;
    this.planner = planner;
    this.qoder = qoder;
    this.agentActions = agentActions;
  }

  // The note title is user-friendly and contains the agent name.
  private get noteTitle(): string {
    return `${NOTE_TITLE_PREFIX}${this.config.AGENT_NAME.trim()}`;
  }

  // The note is enabled when an interval is configured and the target
  // project is set.
  public isEnabled(): boolean {
    return (
      this.config.AGENT_NOTE_INTERVAL > 0 &&
      this.config.AGENT_NOTE_PROJECT.trim().length > 0
    );
  }

  // Generate the note content with the LLM and create or update the single
  // note named after the agent in the configured project. Called when the
  // agent starts and then on the configured interval.
  public async update(): Promise<void> {
    if (this.updating) {
      return;
    }
    const span = OTelTracer().startSpan("agent-note.update");
    this.updating = true;
    try {
      const project = await this.resolveProject();
      const content = await this.generateContent();
      const existing = await this.findAgentNote(project);
      if (existing) {
        // The title is kept canonical on every update, so a note created
        // with the previous plain-name title is retitled as well.
        await this.planner.updateNote(existing.id, content, this.noteTitle);
        logger.info(`Agent note updated in project '${project.name}'`);
      } else {
        await this.planner.createNote(project.id, this.noteTitle, content);
        logger.info(`Agent note created in project '${project.name}'`);
      }
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      this.updating = false;
      span.end();
    }
  }

  // The single agent note in the given project, matched by its title. A
  // note titled with the plain agent name (previous format) is also
  // recognized and adopted.
  private async findAgentNote(
    project: PlannerProject,
  ): Promise<PlannerNote | undefined> {
    const agentName = this.config.AGENT_NAME.trim();
    const notes = await this.planner.listNotes(project.id);
    return notes.find(
      (note) => note.title === this.noteTitle || note.title === agentName,
    );
  }

  // The configured project is matched by id first, then by name
  // (case-insensitive).
  private async resolveProject(): Promise<PlannerProject> {
    const wanted = this.config.AGENT_NOTE_PROJECT.trim();
    const projects = await this.planner.listProjects();
    const found =
      projects.find((project) => project.id === wanted) ??
      projects.find(
        (project) => project.name.toLowerCase() === wanted.toLowerCase(),
      );
    if (!found) {
      throw new Error(
        `Agent note project '${wanted}' not found in Planner (visible projects: ${projects.map((project) => project.name).join(", ") || "none"})`,
      );
    }
    return found;
  }

  private async generateContent(): Promise<string> {
    const facts = await this.collectFacts();
    const prompt = [
      "You are writing a status note about an autonomous AI agent, published in the Planner application for the team to read. Write the note in markdown.",
      "",
      "Facts about the agent:",
      ...facts,
      "",
      "Write the updated content of the agent note. Structure it with short markdown sections (About, Skills, Recent activity, Status). Only use the facts above; do not invent information. Keep it concise (maximum 40 lines). Reply with the note content only.",
    ].join("\n");
    const content = (await this.qoder.runPrompt(prompt)).trim();
    if (content.length === 0) {
      throw new Error("Agent note content generation returned an empty reply");
    }
    return content;
  }

  private async collectFacts(): Promise<string[]> {
    const config = this.config;
    const skills = await this.listSkills();
    const tasks = await this.listRecentTasks();
    const credits = await readCredits(config);
    // The actions default.model is the only configurable default model; the
    // CLI default applies when it is not set.
    const actionsModel = this.agentActions?.defaultModel.trim() ?? "";
    const defaultModel =
      actionsModel.length > 0 ? actionsModel : "auto (CLI default)";
    const githubTokenEntries = config.githubTokenEntries();
    const gitEnabled =
      config.GITHUB_TOKEN.trim().length > 0 ||
      githubTokenEntries.length > 0 ||
      config.GIT_SSH_PRIVATE_KEY.trim().length > 0;
    const signing =
      config.GIT_SSH_SIGNING === "true"
        ? "SSH key signing"
        : config.GIT_GPG_PRIVATE_KEY.trim().length > 0
          ? "GPG signing"
          : "no signing";
    const configRepo = config.AGENT_CONFIG_REPOSITORY.trim();
    const configRepoFact =
      configRepo.length > 0
        ? `${configRepo} (branch ${config.AGENT_CONFIG_BRANCH.trim()}, folder ${config.AGENT_CONFIG_FOLDER.trim() || "root"})`
        : "not configured";
    const uptimeSeconds = Math.round(process.uptime());
    const uptime =
      uptimeSeconds >= 3600
        ? `${Math.floor(uptimeSeconds / 3600)}h ${Math.round((uptimeSeconds % 3600) / 60)}m`
        : `${Math.floor(uptimeSeconds / 60)}m`;
    return [
      `- Name: ${config.AGENT_NAME.trim()}`,
      `- Version: ${config.VERSION}`,
      `- Current date: ${new Date().toISOString()}`,
      `- Current session uptime: ${uptime}`,
      `- Default model: ${defaultModel}`,
      ...this.agentActionsFacts(),
      `- Git and GitHub integration: ${gitEnabled ? "configured" : "not configured"}`,
      `- GitHub organizations with dedicated tokens: ${
        githubTokenEntries.length > 0
          ? githubTokenEntries
              .map(
                (entry) =>
                  `${entry.organization} (${githubTokenEnvName(entry.organization)})`,
              )
              .join(", ")
          : "none"
      }`,
      `- Commit signing: ${signing}`,
      `- Agent configuration repository: ${configRepoFact}`,
      `- Skills available: ${skills.length > 0 ? skills.join(", ") : "none"}`,
      `- Tasks executed so far: ${tasks.count}`,
      `- Recent tasks: ${tasks.recent.length > 0 ? tasks.recent.join(" | ") : "none"}`,
      `- Qoder account credits remaining: ${credits !== null ? credits.toFixed(2) : "unknown"}`,
    ];
  }

  // The agent actions configuration describes which tasks the agent
  // processes and how: it is listed so the note can present the mission of
  // the agent to the team.
  private agentActionsFacts(): string[] {
    if (this.agentActions === null) {
      return ["- Agent actions: not configured (no task will be processed)"];
    }
    if (this.agentActions.actions.length === 0) {
      return ["- Agent actions: none defined (no task will be processed)"];
    }
    return [
      "- Agent actions:",
      ...this.agentActions.actions.map((action) => {
        const project =
          action.project.trim().length > 0
            ? `'${action.project.trim()}'`
            : "any project";
        const model =
          action.model.trim().length > 0
            ? `model ${action.model.trim()}`
            : "default model";
        const instruction = action.instruction.trim().replace(/\s+/g, " ");
        const instructionPart =
          instruction.length > 0
            ? `, instruction: ${truncate(instruction)}`
            : "";
        return `  - Project ${project}, status '${action.statusStart}' -> '${action.statusEnd}', ${model}${instructionPart}`;
      }),
    ];
  }

  // Top-level entries of the synced agent config content (skills and other
  // resources the agent can use).
  private async listSkills(): Promise<string[]> {
    const contentPath = getAgentConfigContentPath(this.config);
    if (!(await fse.pathExists(contentPath))) {
      return [];
    }
    const entries = await fse.readdir(contentPath);
    return entries
      .filter((entry) => !entry.startsWith("."))
      .sort()
      .slice(0, MAX_SKILLS_LISTED);
  }

  // Task documentation files kept in DATA_DIR: their names and the task
  // titles extracted from the file headers.
  private async listRecentTasks(): Promise<{
    count: number;
    recent: string[];
  }> {
    const tasksDir = path.join(this.config.DATA_DIR, "tasks");
    if (!(await fse.pathExists(tasksDir))) {
      return { count: 0, recent: [] };
    }
    const files = (await fse.readdir(tasksDir)).filter((file) =>
      file.endsWith("-Agent.md"),
    );
    const stats = await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(tasksDir, file);
        return { filePath, mtimeMs: (await fse.stat(filePath)).mtimeMs };
      }),
    );
    stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const recent: string[] = [];
    for (const stat of stats.slice(0, MAX_RECENT_TASKS)) {
      try {
        const content = await fse.readFile(stat.filePath, "utf8");
        const match = content.match(/^# Task: (.+)$/m);
        if (match) {
          recent.push(match[1].trim());
        }
      } catch {
        // Skip unreadable task files.
      }
    }
    return { count: files.length, recent };
  }
}

// Instructions are shown as a one-line excerpt in the note facts.
function truncate(text: string): string {
  return text.length > MAX_INSTRUCTION_SHOWN
    ? `${text.slice(0, MAX_INSTRUCTION_SHOWN)}...`
    : text;
}
