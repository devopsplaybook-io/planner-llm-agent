import * as os from "os";
import * as path from "path";
import * as fse from "fs-extra";
import { Agent } from "./Agent";
import { AgentActionsConfig } from "./AgentActions";
import { Config } from "./Config";
import { PlannerClient } from "./PlannerClient";
import { QoderClient } from "./QoderClient";

jest.mock("./PlannerClient", () => ({
  PlannerClient: jest.fn(),
}));

jest.mock("./QoderClient", () => ({
  QoderClient: jest.fn(),
}));

const MockedPlannerClient = PlannerClient as unknown as jest.Mock;
const MockedQoderClient = QoderClient as unknown as jest.Mock;
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
};

const AGENT_NOTES_MARKER =
  "<!-- AGENT-NOTES: the content below is maintained by the Qoder agent. Do not remove this marker. -->";

// Wildcard actions (empty project) matching every task in 'To Do' and
// moving it to 'Done': the default used by the task processing tests.
const WILDCARD_ACTIONS: AgentActionsConfig = {
  defaultModel: "",
  actions: [
    {
      project: "",
      statusStart: "To Do",
      statusEnd: "Done",
      model: "",
      instruction: "",
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
    MockedQoderClient.mockImplementation(() => mockQoder);
    for (const mock of [
      mockPlanner.getCurrentUser,
      mockPlanner.listAssignedTasks,
      mockPlanner.listProjects,
      mockPlanner.addTaskComment,
      mockPlanner.updateTaskStatus,
      mockPlanner.downloadTaskAttachment,
      mockQoder.checkAuthentication,
      mockQoder.performTask,
    ]) {
      mock.mockReset();
    }
    mockPlanner.getCurrentUser.mockResolvedValue({
      id: "user-1",
      name: "Test User",
    });
    mockPlanner.listAssignedTasks.mockResolvedValue([]);
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
    const agent = createAgent();
    agent.start();
    expect(mockPlanner.getCurrentUser).toHaveBeenCalledTimes(1); // initial poll

    await jest.advanceTimersByTimeAsync(15000);
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

    const comment = mockPlanner.addTaskComment.mock.calls[0][1] as string;
    expect(comment).toContain("Task processing failed:");
    expect(comment).toContain(`${"x".repeat(1000)}...`);
    expect(comment).not.toContain("x".repeat(1001));
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
      { id: "p1", name: "Web" },
      { id: "p2", name: "Backend" },
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
      defaultModel: "",
      actions: [
        {
          project: "Web",
          statusStart: "To Do",
          statusEnd: "In Review",
          model: "",
          instruction: "",
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
    mockPlanner.listProjects.mockResolvedValue([{ id: "p1", name: "Web" }]);
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
      defaultModel: "",
      actions: [
        {
          project: "Web",
          statusStart: "To Do",
          statusEnd: "Done",
          model: "",
          instruction: "",
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
    mockPlanner.listProjects.mockResolvedValue([{ id: "p1", name: "Web" }]);
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
      defaultModel: "default-model",
      actions: [
        {
          project: "Web",
          statusStart: "To Do",
          statusEnd: "Done",
          model: "action-model",
          instruction: "Follow the coding guidelines",
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
    mockPlanner.listProjects.mockResolvedValue([{ id: "p1", name: "Web" }]);
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
      defaultModel: "default-model",
      actions: [
        {
          project: "Web",
          statusStart: "To Do",
          statusEnd: "Done",
          model: "",
          instruction: "",
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

  it("should fall back to QODER_MODEL when no action or default model is set", async () => {
    config.QODER_MODEL = "env-model";
    mockPlanner.listProjects.mockResolvedValue([{ id: "p1", name: "Web" }]);
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
      defaultModel: "",
      actions: [
        {
          project: "Web",
          statusStart: "To Do",
          statusEnd: "Done",
          model: "",
          instruction: "",
        },
      ],
    });
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ model: "env-model" }),
    );
    agent.stop();
  });

  it("should not fetch the projects when no action is project-bound", async () => {
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

    // A wildcard action (empty project) applies to every task, whatever
    // its project: the project names are not needed.
    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockPlanner.listProjects).not.toHaveBeenCalled();
    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
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
});
