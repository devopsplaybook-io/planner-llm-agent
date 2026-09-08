import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import { AgentNote } from "./AgentNote";
import { Config } from "./Config";
import { PlannerClient, PlannerProject } from "./PlannerClient";
import { QoderClient } from "./QoderClient";

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
  let qoder: { runPrompt: jest.Mock };
  let agentNote: AgentNote;

  beforeEach(() => {
    config = new Config();
    config.DATA_DIR = path.join(tmpRoot, "data");
    config.AGENT_NAME = "test-agent";
    config.AGENT_NOTE_PROJECT = "Agent Workspace";
    config.AGENT_NOTE_INTERVAL = 3600;

    planner = {
      listProjects: jest.fn(),
      listNotes: jest.fn(),
      createNote: jest.fn(),
      updateNote: jest.fn(),
    };
    qoder = { runPrompt: jest.fn() };
    agentNote = new AgentNote(
      config,
      planner as unknown as PlannerClient,
      qoder as unknown as QoderClient,
    );
  });

  afterEach(() => {
    fse.removeSync(tmpRoot);
  });

  const project: PlannerProject = { id: "p1", name: "Agent Workspace" };

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
      let resolveProjects: (value: PlannerProject[]) => void = () =>
        undefined;
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

      await fse.outputJson(path.join(config.DATA_DIR, "qoder-credits.json"), {
        credits: 12.5,
      });
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
    });
  });

  describe("ensureNote", () => {
    it("should create the note at startup when it does not exist", async () => {
      planner.listProjects.mockResolvedValue([project]);
      planner.listNotes.mockResolvedValue([]);
      qoder.runPrompt.mockResolvedValue("initial content");
      planner.createNote.mockResolvedValue({ id: "n1" });

      await agentNote.ensureNote();

      expect(planner.createNote).toHaveBeenCalledWith(
        "p1",
        "Planner LLM Agent: test-agent",
        "initial content",
      );
      expect(planner.updateNote).not.toHaveBeenCalled();
    });

    it("should leave an existing note untouched at startup", async () => {
      planner.listProjects.mockResolvedValue([project]);
      planner.listNotes.mockResolvedValue([
        {
          id: "n1",
          projectId: "p1",
          title: "Planner LLM Agent: test-agent",
          description: "existing content",
        },
      ]);

      await agentNote.ensureNote();

      expect(qoder.runPrompt).not.toHaveBeenCalled();
      expect(planner.createNote).not.toHaveBeenCalled();
      expect(planner.updateNote).not.toHaveBeenCalled();
    });
  });
});
