import * as os from "os";
import * as path from "path";
import * as fse from "fs-extra";
import { Agent } from "./Agent";
import { AgentActionsConfig } from "./AgentActions";
import { Config } from "./Config";
import { createCliAgent } from "./clients/CliAgentRegistry";
import { PlannerClient } from "./PlannerClient";

jest.mock("./PlannerClient", () => ({
  PlannerClient: jest.fn(),
}));

jest.mock("./clients/CliAgentRegistry", () => ({
  createCliAgent: jest.fn(),
}));

const MockedPlannerClient = PlannerClient as unknown as jest.Mock;
const MockedCreateCliAgent = createCliAgent as unknown as jest.Mock;
const mockPlanner = {
  getCurrentUser: jest.fn(),
  listAssignedTasks: jest.fn(),
  listProjects: jest.fn(),
  addTaskComment: jest.fn(),
  updateTaskStatus: jest.fn(),
  downloadTaskAttachment: jest.fn(),
};
const mockQoder = {
  checkAuthentication: jest.fn(),
  performTask: jest.fn(),
  runPrompt: jest.fn(),
};

const AGENT_NOTES_MARKER =
  "<!-- AGENT-NOTES: the content below is maintained by the planner agent. Do not remove this marker. -->";

// Wildcard actions (empty project) matching every task in 'To Do' and
// moving it to 'Done': the default used by the task processing tests.
const WILDCARD_ACTIONS: AgentActionsConfig = {
  defaultModel: "",
  defaultTimeout: null,
  actions: [
    {
      project: "",
      statusStart: "To Do",
      statusEnd: "Done",
      model: "",
      instruction: "",
      timeout: null,
      weight: null,
    },
  ],
};

