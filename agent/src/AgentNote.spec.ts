import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import { AgentActionsConfig } from "./AgentActions";
import { AgentNote, AgentSchedulingSnapshot } from "./AgentNote";
import { Config } from "./Config";
import { invalidateSkillsCache } from "./CoreSkills";
import { PlannerClient, PlannerProject } from "./PlannerClient";
import type { CliAgentClient } from "./clients/CliAgent";

jest.mock("./OTelContext", () => ({
  OTelTracer: jest.fn(() => ({
    startSpan: jest.fn(() => ({
      end: jest.fn(),
      setAttribute: jest.fn(),
      recordException: jest.fn(),
    })),
  })),
  OTelLogger: jest.fn(() => ({
    createModuleLogger: jest.fn(() => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    })),
  })),
}));

describe("AgentNote", () => {
  const tmpRoot = path.join(os.tmpdir(), "qoder-agent-note-spec");
  let config: Config;
  let planner: {
    listProjects: jest.Mock;
    listNotes: jest.Mock;
    createNote: jest.Mock;
    updateNote: jest.Mock;
  };
  let qoder: { runPrompt: jest.Mock; usageSummary: jest.Mock };
  let agentNote: AgentNote;

  beforeEach(() => {
    config = new Config();
    config.DATA_DIR = path.join(tmpRoot, "data");
    config.AGENT_NAME = "test-agent";
    config.AGENT_NOTE_PROJECT = "Agent Workspace";
    config.AGENT_NOTE_INTERVAL = 3600;
    // Hermetic core skills: an empty fixture directory (the default would
    // resolve to the repository's agent/skills directory). The listing cache
    // is module-global, so start every test cold.
    config.CORE_SKILLS_PATH = path.join(tmpRoot, "core-skills");
    invalidateSkillsCache();

    planner = {
      listProjects: jest.fn(),
      listNotes: jest.fn(),
      createNote: jest.fn(),
      updateNote: jest.fn(),
    };
    qoder = { runPrompt: jest.fn(), usageSummary: jest.fn() };
    qoder.usageSummary.mockResolvedValue("Qoder credits not reported by the CLI");
    agentNote = new AgentNote(
      config,
      planner as unknown as PlannerClient,
      qoder as unknown as CliAgentClient,
      null,
    );
  });

  afterEach(() => {
    fse.removeSync(tmpRoot);
  });

  const project: PlannerProject = {
    id: "p1",
    name: "Agent Workspace",
    description: "",
  };

  describe("isEnabled", () => {
    it("should be enabled when a project and a positive interval are set", () => {
      expect(agentNote.isEnabled()).toBe(true);
    });

    it("should be disabled when the interval is 0", () => {
      config.AGENT_NOTE_INTERVAL = 0;
      expect(agentNote.isEnabled()).toBe(false);
    });

    it("should be disabled when no project is configured", () => {
      config.AGENT_NOTE_PROJECT = "";
      expect(agentNote.isEnabled()).toBe(false);
    });
  });

  describe("update", () => {
    it("should create the note when it does not exist yet", async () => {
      planner.listProjects.mockResolvedValue([project]);
      planner.listNotes.mockResolvedValue([]);
      qoder.runPrompt.mockResolvedValue("# About\n\nGenerated content.");
      planner.createNote.mockResolvedValue({
        id: "n1",
        projectId: "p1",
        title: "test-agent",
        description: "# About\n\nGenerated content.",
      });

      await agentNote.update();

      expect(planner.createNote).toHaveBeenCalledWith(
        "p1",
        "Planner LLM Agent: test-agent",
        "# About\n\nGenerated content.",
      );
      expect(planner.updateNote).not.toHaveBeenCalled();
      expect(qoder.runPrompt).toHaveBeenCalledTimes(1);
    });

    it("labels the generation prompt as the agent note", async () => {
      planner.listProjects.mockResolvedValue([project]);
      planner.listNotes.mockResolvedValue([]);
      qoder.runPrompt.mockResolvedValue("content");
      planner.createNote.mockResolvedValue({ id: "n1" });

      await agentNote.update();

      expect(qoder.runPrompt).toHaveBeenCalledWith(expect.any(String), {
        purpose: "agent note",
      });
    });

    it("should update the existing note named after the agent", async () => {
      planner.listProjects.mockResolvedValue([project]);
      planner.listNotes.mockResolvedValue([
        {
          id: "n1",
          projectId: "p1",
          title: "Planner LLM Agent: test-agent",
          description: "old content",
        },
      ]);
      qoder.runPrompt.mockResolvedValue("new content");

      await agentNote.update();

      expect(planner.updateNote).toHaveBeenCalledWith(
        "n1",
        "new content",
        "Planner LLM Agent: test-agent",
      );
      expect(planner.createNote).not.toHaveBeenCalled();
    });

    it("should adopt a note created with the previous plain agent name title", async () => {
      planner.listProjects.mockResolvedValue([project]);
      planner.listNotes.mockResolvedValue([
        {
          id: "n1",
          projectId: "p1",
          title: "test-agent",
          description: "old content",
        },
      ]);
      qoder.runPrompt.mockResolvedValue("new content");

      await agentNote.update();

      expect(planner.updateNote).toHaveBeenCalledWith(
        "n1",
        "new content",
        "Planner LLM Agent: test-agent",
      );
      expect(planner.createNote).not.toHaveBeenCalled();
    });

    it("should resolve the configured project by id", async () => {
      config.AGENT_NOTE_PROJECT = "p2";
      planner.listProjects.mockResolvedValue([
        { id: "p1", name: "Other" },
        { id: "p2", name: "Second" },
      ]);
      planner.listNotes.mockResolvedValue([]);
      qoder.runPrompt.mockResolvedValue("content");
      planner.createNote.mockResolvedValue({ id: "n1" });

      await agentNote.update();

      expect(planner.listNotes).toHaveBeenCalledWith("p2");
    });

    it("should resolve the configured project by name case-insensitively", async () => {
      config.AGENT_NOTE_PROJECT = "agent workspace";
      planner.listProjects.mockResolvedValue([project]);
      planner.listNotes.mockResolvedValue([]);
      qoder.runPrompt.mockResolvedValue("content");
      planner.createNote.mockResolvedValue({ id: "n1" });

      await agentNote.update();

      expect(planner.listNotes).toHaveBeenCalledWith("p1");
    });

    it("should fail with the visible projects when the project is not found", async () => {
      planner.listProjects.mockResolvedValue([{ id: "p1", name: "Other" }]);

      await expect(agentNote.update()).rejects.toThrow(
        "Agent note project 'Agent Workspace' not found in Planner (visible projects: Other)",
      );
      expect(qoder.runPrompt).not.toHaveBeenCalled();
    });

    it("should run a single generation when called concurrently", async () => {
      planner.listNotes.mockResolvedValue([]);
      planner.createNote.mockResolvedValue({ id: "n1" });
      qoder.runPrompt.mockResolvedValue("content");
      let resolveProjects: (value: PlannerProject[]) => void = () => undefined;
      planner.listProjects.mockImplementation(
        () =>
          new Promise<PlannerProject[]>((resolve) => {
            resolveProjects = resolve;
          }),
      );

      const first = agentNote.update();
      const second = agentNote.update();
      // The second call is ignored while the first one is still running.
      expect(qoder.runPrompt).not.toHaveBeenCalled();

      resolveProjects([project]);
      await Promise.all([first, second]);

      expect(qoder.runPrompt).toHaveBeenCalledTimes(1);
      expect(planner.createNote).toHaveBeenCalledTimes(1);
    });

    it("should fail when the LLM returns an empty reply", async () => {
      planner.listProjects.mockResolvedValue([project]);
      qoder.runPrompt.mockResolvedValue("   ");

      await expect(agentNote.update()).rejects.toThrow(
        "Agent note content generation returned an empty reply",
      );
      expect(planner.createNote).not.toHaveBeenCalled();
      expect(planner.updateNote).not.toHaveBeenCalled();
    });

    it("should include the agent facts in the generation prompt", async () => {
      const agentConfigDir = path.join(config.DATA_DIR, "agent-config");
      await fse.ensureDir(agentConfigDir);
      await fse.writeFile(path.join(agentConfigDir, "git-workflow"), "");
      await fse.writeFile(path.join(agentConfigDir, "planner-usage"), "");
      await fse.writeFile(path.join(agentConfigDir, ".hidden"), "");

      const tasksDir = path.join(config.DATA_DIR, "tasks");
      await fse.ensureDir(tasksDir);
      await fse.writeFile(
        path.join(tasksDir, "0001-Agent.md"),
        "# Task: First task\n\nSome notes",
      );
      await fse.writeFile(
        path.join(tasksDir, "0002-Agent.md"),
        "# Task: Second task\n\nOther notes",
      );
      await fse.writeFile(path.join(tasksDir, "README.md"), "not a task");

      qoder.usageSummary.mockResolvedValue(
        "Qoder credits used by the last run: 12.50",
      );
      config.GITHUB_TOKEN = "github-token";
      config.GITHUB_TOKENS =
        "org-one=github_pat_aaaaaaaaaaaaaaaaaaaa,org-two=github_pat_bbbbbbbbbbbbbbbbbbbb";

      planner.listProjects.mockResolvedValue([project]);
      planner.listNotes.mockResolvedValue([]);
      qoder.runPrompt.mockResolvedValue("content");
      planner.createNote.mockResolvedValue({ id: "n1" });

      await agentNote.update();

      const prompt = qoder.runPrompt.mock.calls[0][0] as string;
      expect(prompt).toContain("test-agent");
      expect(prompt).toContain("Skills available: git-workflow, planner-usage");
      expect(prompt).not.toContain(".hidden");
      expect(prompt).toContain("Tasks executed so far: 2");
      expect(prompt).toContain("First task");
      expect(prompt).toContain("Second task");
      expect(prompt).toContain("12.50");
      expect(prompt).toContain("Git and GitHub integration: configured");
      expect(prompt).toContain(
        "GitHub organizations with dedicated tokens: org-one (GH_TOKEN_ORG_ONE), org-two (GH_TOKEN_ORG_TWO)",
      );
      expect(prompt).toContain(
        "Agent actions: not configured (no task will be processed)",
      );
      expect(prompt).toContain("Default model: auto (CLI default)");
    });

    it("should list the core skills together with the synced ones in the facts", async () => {
      await fse.outputFile(
        path.join(config.CORE_SKILLS_PATH, "planner-tasks", "SKILL.md"),
        [
          "---",
          "name: planner-tasks",
          'description: "Planner tasks."',
          "---",
        ].join("\n"),
      );
      const agentConfigDir = path.join(config.DATA_DIR, "agent-config");
      await fse.ensureDir(agentConfigDir);
      await fse.writeFile(path.join(agentConfigDir, "git-workflow"), "");

      planner.listProjects.mockResolvedValue([project]);
      planner.listNotes.mockResolvedValue([]);
      qoder.runPrompt.mockResolvedValue("content");
      planner.createNote.mockResolvedValue({ id: "n1" });

      await agentNote.update();

      const prompt = qoder.runPrompt.mock.calls[0][0] as string;
      expect(prompt).toContain("Skills available: git-workflow, planner-tasks");
    });
  });

  describe("agent actions facts", () => {
    it("should include the agent actions configuration in the generation prompt", async () => {
      const actions: AgentActionsConfig = {
        defaultModel: "GLM-5.3-Flash",
        defaultTimeout: null,
        actions: [
          {
            project: "Projects",
            statusStart: "Plan",
            statusEnd: "Review",
            trigger: "status",
            model: "DeepSeek-Flash",
            instruction: "Do not modify any code. Post an implementation plan.",
            timeout: null,
            weight: null,
          },
          {
            project: "Projects",
            statusStart: "Merge",
            statusEnd: "Review",
            trigger: "status",
            model: "",
            instruction: "",
            timeout: null,
            weight: null,
          },
        ],
      };
      planner.listProjects.mockResolvedValue([project]);
      planner.listNotes.mockResolvedValue([]);
      qoder.runPrompt.mockResolvedValue("content");
      planner.createNote.mockResolvedValue({ id: "n1" });
      const note = new AgentNote(
        config,
        planner as unknown as PlannerClient,
        qoder as unknown as CliAgentClient,
        actions,
      );

      await note.update();

      const prompt = qoder.runPrompt.mock.calls[0][0] as string;
      expect(prompt).toContain("Default model: GLM-5.3-Flash");
      expect(prompt).toContain("- Agent actions:");
      expect(prompt).toContain(
        "Project 'Projects', status 'Plan' -> 'Review', model DeepSeek-Flash, instruction: Do not modify any code. Post an implementation plan.",
      );
      expect(prompt).toContain(
        "Project 'Projects', status 'Merge' -> 'Review', default model",
      );
    });

    it("should truncate long instructions in the actions facts", async () => {
      const longInstruction =
        "Do not modify any code. Analyze the task description, the comments and the target repository, then produce a concise implementation plan for the team.";
      const actions: AgentActionsConfig = {
        defaultModel: "",
        defaultTimeout: null,
        actions: [
          {
            project: "Projects",
            statusStart: "Plan",
            statusEnd: "Review",
            trigger: "status",
            model: "",
            instruction: longInstruction,
            timeout: null,
            weight: null,
          },
        ],
      };
      planner.listProjects.mockResolvedValue([project]);
      planner.listNotes.mockResolvedValue([]);
      qoder.runPrompt.mockResolvedValue("content");
      planner.createNote.mockResolvedValue({ id: "n1" });
      const note = new AgentNote(
        config,
        planner as unknown as PlannerClient,
        qoder as unknown as CliAgentClient,
        actions,
      );

      await note.update();

      const prompt = qoder.runPrompt.mock.calls[0][0] as string;
      expect(prompt).toContain(
        `instruction: ${longInstruction.slice(0, 100)}...`,
      );
      expect(prompt).not.toContain(longInstruction);
    });

    it("should list a wildcard project as any project", async () => {
      const actions: AgentActionsConfig = {
        defaultModel: "",
        defaultTimeout: null,
        actions: [
          {
            project: "",
            statusStart: "To Do",
            statusEnd: "Done",
            trigger: "status",
            model: "",
            instruction: "",
            timeout: null,
            weight: null,
          },
        ],
      };
      planner.listProjects.mockResolvedValue([project]);
      planner.listNotes.mockResolvedValue([]);
      qoder.runPrompt.mockResolvedValue("content");
      planner.createNote.mockResolvedValue({ id: "n1" });
      const note = new AgentNote(
        config,
        planner as unknown as PlannerClient,
        qoder as unknown as CliAgentClient,
        actions,
      );

      await note.update();

      const prompt = qoder.runPrompt.mock.calls[0][0] as string;
      expect(prompt).toContain(
        "Project any project, status 'To Do' -> 'Done', default model",
      );
      expect(prompt).toContain("Default model: auto (CLI default)");
    });
  });

  describe("scheduling facts", () => {
    const promptWithProvider = async (
      provider: (() => AgentSchedulingSnapshot | null) | null,
    ): Promise<string> => {
      planner.listProjects.mockResolvedValue([project]);
      planner.listNotes.mockResolvedValue([]);
      qoder.runPrompt.mockResolvedValue("content");
      planner.createNote.mockResolvedValue({ id: "n1" });
      const note = new AgentNote(
        config,
        planner as unknown as PlannerClient,
        qoder as unknown as CliAgentClient,
        null,
        provider,
      );
      await note.update();
      return qoder.runPrompt.mock.calls[0][0] as string;
    };

    it("should include the live scheduling facts in the generation prompt", async () => {
      const prompt = await promptWithProvider(() => ({
        running: [
          {
            title: "Implement feature",
            project: "Web",
            elapsed: "12m",
            model: "task-model",
          },
        ],
        queuedCount: 6,
        queuedTitles: [
          "Second task",
          "Third task",
          "Fourth task",
          "Fifth task",
          "Sixth task",
          "Seventh task",
        ],
      }));

      expect(prompt).toContain(
        "Currently running tasks: 'Implement feature' (12m, task-model)",
      );
      expect(prompt).toContain(
        "Queued tasks: 6 (Second task | Third task | Fourth task | Fifth task | Sixth task)",
      );
      expect(prompt).not.toContain("Seventh task");
    });

    it("should report none when the agent is idle", async () => {
      const prompt = await promptWithProvider(() => ({
        running: [],
        queuedCount: 0,
        queuedTitles: [],
      }));

      expect(prompt).toContain("Currently running tasks: none");
      expect(prompt).toContain("Queued tasks: none");
    });

    it("should omit the model of a running task without one", async () => {
      const prompt = await promptWithProvider(() => ({
        running: [
          {
            title: "Implement feature",
            project: "Web",
            elapsed: "45s",
            model: "",
          },
        ],
        queuedCount: 0,
        queuedTitles: [],
      }));

      expect(prompt).toContain(
        "Currently running tasks: 'Implement feature' (45s)",
      );
    });

    it("should omit the scheduling facts without a provider", async () => {
      const prompt = await promptWithProvider(null);

      expect(prompt).not.toContain("Currently running tasks");
      expect(prompt).not.toContain("Queued tasks");
    });
  });
});