// Wait for the asynchronous processing chain (which performs real file I/O)
// to reach a visible milestone before asserting.
async function waitFor(
  condition: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Agent", () => {
  const originalEnv = process.env;
  let config: Config;
  let dataDir: string;
  let logSpy: jest.SpyInstance;
  // All agents created by a test are stopped in afterEach, so a failing
  // assertion never leaks a polling interval into the next test.
  let agents: Agent[] = [];

  // Agents default to the wildcard actions; pass null to create an agent
  // without any action (it then processes no task).
  const createAgent = (
    agentActions: AgentActionsConfig | null = WILDCARD_ACTIONS,
  ): Agent => {
    const agent = new Agent(config, agentActions);
    agents.push(agent);
    return agent;
  };

  // Simulates the Planner state: updateTaskStatus changes the status of the
  // task, so a processed task is not returned as ready anymore.
  const mockPlannerTasks = (
    tasks: {
      id: string;
      title: string;
      status: string;
      description: string;
      comments: unknown[];
      attachments: unknown[];
      projectId?: string;
      priority?: string;
      dateUpdated?: string;
    }[],
  ) => {
    mockPlanner.listAssignedTasks.mockImplementation(async () =>
      tasks.map((task) => ({ ...task })),
    );
    mockPlanner.updateTaskStatus.mockImplementation(
      async (id: string, status: string) => {
        const task = tasks.find((candidate) => candidate.id === id);
        if (task) {
          task.status = status;
        }
      },
    );
  };

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(jest.fn());
    delete process.env.AGENT_NAME;
    delete process.env.TASK_POLLING_INTERVAL;
    config = new Config();
    config.TASK_POLLING_INTERVAL = 5;
    dataDir = path.join(os.tmpdir(), `agent-spec-${Date.now()}`);
    config.DATA_DIR = dataDir;

    MockedPlannerClient.mockImplementation(() => mockPlanner);
    MockedCreateCliAgent.mockImplementation(() => mockQoder);
    for (const mock of [
      mockPlanner.getCurrentUser,
      mockPlanner.listAssignedTasks,
      mockPlanner.listProjects,
      mockPlanner.addTaskComment,
      mockPlanner.updateTaskStatus,
      mockPlanner.downloadTaskAttachment,
      mockQoder.checkAuthentication,
      mockQoder.performTask,
      mockQoder.runPrompt,
    ]) {
      mock.mockReset();
    }
    mockPlanner.getCurrentUser.mockResolvedValue({
      id: "user-1",
      name: "Test User",
    });
    mockPlanner.listAssignedTasks.mockResolvedValue([]);
    mockPlanner.listProjects.mockResolvedValue([]);
  });

  afterEach(() => {
    for (const agent of agents) {
      agent.stop();
    }
    agents = [];
    jest.useRealTimers();
    jest.restoreAllMocks();
    fse.removeSync(dataDir);
    process.env = originalEnv;
  });

  it("should log the agent name and polling interval on start", () => {
    config.AGENT_NAME = "test-agent";

    const agent = createAgent();
    agent.start();

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Agent 'test-agent' started"),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("polling every 5 seconds"),
    );
    agent.stop();
  });

  it("should poll for tasks immediately and at the configured interval", async () => {
    jest.useFakeTimers();
    // A poll that is still running makes the next tick skip (single-flight
    // guard): let the real I/O of each poll complete before advancing to
    // the next interval.
    const realSetTimeout = jest.requireActual("timers").setTimeout;
    const flushPoll = async (): Promise<void> => {
      await new Promise((resolve) => realSetTimeout(resolve, 5));
    };
    const agent = createAgent();
    agent.start();
    expect(mockPlanner.getCurrentUser).toHaveBeenCalledTimes(1); // initial poll
    await flushPoll();

    await jest.advanceTimersByTimeAsync(5000);
    await flushPoll();
    expect(mockPlanner.getCurrentUser).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(5000);
    await flushPoll();
    expect(mockPlanner.getCurrentUser).toHaveBeenCalledTimes(3);

    await jest.advanceTimersByTimeAsync(5000);
    await flushPoll();
    expect(mockPlanner.getCurrentUser).toHaveBeenCalledTimes(4); // initial + 3 polls
    agent.stop();
  });

  it("should not log when assigned tasks are not ready to be processed", async () => {
    jest.useFakeTimers();
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        title: "Fix the build",
        status: "In Progress",
        description: "",
        comments: [],
        attachments: [],
      },
      {
        id: "task-2",
        title: "Review PR",
        status: "Blocked",
        description: "",
        comments: [],
        attachments: [],
      },
    ]);

    const agent = createAgent();
    agent.start();
    await jest.advanceTimersByTimeAsync(0);

    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining("Tasks assigned"),
    );
    expect(mockQoder.performTask).not.toHaveBeenCalled();
    // The projects are only loaded when a task is ready to be processed.
    expect(mockPlanner.listProjects).not.toHaveBeenCalled();
    agent.stop();
  });

  it("should not log when no tasks are assigned", async () => {
    jest.useFakeTimers();
    const agent = createAgent();
    agent.start();
    await jest.advanceTimersByTimeAsync(0);

    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining("No tasks currently assigned"),
    );
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining("Tasks assigned"),
    );
    expect(mockPlanner.listProjects).not.toHaveBeenCalled();
    agent.stop();
  });

  it("should only process tasks in the start status", async () => {
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
      {
        id: "task-2",
        title: "Already running",
        status: "In Progress",
        description: "Another task",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      path.join(dataDir, "tasks", "task-1-Agent.md"),
      expect.objectContaining({ model: "", instruction: "" }),
    );
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      "task-1",
      "Feature implemented",
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith("task-1", "Done");
    agent.stop();
  });

  it("should write the task notes file with description and comments", async () => {
    config.TASK_STATUS_CLEANUP = "Archived";
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [
          {
            id: "comment-1",
            userId: "user-2",
            userName: "Alice",
            text: "Please add tests",
            dateCreated: "2026-09-02T00:00:00.000Z",
          },
        ],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    const notesFile = path.join(dataDir, "tasks", "task-1-Agent.md");
    expect(await fse.pathExists(notesFile)).toBe(true);
    const content = await fse.readFile(notesFile, "utf8");
    expect(content).toContain("# Task: Implement feature");
    expect(content).toContain("Add a feature");
    expect(content).toContain(
      "**Alice** (2026-09-02T00:00:00.000Z): Please add tests",
    );
    expect(content).toContain(AGENT_NOTES_MARKER);
    expect(content).toContain("## Agent Notes");
    agent.stop();
  });

  it("should preserve existing agent notes across runs", async () => {
    config.TASK_STATUS_CLEANUP = "Archived";
    const notesFile = path.join(dataDir, "tasks", "task-1-Agent.md");
    await fse.ensureDir(path.dirname(notesFile));
    await fse.writeFile(
      notesFile,
      [
        "# Task: Implement feature",
        "",
        "## Description",
        "",
        "Old description",
        "",
        AGENT_NOTES_MARKER,
        "",
        "## Agent Notes",
        "",
        "Previous findings from the last run",
      ].join("\n"),
    );
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "New description",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    const content = await fse.readFile(notesFile, "utf8");
    expect(content).toContain("New description");
    expect(content).not.toContain("Old description");
    expect(content).toContain("Previous findings from the last run");
    agent.stop();
  });

  it("should move a failing task to the end status with an explanation", async () => {
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockRejectedValue(
      new Error("Qoder task execution failed:\nboom"),
    );

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Failed to process task 'Implement feature' (task-1)",
      ),
    );
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      "task-1",
      expect.stringContaining("Task processing failed:"),
    );
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      "task-1",
      expect.stringContaining("boom"),
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith("task-1", "Done");
    agent.stop();
  });

  it("should truncate a long failure explanation", async () => {
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockRejectedValue(new Error("x".repeat(1500)));

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    const failureComment = mockPlanner.addTaskComment.mock.calls
      .map((call) => call[1] as string)
      .find((text) => text.includes("Task processing failed:"));
    expect(failureComment).toContain("Task processing failed:");
    expect(failureComment).toContain(`${"x".repeat(1000)}...`);
    expect(failureComment).not.toContain("x".repeat(1001));
    agent.stop();
  });

  it("should log an error when a failed task cannot be moved to the end status", async () => {
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockRejectedValue(new Error("boom"));
    mockPlanner.addTaskComment.mockRejectedValue(new Error("Planner is down"));

    const agent = createAgent();
    agent.start();
    await waitFor(() =>
      logSpy.mock.calls.some((call) =>
        String(call[0]).includes(
          "Failed to move task 'Implement feature' (task-1) to status 'Done'",
        ),
      ),
    );

    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
    agent.stop();
  });

  it("should not pick a task again while it is still being processed", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    let resolveTask: (value: string) => void = () => undefined;
    mockPlannerTasks([
      {
        id: "task-1",
        title: "Long task",
        status: "To Do",
        description: "Take your time",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveTask = resolve;
        }),
    );

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockQoder.performTask.mock.calls.length === 1);

    // Several polling cycles pass while the task is still processing.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);

    resolveTask("Finally done");
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);
    agent.stop();
  });

  it("should process only one task at a time by default", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    let resolveFirst: (value: string) => void = () => undefined;
    mockPlannerTasks([
      {
        id: "task-1",
        title: "First task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
      {
        id: "task-2",
        title: "Second task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue("Second task done");

    const agent = createAgent();
    agent.start();
    // Only the first task is picked while it is still being processed.
    await waitFor(() => mockQoder.performTask.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      expect.any(String),
      expect.anything(),
    );

    // Once it completes, the second task is picked on the next poll.
    resolveFirst("First task done");
    await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length === 2);
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith("task-2", "Done");
    agent.stop();
  });

  it("should process multiple tasks in parallel up to the configured limit", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    config.TASK_MAX_PARALLEL = 2;
    const resolvers: ((value: string) => void)[] = [];
    mockPlannerTasks([
      {
        id: "task-1",
        title: "First task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
      {
        id: "task-2",
        title: "Second task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
      {
        id: "task-3",
        title: "Third task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const agent = createAgent();
    agent.start();
    // Two tasks start processing in parallel, the third one waits.
    await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(mockQoder.performTask).toHaveBeenCalledTimes(2);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      expect.any(String),
      expect.anything(),
    );
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-2" }),
      expect.any(String),
      expect.anything(),
    );

    // Once a slot frees up, the third task is picked on the next poll.
    resolvers[0]("First done");
    resolvers[1]("Second done");
    await waitFor(() => mockQoder.performTask.mock.calls.length === 3);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-3" }),
      expect.any(String),
      expect.anything(),
    );
    resolvers[2]("Third done");
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length === 3);
    agent.stop();
  });

  it("should log an error and keep polling when the Planner fails", async () => {
    jest.useFakeTimers();
    mockPlanner.getCurrentUser.mockRejectedValue(
      new Error(
        "Planner request to '/api/users/session' failed with status 403",
      ),
    );

    const agent = createAgent();
    agent.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Failed to poll tasks from Planner"),
    );

    await jest.advanceTimersByTimeAsync(5000);
    expect(mockPlanner.getCurrentUser).toHaveBeenCalledTimes(2);
    agent.stop();
  });

  it("should stop polling when stopped", async () => {
    jest.useFakeTimers();
    const agent = createAgent();
    agent.start();
    agent.stop();
    await jest.advanceTimersByTimeAsync(60000);

    expect(mockPlanner.getCurrentUser).toHaveBeenCalledTimes(1); // initial poll only
  });

  it("should download task attachments and list them in the notes file", async () => {
    config.TASK_STATUS_CLEANUP = "Archived";
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [
          {
            id: "attachment-1",
            fileName: "screenshot.png",
            filePath: "/uploads/screenshot.png",
            dateCreated: "2026-09-02T00:00:00.000Z",
          },
        ],
      },
    ]);
    mockPlanner.downloadTaskAttachment.mockResolvedValue(Buffer.from("image"));
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockPlanner.downloadTaskAttachment).toHaveBeenCalledWith(
      "task-1",
      "attachment-1",
    );
    const notesFile = path.join(dataDir, "tasks", "task-1-Agent.md");
    const content = await fse.readFile(notesFile, "utf8");
    expect(content).toContain("## Attachments");
    expect(content).toContain("screenshot.png");
    const attachmentFile = path.join(
      dataDir,
      "tasks",
      "task-1",
      "attachments",
      "screenshot.png",
    );
    expect(await fse.pathExists(attachmentFile)).toBe(true);
    expect(await fse.readFile(attachmentFile)).toEqual(Buffer.from("image"));
    agent.stop();
  });

  it("should clean up the task folder immediately when the task reaches the cleanup status", async () => {
    const taskId = "48c603af-4725-47f5-ac4e-628e027291e8";
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: taskId,
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(
      await fse.pathExists(path.join(dataDir, "tasks", `${taskId}-Agent.md`)),
    ).toBe(false);
    expect(await fse.pathExists(path.join(dataDir, "tasks", taskId))).toBe(
      false,
    );
    agent.stop();
  });

  it("should clean up task folders during polling when tasks are no longer assigned", async () => {
    const taskId = "48c603af-4725-47f5-ac4e-628e027291e8";
    const tasksDir = path.join(dataDir, "tasks");
    await fse.ensureDir(tasksDir);
    await fse.writeFile(path.join(tasksDir, `${taskId}-Agent.md`), "# Task");
    await fse.ensureDir(path.join(tasksDir, taskId, "attachments"));
    mockPlanner.listAssignedTasks.mockResolvedValue([]);

    const agent = createAgent();
    agent.start();
    await waitFor(
      () =>
        !fse.pathExistsSync(path.join(tasksDir, `${taskId}-Agent.md`)) &&
        !fse.pathExistsSync(path.join(tasksDir, taskId)),
    );

    expect(
      await fse.pathExists(path.join(tasksDir, `${taskId}-Agent.md`)),
    ).toBe(false);
    expect(await fse.pathExists(path.join(tasksDir, taskId))).toBe(false);
    agent.stop();
  });

  it("should process only the tasks matching the action project and start status", async () => {
    mockPlanner.listProjects.mockResolvedValue([
      { id: "p1", name: "Web", description: "" },
      { id: "p2", name: "Backend", description: "" },
    ]);
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        projectId: "p1",
        title: "Fix the build",
        status: "To Do",
        description: "The build is broken",
        comments: [],
        attachments: [],
      },
      {
        id: "task-2",
        projectId: "p2",
        title: "Other project task",
        status: "To Do",
        description: "Not for this action",
        comments: [],
        attachments: [],
      },
      {
        id: "task-3",
        projectId: "p1",
        title: "Wrong status",
        status: "In Progress",
        description: "Not in the start status",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Done");

    const agent = createAgent({
      defaultTimeout: null,
      defaultModel: "",
      actions: [
        {
          project: "Web",
          statusStart: "To Do",
          statusEnd: "In Review",
          model: "",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    });
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      expect.any(String),
      expect.anything(),
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(
      "task-1",
      "In Review",
    );
    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalledWith(
      "task-2",
      expect.anything(),
    );
    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalledWith(
      "task-3",
      expect.anything(),
    );
    agent.stop();
  });

  it("should not process a task whose project cannot be resolved", async () => {
    mockPlanner.listProjects.mockResolvedValue([
      { id: "p1", name: "Web", description: "" },
    ]);
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        projectId: "p-deleted",
        title: "Fix the build",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
    ]);

    const agent = createAgent({
      defaultTimeout: null,
      defaultModel: "",
      actions: [
        {
          project: "Web",
          statusStart: "To Do",
          statusEnd: "Done",
          model: "",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    });
    agent.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(mockQoder.performTask).not.toHaveBeenCalled();
    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
    agent.stop();
  });

  it("should only process the tasks matching the action project pattern", async () => {
    mockPlanner.listProjects.mockResolvedValue([
      { id: "p1", name: "Projects", description: "" },
      { id: "p2", name: "Planner", description: "" },
    ]);
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        projectId: "p1",
        title: "Fix the build",
        status: "To Do",
        description: "The build is broken",
        comments: [],
        attachments: [],
      },
      {
        id: "task-2",
        projectId: "p2",
        title: "Other project task",
        status: "To Do",
        description: "Not for this action",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Done");

    const agent = createAgent({
      defaultTimeout: null,
      defaultModel: "",
      actions: [
        {
          project: "Project*",
          statusStart: "To Do",
          statusEnd: "In Review",
          model: "",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    });
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      expect.any(String),
      expect.anything(),
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(
      "task-1",
      "In Review",
    );
    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalledWith(
      "task-2",
      expect.anything(),
    );
    agent.stop();
  });

  it("should not process a task whose project cannot be resolved for a pattern-bound action", async () => {
    mockPlanner.listProjects.mockResolvedValue([
      { id: "p1", name: "Web", description: "" },
    ]);
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        projectId: "p-deleted",
        title: "Fix the build",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
    ]);

    const agent = createAgent({
      defaultTimeout: null,
      defaultModel: "",
      actions: [
        {
          project: "Web*",
          statusStart: "To Do",
          statusEnd: "Done",
          model: "",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    });
    agent.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(mockQoder.performTask).not.toHaveBeenCalled();
    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
    agent.stop();
  });

  it("should apply the action model and instruction to the task", async () => {
    mockPlanner.listProjects.mockResolvedValue([
      { id: "p1", name: "Web", description: "" },
    ]);
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        projectId: "p1",
        title: "Fix the build",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Done");

    const agent = createAgent({
      defaultTimeout: null,
      defaultModel: "default-model",
      actions: [
        {
          project: "Web",
          statusStart: "To Do",
          statusEnd: "Done",
          model: "action-model",
          instruction: "Follow the coding guidelines",
          timeout: null,
          weight: null,
        },
      ],
    });
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        model: "action-model",
        instruction: "Follow the coding guidelines",
      }),
    );
    agent.stop();
  });

  it("should use the default model when the action has no model", async () => {
    mockPlanner.listProjects.mockResolvedValue([
      { id: "p1", name: "Web", description: "" },
    ]);
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        projectId: "p1",
        title: "Fix the build",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Done");

    const agent = createAgent({
      defaultTimeout: null,
      defaultModel: "default-model",
      actions: [
        {
          project: "Web",
          statusStart: "To Do",
          statusEnd: "Done",
          model: "",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    });
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ model: "default-model" }),
    );
    agent.stop();
  });

  it("should run with no model when no action or default model is set", async () => {
    mockPlanner.listProjects.mockResolvedValue([
      { id: "p1", name: "Web", description: "" },
    ]);
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        projectId: "p1",
        title: "Fix the build",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Done");

    const agent = createAgent({
      defaultTimeout: null,
      defaultModel: "",
      actions: [
        {
          project: "Web",
          statusStart: "To Do",
          statusEnd: "Done",
          model: "",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    });
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ model: "" }),
    );
    agent.stop();
  });

  it("should post a start notification comment before executing the task", async () => {
    config.AGENT_NAME = "test-agent";
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    let resolveTask: (value: string) => void = () => undefined;
    mockQoder.performTask.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveTask = resolve;
        }),
    );

    const agent = createAgent();
    agent.start();
    // The start comment is posted while the task is still executing.
    await waitFor(() => mockQoder.performTask.mock.calls.length === 1);
    expect(mockPlanner.addTaskComment).toHaveBeenCalledTimes(1);
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      "task-1",
      "Agent 'test-agent' started working on this task.",
    );

    resolveTask("Feature implemented");
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      "task-1",
      "Feature implemented",
    );
    agent.stop();
  });

  it("should not fail the task when the start notification fails", async () => {
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    mockPlanner.addTaskComment
      .mockRejectedValueOnce(new Error("Planner is down"))
      .mockResolvedValueOnce(undefined);
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      "task-1",
      "Feature implemented",
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith("task-1", "Done");
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Failed to post the start notification for task 'Implement feature' (task-1)",
      ),
    );
    agent.stop();
  });

  it("should pass the action timeout to the task execution", async () => {
    mockPlanner.listProjects.mockResolvedValue([
      { id: "p1", name: "Web", description: "" },
    ]);
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        projectId: "p1",
        title: "Implement feature",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Done");

    const agent = createAgent({
      defaultModel: "",
      defaultTimeout: 7200,
      actions: [
        {
          project: "Web",
          statusStart: "To Do",
          statusEnd: "Done",
          model: "",
          instruction: "",
          timeout: 1800,
          weight: null,
        },
      ],
    });
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ timeoutSeconds: 1800 }),
    );
    agent.stop();
  });

  it("should pass the actions default timeout when the action has none", async () => {
    mockPlanner.listProjects.mockResolvedValue([
      { id: "p1", name: "Web", description: "" },
    ]);
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        projectId: "p1",
        title: "Implement feature",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Done");

    const agent = createAgent({
      defaultModel: "",
      defaultTimeout: 7200,
      actions: [
        {
          project: "Web",
          statusStart: "To Do",
          statusEnd: "Done",
          model: "",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    });
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ timeoutSeconds: 7200 }),
    );
    agent.stop();
  });

  it("should fall back to the global task timeout when the actions define none", async () => {
    config.TASK_TIMEOUT = 5400;
    mockPlanner.listProjects.mockResolvedValue([
      { id: "p1", name: "Web", description: "" },
    ]);
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        projectId: "p1",
        title: "Implement feature",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Done");

    const agent = createAgent({
      defaultModel: "",
      defaultTimeout: null,
      actions: [
        {
          project: "Web",
          statusStart: "To Do",
          statusEnd: "Done",
          model: "",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    });
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ timeoutSeconds: 5400 }),
    );
    agent.stop();
  });

  it("should fetch the projects when a task is processed so the notes carry the project info", async () => {
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        projectId: "p1",
        title: "Fix the build",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Done");

    // A wildcard action (empty project) applies to every task, whatever its
    // project: the projects are still fetched to document the task notes.
    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockPlanner.listProjects).toHaveBeenCalledTimes(1);
    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    agent.stop();
  });

  it("should process higher priority tasks first", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    const resolvers: ((value: string) => void)[] = [];
    mockPlannerTasks([
      {
        id: "task-low",
        title: "Low priority task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
        priority: "low",
      },
      {
        id: "task-high",
        title: "High priority task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
        priority: "high",
      },
      {
        id: "task-medium",
        title: "Medium priority task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
        priority: "medium",
      },
    ]);
    mockQoder.performTask.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockQoder.performTask.mock.calls.length === 1);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-high" }),
      expect.any(String),
      expect.anything(),
    );

    resolvers[0]("High done");
    await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-medium" }),
      expect.any(String),
      expect.anything(),
    );

    resolvers[1]("Medium done");
    await waitFor(() => mockQoder.performTask.mock.calls.length === 3);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-low" }),
      expect.any(String),
      expect.anything(),
    );
    resolvers[2]("Low done");
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length === 3);
    agent.stop();
  });

  it("should process the task with the oldest update first within the same priority", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    const resolvers: ((value: string) => void)[] = [];
    mockPlannerTasks([
      {
        id: "task-newest",
        title: "Newest task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
        priority: "high",
        dateUpdated: "2026-09-10T00:00:00.000Z",
      },
      {
        id: "task-oldest",
        title: "Oldest task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
        priority: "high",
        dateUpdated: "2026-09-01T00:00:00.000Z",
      },
      {
        id: "task-middle",
        title: "Middle task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
        priority: "high",
        dateUpdated: "2026-09-05T00:00:00.000Z",
      },
    ]);
    mockQoder.performTask.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockQoder.performTask.mock.calls.length === 1);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-oldest" }),
      expect.any(String),
      expect.anything(),
    );

    resolvers[0]("Oldest done");
    await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-middle" }),
      expect.any(String),
      expect.anything(),
    );

    resolvers[1]("Middle done");
    await waitFor(() => mockQoder.performTask.mock.calls.length === 3);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-newest" }),
      expect.any(String),
      expect.anything(),
    );
    resolvers[2]("Newest done");
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length === 3);
    agent.stop();
  });

  it("should treat an unknown task priority as medium", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    const resolvers: ((value: string) => void)[] = [];
    mockPlannerTasks([
      {
        id: "task-low",
        title: "Low priority task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
        priority: "low",
      },
      {
        id: "task-unknown",
        title: "Unknown priority task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
        priority: "urgent",
      },
    ]);
    mockQoder.performTask.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockQoder.performTask.mock.calls.length === 1);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-unknown" }),
      expect.any(String),
      expect.anything(),
    );

    resolvers[0]("Unknown done");
    await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-low" }),
      expect.any(String),
      expect.anything(),
    );
    resolvers[1]("Low done");
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length === 2);
    agent.stop();
  });

  it("should include the project name and description in the task notes", async () => {
    config.TASK_STATUS_CLEANUP = "Archived";
    mockPlanner.listProjects.mockResolvedValue([
      {
        id: "p1",
        name: "Web",
        description: "The web application of the suite",
      },
    ]);
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        projectId: "p1",
        title: "Fix the build",
        status: "To Do",
        description: "The build is broken",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Done");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    const content = await fse.readFile(
      path.join(dataDir, "tasks", "task-1-Agent.md"),
      "utf8",
    );
    expect(content).toContain("- **Project**: Web");
    expect(content).toContain("## Project");
    expect(content).toContain("The web application of the suite");
    agent.stop();
  });

  it("should omit the project section when the project has no description", async () => {
    config.TASK_STATUS_CLEANUP = "Archived";
    mockPlanner.listProjects.mockResolvedValue([
      { id: "p1", name: "Web", description: "" },
    ]);
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        projectId: "p1",
        title: "Fix the build",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Done");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    const content = await fse.readFile(
      path.join(dataDir, "tasks", "task-1-Agent.md"),
      "utf8",
    );
    expect(content).toContain("- **Project**: Web");
    expect(content).not.toContain("## Project");
    agent.stop();
  });

  it("should not process any task without an actions configuration", async () => {
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        title: "Fix the build",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
    ]);

    const agent = createAgent(null);
    agent.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(mockQoder.performTask).not.toHaveBeenCalled();
    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
    agent.stop();
  });

  it("should fill the weighted capacity budget with fractional TASK_MAX_PARALLEL", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    config.TASK_MAX_PARALLEL = 1.9;
    const resolvers: ((value: string) => void)[] = [];
    mockPlannerTasks([
      {
        id: "task-a",
        title: "Heavy task",
        status: "To Do",
        description: "agent-weight: 1\nDo the heavy work",
        comments: [],
        attachments: [],
      },
      {
        id: "task-b",
        title: "Small task",
        status: "To Do",
        description: "agent-weight: 0.5\nDo a small fix",
        comments: [],
        attachments: [],
      },
      {
        id: "task-c",
        title: "Overflowing task",
        status: "To Do",
        description: "agent-weight: 0.5\nWould exceed the budget",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const agent = createAgent();
    agent.start();
    // The heavy task and the small task fit 1.9 (1.5 used); the third one
    // does not fit and is deferred with a reason instead of blocking.
    await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(mockQoder.performTask).toHaveBeenCalledTimes(2);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-a" }),
      expect.any(String),
      expect.anything(),
    );
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-b" }),
      expect.any(String),
      expect.anything(),
    );
    expect(logSpy.mock.calls.some((call) =>
      String(call[0]).includes(
        "Scheduling round: picked: 'Heavy task' (weight 1.00), 'Small task' (weight 0.50); deferred: 'Overflowing task' (capacity)",
      ),
    )).toBe(true);
    // Explicit weight hints need no utility-model evaluation.
    expect(mockQoder.runPrompt).not.toHaveBeenCalled();
    resolvers.forEach((resolve) => resolve("done"));
    agent.stop();
  });

  it("should never run more CLI processes than the budget count, whatever the weights", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    config.TASK_MAX_PARALLEL = 1.9;
    config.AGENT_UTILITY_MODEL = "utility-model";
    // The utility model evaluates every hint-less task to a small weight:
    // the weight budget (1.9) alone would admit 7 of them at once.
    mockQoder.runPrompt.mockResolvedValue(
      JSON.stringify({ weight: 0.25, conflicts: [], kind: "code-light" }),
    );
    mockPlannerTasks(
      [1, 2, 3, 4, 5, 6].map((n) => ({
        id: `task-${n}`,
        title: `Small task ${n}`,
        status: "To Do",
        description: "Hint-less work",
        comments: [],
        attachments: [],
      })),
    );
    const resolvers: ((value: string) => void)[] = [];
    mockQoder.performTask.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const agent = createAgent();
    agent.start();
    // 6 x 0.25 = 1.5 fits the weight budget, but every task is one full CLI
    // process: at most ceil(1.9) = 2 run concurrently, the rest is deferred
    // with a capacity reason and retried on the following polls. Running
    // all of them at once OOM-kills the container (the CLI heap is sized
    // from the container memory limit).
    await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(mockQoder.performTask).toHaveBeenCalledTimes(2);
    // Only the tasks that can still be admitted this round are evaluated.
    expect(mockQoder.runPrompt).toHaveBeenCalledTimes(2);
    expect(
      logSpy.mock.calls.some((call) =>
        String(call[0]).includes(
          "picked: 'Small task 1' (weight 0.25), 'Small task 2' (weight 0.25)",
        ),
      ),
    ).toBe(true);
    expect(
      logSpy.mock.calls.some((call) =>
        String(call[0]).includes("deferred: 'Small task 3' (capacity)"),
      ),
    ).toBe(true);
    resolvers.forEach((resolve) => resolve("done"));
    agent.stop();
  });

  it("should defer a task conflicting with a running task and keep picking unrelated tasks", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    config.TASK_MAX_PARALLEL = 2;
    mockPlanner.listProjects.mockResolvedValue([
      { id: "p1", name: "Web", description: "" },
    ]);
    mockPlannerTasks([
      {
        id: "task-1",
        projectId: "p1",
        title: "Web migration",
        status: "To Do",
        description:
          "Migrate the web app\nagent-lock: repo:acme/web\nSee https://github.com/acme/web",
        comments: [],
        attachments: [],
      },
      {
        id: "task-2",
        projectId: "p1",
        title: "Web follow-up",
        status: "To Do",
        description: "Touch the same https://github.com/acme/web repository",
        comments: [],
        attachments: [],
      },
      {
        id: "task-3",
        projectId: "p1",
        title: "API fix",
        status: "To Do",
        description: "Fix https://github.com/acme/api instead",
        comments: [],
        attachments: [],
      },
    ]);
    const resolvers: ((value: string) => void)[] = [];
    mockQoder.performTask.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const agent = createAgent();
    agent.start();
    // Round 1: the migration is picked, the follow-up is deferred with its
    // conflict key, and the unrelated API task is still picked in the same
    // round (no head-of-line blocking).
    await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      expect.any(String),
      expect.anything(),
    );
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-3" }),
      expect.any(String),
      expect.anything(),
    );
    await waitFor(() =>
      logSpy.mock.calls.some((call) =>
        String(call[0]).includes(
          "deferred: 'Web follow-up' (conflict:repo:acme/web)",
        ),
      ),
    );

    // Round 2: the API task completes, but the migration still claims
    // 'repo:acme/web' while running, so the follow-up stays deferred.
    resolvers[1]("API fix done");
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(mockQoder.performTask).toHaveBeenCalledTimes(2);

    // Round 3: the migration completes and releases the lock; the follow-up
    // is finally picked.
    resolvers[0]("Web migration done");
    await waitFor(
      () => mockQoder.performTask.mock.calls.length === 3,
      5000,
    );
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-2" }),
      expect.any(String),
      expect.anything(),
    );
    resolvers[2]("Web follow-up done");
    agent.stop();
  });

  it("should evaluate hint-less tasks with the utility model and serialize them by repository", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    config.TASK_MAX_PARALLEL = 2;
    config.AGENT_UTILITY_MODEL = "utility-model";
    mockPlannerTasks([
      {
        id: "task-1",
        title: "Refactor the service",
        status: "To Do",
        description: "Refactor the billing service",
        comments: [],
        attachments: [],
      },
      {
        id: "task-2",
        title: "Update the billing docs",
        status: "To Do",
        description: "Update the documentation of the billing service",
        comments: [],
        attachments: [],
      },
    ]);
    // Both evaluations return the same repository: the second task must not
    // run in parallel with the first one.
    mockQoder.runPrompt.mockImplementation(() =>
      Promise.resolve(
        JSON.stringify({
          weight: 0.5,
          conflicts: ["repo:ACME/Billing"],
          kind: "code-light",
        }),
      ),
    );
    let resolveFirst: (value: string) => void = () => undefined;
    mockQoder.performTask
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue("Done");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockQoder.performTask.mock.calls.length === 1);
    expect(mockQoder.runPrompt).toHaveBeenCalledTimes(2);
    expect(mockQoder.runPrompt).toHaveBeenCalledWith(
      expect.stringContaining("Task title: Refactor the service"),
      expect.objectContaining({ model: "utility-model" }),
    );
    // The evaluated weight (0.5, normalized conflicts) shows in the log.
    expect(logSpy.mock.calls.some((call) =>
      String(call[0]).includes("picked: 'Refactor the service' (weight 0.50)"),
    )).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls.some((call) =>
      String(call[0]).includes(
        "deferred: 'Update the billing docs' (conflict:repo:acme/billing)",
      ),
    )).toBe(true);
    // The evaluations are cached per task content version: the next poll
    // makes no new utility-model call.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(mockQoder.runPrompt).toHaveBeenCalledTimes(2);

    resolveFirst("Refactor done");
    agent.stop();
  });

  it("should not call the utility model when AGENT_UTILITY_MODEL is not set", async () => {
    config.TASK_MAX_PARALLEL = 2;
    mockPlannerTasks([
      {
        id: "task-1",
        title: "Plain task",
        status: "To Do",
        description: "No hints at all",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Done");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.runPrompt).not.toHaveBeenCalled();
    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    agent.stop();
  });

  it("should ignore weights, conflicts and the utility model when the smart scheduling is disabled", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    config.TASK_SMART_SCHEDULING = false;
    config.TASK_MAX_PARALLEL = 2;
    config.AGENT_UTILITY_MODEL = "utility-model";
    const resolvers: ((value: string) => void)[] = [];
    mockPlannerTasks([
      {
        id: "task-1",
        title: "Locked task",
        status: "To Do",
        description: "agent-lock: repo:acme/web\nFirst work",
        comments: [],
        attachments: [],
      },
      {
        id: "task-2",
        title: "Conflicting task",
        status: "To Do",
        description: "agent-lock: repo:acme/web\nSecond work",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const agent = createAgent();
    agent.start();
    // The historical count-based selection picks both tasks although they
    // share a lock and the utility model is never consulted.
    await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      expect.any(String),
      expect.anything(),
    );
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-2" }),
      expect.any(String),
      expect.anything(),
    );
    expect(mockQoder.runPrompt).not.toHaveBeenCalled();
    resolvers.forEach((resolve) => resolve("done"));
    agent.stop();
  });

  it("should run each task in its own working directory under the tasks folder", async () => {
    config.TASK_STATUS_CLEANUP = "Archived";
    mockPlannerTasks([
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    const taskDir = path.join(dataDir, "tasks", "task-1");
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ cwd: taskDir }),
    );
    expect(await fse.pathExists(taskDir)).toBe(true);
    agent.stop();
  });

  it("should log the running tasks with their weight and model on the following polls", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    config.TASK_MAX_PARALLEL = 2;
    const resolvers: ((value: string) => void)[] = [];
    mockPlannerTasks([
      {
        id: "task-1",
        title: "Small task",
        status: "To Do",
        description: "agent-weight: 0.5\nSmall work",
        comments: [],
        attachments: [],
      },
      {
        id: "task-2",
        title: "Large task",
        status: "To Do",
        description: "agent-weight: 1\nLarge work",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const agent = createAgent(
      {
        defaultModel: "default-model",
        defaultTimeout: null,
        actions: [
          {
            project: "",
            statusStart: "To Do",
            statusEnd: "Done",
            model: "",
            instruction: "",
            timeout: null,
            weight: null,
          },
        ],
      },
    );
    agent.start();
    await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
    await waitFor(() =>
      logSpy.mock.calls.some((call) =>
        String(call[0]).includes(
          "Tasks running (2, total weight 1.50): 'Small task' (weight 0.50",
        ),
      ),
    );
    expect(logSpy.mock.calls.some((call) =>
      String(call[0]).includes("'Large task' (weight 1.00") &&
      String(call[0]).includes("model default-model"),
    )).toBe(true);
    resolvers.forEach((resolve) => resolve("done"));
    agent.stop();
  });

  it("should never pick a task twice while a poll or its processing is in flight", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    // The first poll stalls on the projects request: the following ticks must
    // be skipped instead of running a second concurrent selection.
    let resolveProjects: (value: { id: string; name: string; description: string }[]) => void =
      () => undefined;
    mockPlanner.listProjects.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProjects = resolve;
        }),
    );
    mockPlannerTasks([
      {
        id: "task-1",
        title: "Single task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockImplementation(
      () => new Promise<string>(() => undefined),
    );

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.listProjects.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(mockPlanner.listProjects).toHaveBeenCalledTimes(1);

    // Once the poll completes, the task is picked exactly once and never
    // again while its processing runs.
    resolveProjects([{ id: "p1", name: "Web", description: "" }]);
    await waitFor(() => mockQoder.performTask.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    agent.stop();
  });
});
