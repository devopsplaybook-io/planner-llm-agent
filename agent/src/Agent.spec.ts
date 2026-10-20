import * as os from "os";
import * as path from "path";
import * as fse from "fs-extra";
import {
  Agent,
  buildTaskLabel,
  commentsPickupPending,
  hasAgentComment,
  lastCommentOf,
  mergeLabels,
  normalizeLabelValue,
} from "./Agent";
import { AgentActionsConfig } from "./AgentActions";
import { Config } from "./Config";
import { FinalizationStore } from "./FinalizationStore";
import { CliAbortedError } from "./CliUtils";
import { createCliAgent } from "./clients/CliAgentRegistry";
import type { CliAgentClient, TaskOptions } from "./clients/CliAgent";
import { PlannerClient, PlannerTask } from "./PlannerClient";

jest.mock("./PlannerClient", () => ({
  PlannerClient: jest.fn(),
}));

jest.mock("./clients/CliAgentRegistry", () => ({
  createCliAgent: jest.fn(),
}));

// The agent never initializes OpenTelemetry itself, so the observable gauge
// callbacks are captured by name and can be invoked like an export cycle.
jest.mock("./OTelContext", () => {
  const actual = jest.requireActual("./OTelContext");
  const observableGauges: Record<string, (result: unknown) => void> = {};
  return {
    ...actual,
    OTelMeter: jest.fn(() => ({
      createObservableGauge: jest.fn(
        (key: string, callback: (result: unknown) => void) => {
          observableGauges[key] = callback;
          return { addCallback: jest.fn() };
        },
      ),
    })),
    __observableGauges: observableGauges,
  };
});

const MockedPlannerClient = PlannerClient as unknown as jest.Mock;
const MockedCreateCliAgent = createCliAgent as unknown as jest.Mock;
const observableGauges = (
  jest.requireMock("./OTelContext") as {
    __observableGauges: Record<
      string,
      (result: { observe: jest.Mock }) => void
    >;
  }
).__observableGauges;
const mockPlanner = {
  getCurrentUser: jest.fn(),
  listAssignedTasks: jest.fn(),
  getTask: jest.fn(),
  listProjects: jest.fn(),
  addTaskComment: jest.fn(),
  updateTaskStatus: jest.fn(),
  updateTaskLabels: jest.fn(),
  downloadTaskAttachment: jest.fn(),
};
const mockQoder = {
  checkAuthentication: jest.fn(),
  prepare: jest.fn(),
  performTask: jest.fn(),
  runPrompt: jest.fn(),
};
const mockCopilot = {
  checkAuthentication: jest.fn(),
  prepare: jest.fn(),
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
      trigger: "status",
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
    finalizationStore?: FinalizationStore,
  ): Agent => {
    const agent = new Agent(config, agentActions, undefined, finalizationStore);
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

  // Stateful label store for the label tests: getTask reads the current
  // labels, updateTaskLabels records every replacement and persists it.
  const mockTaskLabels = (task: Record<string, unknown>): string[][] => {
    const writes: string[][] = [];
    if (!Array.isArray(task.labels)) {
      task.labels = [];
    }
    mockPlanner.listAssignedTasks.mockImplementation(async () => [{ ...task }]);
    mockPlanner.getTask.mockImplementation(async () => ({
      ...task,
      labels: [...(task.labels as string[])],
    }));
    mockPlanner.updateTaskLabels.mockImplementation(
      async (_taskId: string, labels: string[]) => {
        writes.push([...labels]);
        task.labels = [...labels];
      },
    );
    return writes;
  };

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(jest.fn());
    delete process.env.AGENT_NAME;
    delete process.env.TASK_POLLING_INTERVAL;
    config = new Config();
    config.TASK_POLLING_INTERVAL = 5;
    // The backoff ceiling equals the base interval: the polling cadence of
    // the tests below stays at the configured interval unless a test
    // overrides the ceiling to exercise the backoff.
    config.TASK_POLLING_MAX_INTERVAL = 5;
    dataDir = path.join(os.tmpdir(), `agent-spec-${Date.now()}`);
    config.DATA_DIR = dataDir;

    MockedPlannerClient.mockImplementation(() => mockPlanner);
    MockedCreateCliAgent.mockImplementation(
      (_config: Config, _actions: AgentActionsConfig, agentName: string) =>
        agentName === "copilot-cli" ? mockCopilot : mockQoder,
    );
    for (const mock of [
      mockPlanner.getCurrentUser,
      mockPlanner.listAssignedTasks,
      mockPlanner.getTask,
      mockPlanner.listProjects,
      mockPlanner.addTaskComment,
      mockPlanner.updateTaskStatus,
      mockPlanner.updateTaskLabels,
      mockPlanner.downloadTaskAttachment,
      mockQoder.checkAuthentication,
      mockQoder.prepare,
      mockQoder.performTask,
      mockQoder.runPrompt,
      mockCopilot.checkAuthentication,
      mockCopilot.prepare,
      mockCopilot.performTask,
      mockCopilot.runPrompt,
    ]) {
      mock.mockReset();
    }
    mockPlanner.getCurrentUser.mockResolvedValue({
      id: "user-1",
      name: "Test User",
    });
    mockPlanner.listAssignedTasks.mockResolvedValue([]);
    mockPlanner.addTaskComment.mockResolvedValue(undefined);
    mockPlanner.updateTaskLabels.mockResolvedValue(undefined);
    // Default getTask: mirrors the task as the last poll saw it, so the
    // new-comment check of every processed task sees no new comments.
    // Overridden per test when a new-comment scenario is exercised.
    mockPlanner.getTask.mockImplementation(async (taskId: string) => {
      const tasks = (await mockPlanner.listAssignedTasks()) as {
        id: string;
        comments?: Record<string, unknown>[];
      }[];
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) {
        throw new Error(
          `Planner request to '/api/tasks/${taskId}' failed with status 404`,
        );
      }
      return {
        ...task,
        comments: (task.comments ?? []).map((comment) => ({ ...comment })),
      };
    });
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

  it("should dispatch an action to its configured CLI agent", async () => {
    mockPlannerTasks([
      {
        id: "task-1",
        title: "Project task",
        status: "To Do",
        description: "Implement the project change",
        comments: [],
        attachments: [],
      },
    ]);
    mockCopilot.performTask.mockResolvedValue("Completed with Copilot");
    const actions: AgentActionsConfig = {
      defaultAgent: "qoder",
      defaultModel: "",
      defaultTimeout: null,
      actions: [
        {
          project: "",
          statusStart: "To Do",
          statusEnd: "Done",
          trigger: "status",
          agent: "copilot-cli",
          model: "",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    };

    const agent = createAgent(actions);
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockCopilot.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      expect.any(String),
      expect.objectContaining({ cwd: expect.any(String) }),
    );
    expect(mockQoder.performTask).not.toHaveBeenCalled();
    agent.stop();
  });

  it("should prepare a CLI agent introduced by an action loaded after startup", async () => {
    mockPlannerTasks([
      {
        id: "task-1",
        title: "Hot-reloaded task",
        status: "To Do",
        description: "Implement the project change",
        comments: [],
        attachments: [],
      },
    ]);
    const order: string[] = [];
    mockCopilot.prepare.mockImplementation(async () => {
      order.push("prepare");
    });
    mockCopilot.performTask.mockImplementation(async () => {
      order.push("performTask");
      return "Completed with Copilot";
    });
    const actions: AgentActionsConfig = {
      defaultAgent: "qoder",
      defaultModel: "",
      defaultTimeout: null,
      actions: [
        {
          project: "",
          statusStart: "To Do",
          statusEnd: "Done",
          trigger: "status",
          agent: "copilot-cli",
          model: "",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    };
    // The startup map only holds the default agent: copilot-cli is created
    // at runtime, when the action requiring it is processed.
    const startupAgents = new Map<string, CliAgentClient>([
      ["qoder", mockQoder as unknown as CliAgentClient],
    ]);

    const agent = new Agent(config, actions, startupAgents);
    agents.push(agent);
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockCopilot.prepare).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["prepare", "performTask"]);
    agent.stop();
  });

  it("should poll for tasks immediately and at the configured interval", async () => {
    jest.useFakeTimers();
    // A poll that is still running makes the next tick skip (single-flight
    // guard): wait until each poll is recorded (real sleeps — the condition
    // must be observed outside the fake clock) and let its tail settle
    // before advancing to the next interval, so a loaded runner cannot skip
    // a tick.
    const realSetTimeout = jest.requireActual("timers").setTimeout;
    const waitUntilPolled = async (expected: number): Promise<void> => {
      for (
        let i = 0;
        i < 200 && mockPlanner.getCurrentUser.mock.calls.length < expected;
        i++
      ) {
        await new Promise((resolve) => realSetTimeout(resolve, 5));
      }
      await new Promise((resolve) => realSetTimeout(resolve, 5));
      expect(mockPlanner.getCurrentUser).toHaveBeenCalledTimes(expected);
    };
    const agent = createAgent();
    agent.start();
    await waitUntilPolled(1); // initial poll

    await jest.advanceTimersByTimeAsync(5000);
    await waitUntilPolled(2);

    await jest.advanceTimersByTimeAsync(5000);
    await waitUntilPolled(3);

    await jest.advanceTimersByTimeAsync(5000);
    await waitUntilPolled(4); // initial + 3 polls
    agent.stop();
  });

  it("should back off the polling while idle and resume the base cadence on activity", async () => {
    jest.useFakeTimers();
    config.TASK_POLLING_INTERVAL = 1;
    config.TASK_POLLING_MAX_INTERVAL = 8;
    const realSetTimeout = jest.requireActual("timers").setTimeout;
    const flushPoll = async (): Promise<void> => {
      await new Promise((resolve) => realSetTimeout(resolve, 5));
    };
    // waitFor() cannot be used under fake timers (it sleeps with the
    // mocked setTimeout), so the milestones are awaited with real timers.
    const waitForReal = async (condition: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !condition(); i++) {
        await new Promise((resolve) => realSetTimeout(resolve, 10));
      }
      expect(condition()).toBe(true);
    };
    const agent = createAgent();
    agent.start();
    await flushPoll(); // poll 1: idle
    expect(mockPlanner.getCurrentUser).toHaveBeenCalledTimes(1);

    // The first idle poll keeps the base interval.
    await jest.advanceTimersByTimeAsync(1000);
    await flushPoll();
    expect(mockPlanner.getCurrentUser).toHaveBeenCalledTimes(2);

    // The next idle poll doubles the interval: 1 second is not enough.
    await jest.advanceTimersByTimeAsync(1000);
    await flushPoll();
    expect(mockPlanner.getCurrentUser).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1000);
    await flushPoll();
    expect(mockPlanner.getCurrentUser).toHaveBeenCalledTimes(3);

    // A task being picked resets the cadence: the next poll runs at the
    // base interval again.
    mockPlannerTasks([
      {
        id: "task-1",
        title: "New task",
        status: "To Do",
        description: "Work to do",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("done");
    await jest.advanceTimersByTimeAsync(4000); // 4s backoff: poll 4 picks the task
    await waitForReal(() => mockQoder.performTask.mock.calls.length === 1);
    expect(mockPlanner.getCurrentUser).toHaveBeenCalledTimes(4);

    await jest.advanceTimersByTimeAsync(1000);
    await flushPoll();
    expect(mockPlanner.getCurrentUser).toHaveBeenCalledTimes(5);
    agent.stop();
  });

  it("should scope the task fetch to the configured projects when every action is project-bound", async () => {
    mockPlanner.listProjects.mockResolvedValue([
      { id: "proj-web", name: "Web", description: "" },
      { id: "proj-docs", name: "Docs", description: "" },
      { id: "proj-other", name: "Other", description: "" },
    ]);
    mockPlannerTasks([]);
    const agent = createAgent({
      defaultModel: "",
      defaultTimeout: null,
      actions: [
        {
          project: "Web",
          statusStart: "To Do",
          statusEnd: "Done",
          trigger: "status",
          model: "",
          instruction: "",
          timeout: null,
          weight: null,
        },
        {
          project: "Docs*",
          statusStart: "To Do",
          statusEnd: "Done",
          trigger: "status",
          model: "",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    });
    agent.start();
    await waitFor(() => mockPlanner.listAssignedTasks.mock.calls.length === 1);
    agent.stop();

    expect(mockPlanner.listAssignedTasks).toHaveBeenCalledWith(
      { id: "user-1", name: "Test User" },
      ["proj-web", "proj-docs"],
    );
  });

  it("should fetch the tasks unscoped when an action matches every project", async () => {
    mockPlannerTasks([]);
    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.listAssignedTasks.mock.calls.length === 1);
    agent.stop();

    expect(mockPlanner.listAssignedTasks).toHaveBeenCalledWith(
      { id: "user-1", name: "Test User" },
      undefined,
    );
  });

  it("should fetch the tasks unscoped when no project matches the patterns", async () => {
    mockPlanner.listProjects.mockResolvedValue([
      { id: "proj-other", name: "Other", description: "" },
    ]);
    mockPlannerTasks([]);
    const agent = createAgent({
      defaultModel: "",
      defaultTimeout: null,
      actions: [
        {
          project: "Web",
          statusStart: "To Do",
          statusEnd: "Done",
          trigger: "status",
          model: "",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    });
    agent.start();
    await waitFor(() => mockPlanner.listAssignedTasks.mock.calls.length === 1);
    agent.stop();

    expect(mockPlanner.listAssignedTasks).toHaveBeenCalledWith(
      { id: "user-1", name: "Test User" },
      undefined,
    );
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

  it("should not process a task whose dependencies are not Done", async () => {
    let resolvePoll: (() => void) | undefined = undefined;
    mockPlanner.listAssignedTasks.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePoll = () =>
            resolve([
              {
                id: "task-1",
                title: "Blocked work",
                status: "To Do",
                description: "Add a feature",
                comments: [],
                attachments: [],
                dependencies: [
                  { taskId: "task-2", title: "First step", status: "In Progress" },
                ],
              },
            ]);
        }),
    );

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.listAssignedTasks.mock.calls.length === 1);
    resolvePoll!();
    // The selection round loads the projects before reporting the deferrals.
    await waitFor(() => mockPlanner.listProjects.mock.calls.length > 0);

    expect(mockQoder.performTask).not.toHaveBeenCalled();
    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
    expect(mockPlanner.addTaskComment).not.toHaveBeenCalled();
    agent.stop();
  });

  it("should not process a task whose dependency has no hydrated status", async () => {
    let resolvePoll: (() => void) | undefined = undefined;
    mockPlanner.listAssignedTasks.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePoll = () =>
            resolve([
              {
                id: "task-1",
                title: "Blocked work",
                status: "To Do",
                description: "Add a feature",
                comments: [],
                attachments: [],
                dependencies: [{ taskId: "task-2" }],
              },
            ]);
        }),
    );

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.listAssignedTasks.mock.calls.length === 1);
    resolvePoll!();
    await waitFor(() => mockPlanner.listProjects.mock.calls.length > 0);

    expect(mockQoder.performTask).not.toHaveBeenCalled();
    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
    agent.stop();
  });

  it("should process a task whose dependencies are all Done", async () => {
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        title: "Unblocked work",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
        dependencies: [
          { taskId: "task-2", title: "First step", status: "Done" },
        ],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      path.join(dataDir, "tasks", "task-1-Agent.md"),
      expect.objectContaining({ model: "", instruction: "" }),
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith("task-1", "Done");
    agent.stop();
  });

  it("should render the dependencies in the task notes file", async () => {
    config.TASK_STATUS_CLEANUP = "Archived";
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        title: "Follow-up work",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
        dependencies: [
          { taskId: "task-2", title: "First step", status: "Done" },
          { taskId: "task-3", status: "Done" },
        ],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    const notesFile = path.join(dataDir, "tasks", "task-1-Agent.md");
    expect(await fse.pathExists(notesFile)).toBe(true);
    const content = await fse.readFile(notesFile, "utf8");
    expect(content).toContain("## Dependencies");
    expect(content).toContain("- First step (task-2) — status: Done");
    expect(content).toContain("- task-3 (task-3) — status: Done");
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

  it("should move a failing task to the action error status when configured", async () => {
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

    const actions: AgentActionsConfig = {
      defaultStatusError: "Review",
      defaultModel: "",
      defaultTimeout: null,
      actions: [
        {
          project: "",
          statusStart: "To Do",
          statusEnd: "Done",
          trigger: "status",
          statusError: "Blocked",
          model: "",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    };
    const agent = createAgent(actions);
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(
      "task-1",
      "Blocked",
    );
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      "task-1",
      expect.stringContaining("The task was moved to 'Blocked'"),
    );
    agent.stop();
  });

  it("should move a failing task to the default error status when the action has none", async () => {
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

    const actions: AgentActionsConfig = {
      defaultStatusError: "Review",
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
    const agent = createAgent(actions);
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(
      "task-1",
      "Review",
    );
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      "task-1",
      expect.stringContaining("The task was moved to 'Review'"),
    );
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

  it("should report an empty queue when nothing is waiting or running", () => {
    createAgent();

    const result = { observe: jest.fn() };
    observableGauges["tasks.queue"](result);

    expect(result.observe.mock.calls).toEqual([
      [0, { type: "tasks_queued" }],
      [0, { type: "tasks_in_progress" }],
      [0, { type: "weight_in_progress" }],
    ]);
  });

  it("should export the queue gauge with the waiting and running tasks", async () => {
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
        title: "Waiting task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockQoder.performTask.mock.calls.length === 1);

    // One task is being processed (default weight 1) and the second one is
    // waiting to be admitted by the scheduler.
    const result = { observe: jest.fn() };
    observableGauges["tasks.queue"](result);

    expect(result.observe.mock.calls).toEqual([
      [1, { type: "tasks_queued" }],
      [1, { type: "tasks_in_progress" }],
      [1, { type: "weight_in_progress" }],
    ]);

    resolveFirst("First task done");
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);
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

  it("should skip attachments with unsafe file names and download the valid ones", async () => {
    config.TASK_STATUS_CLEANUP = "Archived";
    const unsafeNames = [
      "../escaped.txt",
      "../../deep/escape.txt",
      "/tmp/evil.txt",
      "a\\b.txt",
      "sub/dir/name.txt",
      ".",
      "..",
      "",
    ];
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [
          {
            id: "attachment-safe",
            fileName: "notes.txt",
            filePath: "/uploads/notes.txt",
            dateCreated: "2026-09-02T00:00:00.000Z",
          },
          ...unsafeNames.map((fileName, index) => ({
            id: `attachment-unsafe-${index}`,
            fileName,
            filePath: `/uploads/attachment-${index}`,
            dateCreated: "2026-09-02T00:00:00.000Z",
          })),
        ],
      },
    ]);
    mockPlanner.downloadTaskAttachment.mockResolvedValue(Buffer.from("image"));
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    // Only the safe attachment is written, inside the attachments directory.
    const attachmentsDir = path.join(dataDir, "tasks", "task-1", "attachments");
    expect((await fse.readdir(attachmentsDir)).sort()).toEqual(["notes.txt"]);
    const tasksDir = path.join(dataDir, "tasks");
    const taskDirEntries = await fse.readdir(tasksDir);
    expect(taskDirEntries).toContain("task-1");
    expect(taskDirEntries).not.toContain("escaped.txt");
    expect(taskDirEntries).not.toContain("deep");

    // The notes file lists the safe attachment and marks the unsafe ones.
    const content = await fse.readFile(
      path.join(dataDir, "tasks", "task-1-Agent.md"),
      "utf8",
    );
    expect(content).toContain("notes.txt");
    expect(content).toContain("(unsafe file name, skipped)");
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
    // The folder cleanup runs after the status update: wait for the actual
    // removal instead of racing it.
    await waitFor(
      () =>
        !fse.pathExistsSync(path.join(dataDir, "tasks", taskId)) &&
        !fse.pathExistsSync(
          path.join(dataDir, "tasks", `${taskId}-Agent.md`),
        ),
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

  it("should not re-execute a task whose summary comment failed and should finalize it on retry", async () => {
    config.TASK_POLLING_INTERVAL = 0.05;
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
    mockQoder.performTask.mockResolvedValue("All done");
    // The summary comment POST fails on the first attempt only.
    let summaryCommentAttempts = 0;
    mockPlanner.addTaskComment.mockImplementation(
      async (_id: string, text: string) => {
        if (text === "All done") {
          summaryCommentAttempts++;
          if (summaryCommentAttempts === 1) {
            throw new Error("Planner is down");
          }
        }
      },
    );

    const agent = createAgent(
      WILDCARD_ACTIONS,
      new FinalizationStore({ retryBaseMs: 10 }),
    );
    agent.start();
    await waitFor(
      () =>
        mockPlanner.updateTaskStatus.mock.calls.some(
          (call) => call[0] === "task-1" && call[1] === "Done",
        ),
      5000,
    );

    // The CLI ran exactly once although the first finalization failed: only
    // the Planner updates were retried.
    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(summaryCommentAttempts).toBe(2);
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith("task-1", "Done");
  });

  it("should not post the summary comment twice when only the status update fails", async () => {
    config.TASK_POLLING_INTERVAL = 0.05;
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
    mockQoder.performTask.mockResolvedValue("All done");
    mockPlanner.updateTaskStatus.mockRejectedValue(new Error("Planner is down"));

    const agent = createAgent(
      WILDCARD_ACTIONS,
      new FinalizationStore({ retryBaseMs: 10 }),
    );
    agent.start();
    await waitFor(
      () =>
        mockPlanner.updateTaskStatus.mock.calls.filter(
          (call) => call[0] === "task-1" && call[1] === "Done",
        ).length >= 2,
      5000,
    );

    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    const summaryComments = mockPlanner.addTaskComment.mock.calls.filter(
      (call) => call[1] === "All done",
    );
    expect(summaryComments).toHaveLength(1);
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
          trigger: "status",
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
          trigger: "status",
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
          trigger: "status",
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
          trigger: "status",
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
          trigger: "status",
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
          trigger: "status",
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
          trigger: "status",
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
    config.AGENT_START_COMMENT = true;
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
    config.AGENT_START_COMMENT = true;
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
          trigger: "status",
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
          trigger: "status",
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
          trigger: "status",
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

  it("should process tasks by the action priority over the task priority", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    const resolvers: ((value: string) => void)[] = [];
    mockPlanner.listProjects.mockResolvedValue([
      { id: "p1", name: "Alpha", description: "" },
      { id: "p2", name: "Beta", description: "" },
    ]);
    mockPlannerTasks([
      {
        id: "task-alpha-low",
        projectId: "p1",
        title: "Low priority task of a high-priority action",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
        priority: "low",
      },
      {
        id: "task-beta-high",
        projectId: "p2",
        title: "High priority task of a default action",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
        priority: "high",
      },
    ]);
    mockQoder.performTask.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const agent = createAgent({
      defaultModel: "",
      defaultTimeout: null,
      actions: [
        {
          project: "Alpha*",
          statusStart: "To Do",
          statusEnd: "Done",
          trigger: "status",
          model: "",
          instruction: "",
          timeout: null,
          weight: null,
          priority: "high",
        },
        {
          project: "Beta*",
          statusStart: "To Do",
          statusEnd: "Done",
          trigger: "status",
          model: "",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    });
    agent.start();
    await waitFor(() => mockQoder.performTask.mock.calls.length === 1);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-alpha-low" }),
      expect.any(String),
      expect.anything(),
    );

    resolvers[0]("Alpha done");
    await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-beta-high" }),
      expect.any(String),
      expect.anything(),
    );
    resolvers[1]("Beta done");
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length === 2);
    agent.stop();
  });

  it("should demote the tasks of a low-priority action", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    const resolvers: ((value: string) => void)[] = [];
    mockPlanner.listProjects.mockResolvedValue([
      { id: "p1", name: "Gamma", description: "" },
      { id: "p2", name: "Delta", description: "" },
    ]);
    mockPlannerTasks([
      {
        id: "task-gamma-high",
        projectId: "p1",
        title: "High priority task of a low-priority action",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
        priority: "high",
      },
      {
        id: "task-delta-medium",
        projectId: "p2",
        title: "Medium priority task of a default action",
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

    const agent = createAgent({
      defaultModel: "",
      defaultTimeout: null,
      actions: [
        {
          project: "Gamma*",
          statusStart: "To Do",
          statusEnd: "Done",
          trigger: "status",
          model: "",
          instruction: "",
          timeout: null,
          weight: null,
          priority: "low",
        },
        {
          project: "Delta*",
          statusStart: "To Do",
          statusEnd: "Done",
          trigger: "status",
          model: "",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    });
    agent.start();
    await waitFor(() => mockQoder.performTask.mock.calls.length === 1);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-delta-medium" }),
      expect.any(String),
      expect.anything(),
    );

    resolvers[0]("Delta done");
    await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-gamma-high" }),
      expect.any(String),
      expect.anything(),
    );
    resolvers[1]("Gamma done");
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length === 2);
    agent.stop();
  });

  it("should apply the action priority with the oldest-update tiebreak", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    const resolvers: ((value: string) => void)[] = [];
    mockPlanner.listProjects.mockResolvedValue([
      { id: "p1", name: "Epsilon", description: "" },
    ]);
    mockPlannerTasks([
      {
        id: "task-newest",
        projectId: "p1",
        title: "Newest task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
        priority: "low",
        dateUpdated: "2026-09-10T00:00:00.000Z",
      },
      {
        id: "task-oldest",
        projectId: "p1",
        title: "Oldest task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
        priority: "low",
        dateUpdated: "2026-09-01T00:00:00.000Z",
      },
    ]);
    mockQoder.performTask.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const agent = createAgent({
      defaultModel: "",
      defaultTimeout: null,
      actions: [
        {
          project: "Epsilon*",
          statusStart: "To Do",
          statusEnd: "Done",
          trigger: "status",
          model: "",
          instruction: "",
          timeout: null,
          weight: null,
          priority: "high",
        },
      ],
    });
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
      expect.objectContaining({ id: "task-newest" }),
      expect.any(String),
      expect.anything(),
    );
    resolvers[1]("Newest done");
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

  it("should use the updated actions on the next poll when they change in place", async () => {
    config.TASK_POLLING_INTERVAL = 1;
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
    mockPlannerTasks([
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
      {
        id: "task-2",
        title: "Fix the bug",
        status: "Backlog",
        description: "",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Task done");

    const agent = createAgent(actions);
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith("task-1", "Done");

    // The actions object is updated in place, as AgentActionsManager does on
    // a configuration change: the next poll uses the new actions.
    actions.actions = [
      {
        project: "",
        statusStart: "Backlog",
        statusEnd: "Archived",
        trigger: "status",
        model: "",
        instruction: "",
        timeout: null,
        weight: null,
      },
    ];

    await waitFor(
      () => mockPlanner.updateTaskStatus.mock.calls.length > 1,
      4000,
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(
      "task-2",
      "Archived",
    );
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
    // The two round-1 tasks are processed in parallel: performTask is
    // called in a non-deterministic order, so the pending executions are
    // keyed by task id (a positional index could resolve the migration
    // instead of the API task and release the conflict lock too early).
    const resolvers = new Map<string, (value: string) => void>();
    mockQoder.performTask.mockImplementation(
      (task: { id: string }) =>
        new Promise<string>((resolve) => {
          resolvers.set(task.id, resolve);
        }),
    );
    const resolveTask = (id: string, value: string): void => {
      const resolve = resolvers.get(id);
      if (resolve === undefined) {
        throw new Error(`No task execution pending for '${id}'`);
      }
      resolve(value);
    };

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
    resolveTask("task-3", "API fix done");
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(mockQoder.performTask).toHaveBeenCalledTimes(2);

    // Round 3: the migration completes and releases the lock; the follow-up
    // is finally picked.
    resolveTask("task-1", "Web migration done");
    await waitFor(
      () => mockQoder.performTask.mock.calls.length === 3,
      5000,
    );
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-2" }),
      expect.any(String),
      expect.anything(),
    );
    resolveTask("task-2", "Web follow-up done");
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
            trigger: "status",
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

  it("should finalize the task without an adjustment pass when no new comments arrived", async () => {
    config.TASK_ADJUSTMENT_MAX_ROUNDS = 2;
    // The status update is stateful, so the completed task is not picked
    // again by a later poll while the assertions run.
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
    // The add of the run labels, the new-comment check and the removal of
    // the running label each re-read the task: wait for the removal too, so
    // the count is asserted after the processing fully completed.
    await waitFor(() => mockPlanner.getTask.mock.calls.length >= 3);

    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(mockPlanner.getTask).toHaveBeenCalledTimes(3);
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      "task-1",
      "Feature implemented",
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledTimes(1);
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith("task-1", "Done");
    agent.stop();
  });

  it("should re-run the CLI with the new comments before finalizing when a human comments during the run", async () => {
    config.TASK_STATUS_CLEANUP = "Archived";
    const notesFile = path.join(dataDir, "tasks", "task-1-Agent.md");
    await fse.ensureDir(path.dirname(notesFile));
    await fse.writeFile(
      notesFile,
      [
        "# Task: Implement feature",
        "",
        AGENT_NOTES_MARKER,
        "",
        "## Agent Notes",
        "",
        "Notes from a previous run",
      ].join("\n"),
    );
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [
          {
            id: "comment-old",
            userId: "user-2",
            userName: "Alice",
            text: "Start with the tests",
            dateCreated: "2026-10-14T00:00:00.000Z",
          },
        ],
        attachments: [],
      },
    ]);
    // A human comment arrives while the CLI runs: the fresh fetch sees it.
    mockPlanner.getTask.mockResolvedValue({
      id: "task-1",
      projectId: "",
      title: "Implement feature",
      status: "To Do",
      priority: "medium",
      description: "Add a feature",
      dateUpdated: "2026-10-15T01:00:00.000Z",
      comments: [
        {
          id: "comment-old",
          userId: "user-2",
          userName: "Alice",
          text: "Start with the tests",
          dateCreated: "2026-10-14T00:00:00.000Z",
        },
        {
          id: "comment-new",
          userId: "user-2",
          userName: "Alice",
          text: "Please also update the docs",
          dateCreated: "2026-10-15T00:30:00.000Z",
        },
      ],
      attachments: [],
      dependencies: [],
    });
    mockQoder.performTask
      .mockResolvedValueOnce("First run summary")
      .mockResolvedValueOnce("Adjusted summary");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledTimes(2);
    const secondOptions = mockQoder.performTask.mock.calls[1]![2] as {
      instruction: string;
    };
    expect(secondOptions.instruction).toContain(
      "New comments were posted on this task after your previous run",
    );
    expect(secondOptions.instruction).toContain(
      "**Alice** (2026-10-15T00:30:00.000Z): Please also update the docs",
    );
    const content = await fse.readFile(notesFile, "utf8");
    expect(content).toContain("Please also update the docs");
    expect(content).toContain("Notes from a previous run");
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      "task-1",
      "Adjusted summary",
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledTimes(1);
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith("task-1", "Done");
    agent.stop();
  });

  it("should not count the agent's own comments as new messages", async () => {
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
    // The agent's start comment (its own Planner user) is the only new one.
    mockPlanner.getTask.mockResolvedValue({
      id: "task-1",
      projectId: "",
      title: "Implement feature",
      status: "To Do",
      priority: "medium",
      description: "Add a feature",
      dateUpdated: "2026-10-15T01:00:00.000Z",
      comments: [
        {
          id: "comment-agent",
          userId: "user-1",
          userName: "Test User",
          text: "Agent 'planner-llm-agent' started working on this task.",
          dateCreated: "2026-10-15T00:30:00.000Z",
        },
      ],
      attachments: [],
      dependencies: [],
    });
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      "task-1",
      "Feature implemented",
    );
    agent.stop();
  });

  it("should finalize the task as-is when the new-comment check fails", async () => {
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
    mockPlanner.getTask.mockRejectedValue(
      new Error(
        "Planner request to '/api/tasks/task-1' failed with status 500",
      ),
    );
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
    expect(
      logSpy.mock.calls.some((call) =>
        String(call[0]).includes(
          "Failed to check task 'Implement feature' (task-1) for new comments",
        ),
      ),
    ).toBe(true);
    agent.stop();
  });

  it("should bound the adjustment rounds by TASK_ADJUSTMENT_MAX_ROUNDS", async () => {
    config.TASK_ADJUSTMENT_MAX_ROUNDS = 2;
    // The status update is stateful, so the completed task is not picked
    // again by a later poll while the assertions run.
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
    // A new human comment every time the task is re-fetched.
    let fetchRound = 0;
    mockPlanner.getTask.mockImplementation(async () => {
      fetchRound++;
      return {
        id: "task-1",
        projectId: "",
        title: "Implement feature",
        status: "To Do",
        priority: "medium",
        description: "Add a feature",
        dateUpdated: `2026-10-15T0${fetchRound}:00:00.000Z`,
        comments: [
          {
            id: `comment-during-${fetchRound}`,
            userId: "user-2",
            userName: "Alice",
            text: `Message ${fetchRound}`,
            dateCreated: `2026-10-15T0${fetchRound}:00:00.000Z`,
          },
        ],
        attachments: [],
        dependencies: [],
      };
    });
    mockQoder.performTask.mockImplementation(async () => {
      return `Summary after call ${mockQoder.performTask.mock.calls.length}`;
    });

    const agent = createAgent();
    agent.start();
    // Two adjustment checks plus the bounded final check, with the run-label
    // add and removal reads around them: wait for the removal too, so the
    // count is asserted after the processing fully completed.
    await waitFor(() => mockPlanner.getTask.mock.calls.length >= 5);

    expect(mockQoder.performTask).toHaveBeenCalledTimes(3);
    expect(mockPlanner.getTask).toHaveBeenCalledTimes(5);
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      "task-1",
      "Summary after call 3",
    );
    expect(
      logSpy.mock.calls.some((call) =>
        String(call[0]).includes("adjustment budget of 2 round(s)"),
      ),
    ).toBe(true);
    agent.stop();
  });

  it("should not re-run the CLI when TASK_ADJUSTMENT_MAX_ROUNDS is 0", async () => {
    config.TASK_ADJUSTMENT_MAX_ROUNDS = 0;
    // The status update is stateful, so the completed task is not picked
    // again by a later poll while the assertions run.
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
    mockPlanner.getTask.mockResolvedValue({
      id: "task-1",
      projectId: "",
      title: "Implement feature",
      status: "To Do",
      priority: "medium",
      description: "Add a feature",
      dateUpdated: "2026-10-15T01:00:00.000Z",
      comments: [
        {
          id: "comment-new",
          userId: "user-2",
          userName: "Alice",
          text: "A late message",
          dateCreated: "2026-10-15T00:30:00.000Z",
        },
      ],
      attachments: [],
      dependencies: [],
    });
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = createAgent();
    agent.start();
    // The run-label add, the detection-only new-comment check and the
    // running-label removal each re-read the task: wait for the removal
    // too, so the count is asserted after the processing fully completed.
    await waitFor(() => mockPlanner.getTask.mock.calls.length >= 3);

    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(mockPlanner.getTask).toHaveBeenCalledTimes(3);
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      "task-1",
      "Feature implemented",
    );
    expect(
      logSpy.mock.calls.some((call) =>
        String(call[0]).includes("adjustment budget of 0 round(s)"),
      ),
    ).toBe(true);
    agent.stop();
  });

  it("should move the task to the error status when an adjustment run fails", async () => {
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
    mockPlanner.getTask.mockResolvedValue({
      id: "task-1",
      projectId: "",
      title: "Implement feature",
      status: "To Do",
      priority: "medium",
      description: "Add a feature",
      dateUpdated: "2026-10-15T01:00:00.000Z",
      comments: [
        {
          id: "comment-new",
          userId: "user-2",
          userName: "Alice",
          text: "A late message",
          dateCreated: "2026-10-15T00:30:00.000Z",
        },
      ],
      attachments: [],
      dependencies: [],
    });
    mockQoder.performTask
      .mockResolvedValueOnce("First run summary")
      .mockRejectedValueOnce(new Error("Adjustment run failed"));

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledTimes(2);
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      "task-1",
      expect.stringContaining("Task processing failed:"),
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith("task-1", "Done");
    agent.stop();
  });

  it("should record the last summary and the fresh content version in the finalization store", async () => {
    const store = new FinalizationStore({ retryBaseMs: 60000 });
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
    mockPlanner.getTask.mockResolvedValue({
      id: "task-1",
      projectId: "",
      title: "Implement feature",
      status: "To Do",
      priority: "medium",
      description: "Add a feature",
      dateUpdated: "2026-10-15T01:00:00.000Z",
      comments: [
        {
          id: "comment-new",
          userId: "user-2",
          userName: "Alice",
          text: "A late message",
          dateCreated: "2026-10-15T00:30:00.000Z",
        },
      ],
      attachments: [],
      dependencies: [],
    });
    mockQoder.performTask
      .mockResolvedValueOnce("First run summary")
      .mockResolvedValueOnce("Adjusted summary");
    // The summary comment POST fails so the record stays inspectable.
    let summaryAttempts = 0;
    mockPlanner.addTaskComment.mockImplementation(
      async (_id: string, text: string) => {
        if (text === "Adjusted summary") {
          summaryAttempts++;
          if (summaryAttempts === 1) {
            throw new Error("Planner is down");
          }
        }
      },
    );

    const agent = createAgent(WILDCARD_ACTIONS, store);
    agent.start();
    await waitFor(
      () => store.has("task-1") && store.get("task-1")!.attempts >= 1,
      5000,
    );

    const record = store.get("task-1")!;
    expect(record.summary).toBe("Adjusted summary");
    expect(record.contentVersion).toBe("2026-10-15T01:00:00.000Z");
    agent.stop();
  });

  it("should move a picked task to the configured in-progress status", async () => {
    mockPlanner.listProjects.mockResolvedValue([
      { id: "p1", name: "Web", description: "", statuses: ["To Do", "In Progress", "Done"] },
    ]);
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        projectId: "p1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const actions: AgentActionsConfig = {
      defaultModel: "",
      defaultTimeout: null,
      actions: [
        {
          project: "Web",
          statusStart: "To Do",
          statusEnd: "Done",
          trigger: "status",
          statusInProgress: "In Progress",
          model: "",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    };
    const agent = createAgent(actions);
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length >= 2);

    expect(mockPlanner.updateTaskStatus.mock.calls.map((call) => call[1])).toEqual([
      "In Progress",
      "Done",
    ]);
    agent.stop();
  });

  it("should use the default in-progress status when the action has none", async () => {
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
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const actions: AgentActionsConfig = {
      defaultStatusInProgress: "In Progress",
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
    const agent = createAgent(actions);
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length >= 2);

    expect(mockPlanner.updateTaskStatus.mock.calls.map((call) => call[1])).toEqual([
      "In Progress",
      "Done",
    ]);
    agent.stop();
  });

  it("should keep processing a task whose in-progress status is missing from the project catalog", async () => {
    mockPlanner.listProjects.mockResolvedValue([
      { id: "p1", name: "Web", description: "", statuses: ["To Do", "Done"] },
    ]);
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        projectId: "p1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const actions: AgentActionsConfig = {
      defaultModel: "",
      defaultTimeout: null,
      actions: [
        {
          project: "Web",
          statusStart: "To Do",
          statusEnd: "Done",
          trigger: "status",
          statusInProgress: "In Progress",
          model: "",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    };
    const agent = createAgent(actions);
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "the status does not exist in project 'Web'",
      ),
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledTimes(1);
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith("task-1", "Done");
    agent.stop();
  });

  it("should not fail the task when the in-progress transition fails", async () => {
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
    mockPlanner.updateTaskStatus.mockRejectedValueOnce(
      new Error("Planner is down"),
    );
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const actions: AgentActionsConfig = {
      defaultStatusInProgress: "In Progress",
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
    const agent = createAgent(actions);
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length >= 2);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Failed to move task 'Implement feature' (task-1) to the in-progress status 'In Progress' (continuing)",
      ),
    );
    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith("task-1", "Done");
    agent.stop();
  });

  it("should mention the resolved model in the start notification", async () => {
    config.AGENT_NAME = "test-agent";
    config.AGENT_START_COMMENT = true;
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
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const actions: AgentActionsConfig = {
      defaultModel: "task-model",
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
    const agent = createAgent(actions);
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      "task-1",
      "Agent 'test-agent' started working on this task (model task-model).",
    );
    agent.stop();
  });

  it("should post progress comments while a long task runs", async () => {
    config.TASK_PROGRESS_COMMENT_INTERVAL = 1;
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
    await waitFor(() => mockQoder.performTask.mock.calls.length === 1);
    await waitFor(() =>
      mockPlanner.addTaskComment.mock.calls.some((call) =>
        String(call[1]).startsWith("Still working on this task (elapsed"),
      ),
      5000,
    );

    const progressComment = mockPlanner.addTaskComment.mock.calls
      .map((call) => call[1] as string)
      .find((text) => text.startsWith("Still working on this task (elapsed"));
    expect(progressComment).toMatch(/elapsed \d+s\)\.$/);
    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();

    resolveTask("Feature implemented");
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      "task-1",
      "Feature implemented",
    );
    agent.stop();
  });

  it("should abort a running task when its status moves to the abort status", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    const store = new FinalizationStore({ retryBaseMs: 60000 });
    const tasks = [
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [] as unknown[],
        attachments: [] as unknown[],
      },
    ];
    mockPlanner.listAssignedTasks.mockImplementation(async () =>
      tasks.map((task) => ({ ...task })),
    );
    mockQoder.performTask.mockImplementation(
      (_task: unknown, _notesFile: string, options?: TaskOptions) =>
        new Promise<string>((_resolve, reject) => {
          options?.abortSignal?.addEventListener(
            "abort",
            () => reject(new CliAbortedError("Qoder task execution aborted")),
            { once: true },
          );
        }),
    );

    const actions: AgentActionsConfig = {
      defaultStatusAbort: "Aborted",
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
    const agent = createAgent(actions, store);
    agent.start();
    await waitFor(() => mockQoder.performTask.mock.calls.length === 1);

    // The user cancels the task by moving it to the abort status on Planner.
    tasks[0].status = "Aborted";
    await waitFor(
      () =>
        mockPlanner.addTaskComment.mock.calls.some((call) =>
          String(call[1]).includes("Task aborted at user request"),
        ),
      10000,
    );

    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      "task-1",
      expect.stringContaining("the task status was moved to 'Aborted' on Planner"),
    );
    // The user-set status is kept: no end status, no error status, no
    // finalization record (the CLI work is never re-run either way).
    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
    expect(store.has("task-1")).toBe(false);
    agent.stop();
  });

  it("should mark the task running and record the model, then clear the running label", async () => {
    const task = {
      id: "task-1",
      title: "Implement feature",
      status: "To Do",
      description: "Add a feature",
      comments: [],
      attachments: [],
      labels: ["urgent"],
    };
    const writes = mockTaskLabels(task);
    mockQoder.performTask.mockResolvedValue("Feature implemented");
    const actions: AgentActionsConfig = {
      defaultModel: "Qwen3.8-Flash",
      defaultTimeout: null,
      actions: WILDCARD_ACTIONS.actions,
    };

    const agent = createAgent(actions);
    agent.start();
    await waitFor(() => writes.length === 2);

    // One replacement before the run (human label preserved, model
    // normalized) and one when it ends (the transient label only).
    expect(writes).toEqual([
      ["urgent", "agent:running", "model:qwen3.8-flash"],
      ["urgent", "model:qwen3.8-flash"],
    ]);
    // The legacy start comment is off by default: only the summary is posted.
    expect(mockPlanner.addTaskComment).toHaveBeenCalledTimes(1);
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      "task-1",
      "Feature implemented",
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith("task-1", "Done");
    agent.stop();
  });

  it("should record the CLI agent label when a prefix is configured", async () => {
    config.TASK_CLI_LABEL_PREFIX = "agent:";
    const task = {
      id: "task-1",
      title: "Implement feature",
      status: "To Do",
      description: "Add a feature",
      comments: [],
      attachments: [],
    };
    const writes = mockTaskLabels(task);
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = createAgent();
    agent.start();
    await waitFor(() => writes.length === 2);

    expect(writes[0]).toEqual(["agent:running", "agent:qoder"]);
    expect(writes[1]).toEqual(["agent:qoder"]);
    agent.stop();
  });

  it("should skip a no-op label write when the running label is already set", async () => {
    const task = {
      id: "task-1",
      title: "Implement feature",
      status: "To Do",
      description: "Add a feature",
      comments: [],
      attachments: [],
      labels: ["agent:running", "model:qwen3.8-flash"],
    };
    const writes = mockTaskLabels(task);
    mockQoder.performTask.mockResolvedValue("Feature implemented");
    const actions: AgentActionsConfig = {
      defaultModel: "Qwen3.8-Flash",
      defaultTimeout: null,
      actions: WILDCARD_ACTIONS.actions,
    };

    const agent = createAgent(actions);
    agent.start();
    await waitFor(() => writes.length === 1);

    // The add matches the current labels (no write); only the final removal
    // is written.
    expect(writes).toEqual([["model:qwen3.8-flash"]]);
    agent.stop();
  });

  it("should clear the running label when the task fails", async () => {
    const task = {
      id: "task-1",
      title: "Implement feature",
      status: "To Do",
      description: "Add a feature",
      comments: [],
      attachments: [],
    };
    const writes = mockTaskLabels(task);
    mockQoder.performTask.mockRejectedValue(new Error("CLI exploded"));

    const agent = createAgent();
    agent.start();
    await waitFor(() => writes.length === 2);

    expect(writes[0]).toContain("agent:running");
    expect(writes[1]).not.toContain("agent:running");
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith("task-1", "Done");
    agent.stop();
  });

  it("should clear the running label when the task is aborted", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    const tasks = [
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [] as unknown[],
        attachments: [] as unknown[],
        labels: [] as string[],
      },
    ];
    mockPlanner.listAssignedTasks.mockImplementation(async () =>
      tasks.map((task) => ({ ...task, labels: [...task.labels] })),
    );
    mockPlanner.getTask.mockImplementation(async () => ({
      ...tasks[0],
      labels: [...tasks[0].labels],
    }));
    const writes: string[][] = [];
    mockPlanner.updateTaskLabels.mockImplementation(
      async (_taskId: string, labels: string[]) => {
        writes.push([...labels]);
        tasks[0].labels = [...labels];
      },
    );
    mockQoder.performTask.mockImplementation(
      (_task: unknown, _notesFile: string, options?: TaskOptions) =>
        new Promise<string>((_resolve, reject) => {
          options?.abortSignal?.addEventListener(
            "abort",
            () => reject(new CliAbortedError("Qoder task execution aborted")),
            { once: true },
          );
        }),
    );
    const actions: AgentActionsConfig = {
      defaultStatusAbort: "Aborted",
      defaultModel: "",
      defaultTimeout: null,
      actions: WILDCARD_ACTIONS.actions,
    };

    const agent = createAgent(actions);
    agent.start();
    await waitFor(() => mockQoder.performTask.mock.calls.length === 1);
    tasks[0].status = "Aborted";
    await waitFor(() => writes.length === 2, 10000);

    expect(writes[0]).toContain("agent:running");
    expect(writes[1]).not.toContain("agent:running");
    agent.stop();
  });

  it("should not fail the task when the label writes fail", async () => {
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
    mockPlanner.getTask.mockRejectedValue(new Error("Planner is down"));
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
        "Failed to add the agent labels (agent:running) for task 'Implement feature' (task-1)",
      ),
    );
    agent.stop();
  });

  it("should not write labels when TASK_LABELS is false", async () => {
    config.TASK_LABELS = false;
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
        labels: ["urgent"],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockPlanner.updateTaskLabels).not.toHaveBeenCalled();
    agent.stop();
  });

  it("should reconcile the stale running labels after the startup delay", async () => {
    jest.useFakeTimers();
    const tasks = [
      {
        id: "task-stale",
        title: "Stale task",
        status: "Done",
        description: "",
        comments: [],
        attachments: [],
        labels: ["agent:running", "model:qwen3.8-flash"],
      },
    ];
    mockPlanner.listAssignedTasks.mockImplementation(
      async (_user, _projectIds, labels?: string[]) =>
        labels ? tasks.map((task) => ({ ...task })) : [],
    );
    mockPlanner.getTask.mockImplementation(async (taskId: string) => ({
      ...tasks.find((task) => task.id === taskId),
      labels: [...tasks[0].labels],
    }));

    const agent = createAgent();
    agent.start();
    await jest.advanceTimersByTimeAsync(59999);
    expect(mockPlanner.updateTaskLabels).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(mockPlanner.listAssignedTasks).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-1" }),
      undefined,
      ["agent:running"],
    );
    expect(mockPlanner.updateTaskLabels).toHaveBeenCalledWith("task-stale", [
      "model:qwen3.8-flash",
    ]);
    agent.stop();
  });

  it("should not reconcile the running labels when labels are disabled", async () => {
    jest.useFakeTimers();
    config.TASK_LABELS = false;

    const agent = createAgent();
    agent.start();
    await jest.advanceTimersByTimeAsync(60000);

    expect(mockPlanner.listAssignedTasks).not.toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      ["agent:running"],
    );
    agent.stop();
  });

  it("should salvage the partial summary and CLI output into the failure comment", async () => {
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
    fse.outputFileSync(
      path.join(dataDir, "tasks", "task-1-Agent-Summary.md"),
      "## Partial progress\n- Implemented the first module",
    );
    mockQoder.performTask.mockRejectedValue(
      Object.assign(new Error("Qoder task execution failed:\nboom"), {
        stdout: "Step 2 started",
        stderr: "Error: boom\n    at run (cli.js:1)",
      }),
    );

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    const failureComment = mockPlanner.addTaskComment.mock.calls
      .map((call) => call[1] as string)
      .find((text) => text.includes("Task processing failed:"));
    expect(failureComment).toContain("Partial summary written before the failure:");
    expect(failureComment).toContain("Implemented the first module");
    expect(failureComment).toContain("Last CLI output:");
    expect(failureComment).toContain("Error: boom");
    agent.stop();
  });

  it("should expose the live scheduling state for the agent note", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    mockPlanner.listProjects.mockResolvedValue([
      { id: "p1", name: "Web", description: "" },
    ]);
    mockPlannerTasks([
      {
        id: "task-1",
        projectId: "p1",
        title: "First task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
      {
        id: "task-2",
        projectId: "p1",
        title: "Second task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
    ]);
    let resolveFirst: (value: string) => void = () => undefined;
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
    await waitFor(() => mockQoder.performTask.mock.calls.length === 1);

    const state = agent.getSchedulingState();
    expect(state.running).toHaveLength(1);
    expect(state.running[0]).toMatchObject({
      title: "First task",
      project: "Web",
    });
    expect(state.running[0].elapsed).toMatch(/^\d+s$/);
    expect(state.queuedCount).toBe(1);
    expect(state.queuedTitles).toEqual(["Second task"]);

    resolveFirst("First task done");
    // The second task is picked by a later poll, which also drains the queue.
    await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
    await waitFor(() => agent.getSchedulingState().running.length === 0);
    expect(agent.getSchedulingState().queuedCount).toBe(0);
    agent.stop();
  });

  // A comment-triggered action: the task stays in its start status, the
  // agent never moves it, and every new user comment re-triggers a run.
  const commentsActions = (): AgentActionsConfig => ({
    defaultModel: "",
    defaultTimeout: null,
    actions: [
      {
        project: "",
        statusStart: "Plan",
        statusEnd: null,
        trigger: "comments",
        model: "",
        instruction: "",
        timeout: null,
        weight: null,
      },
    ],
  });

  describe("comment-triggered actions", () => {
    it("should process a fresh task with zero comments without changing its status", async () => {
      mockPlannerTasks([
        {
          id: "task-1",
          title: "Discuss the plan",
          status: "Plan",
          description: "Design the conversational flow",
          comments: [],
          attachments: [],
        },
      ]);
      mockQoder.performTask.mockResolvedValue("Agent analysis");

      const agent = createAgent(commentsActions());
      agent.start();
      await waitFor(() =>
        mockPlanner.addTaskComment.mock.calls.some(
          (call) => call[1] === "Agent analysis",
        ),
      );

      expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
      // The summary comment is posted but the task never moves.
      expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
      // The task never reaches an end status, so its folder is kept.
      await expect(
        fse.pathExists(path.join(dataDir, "tasks", "task-1-Agent.md")),
      ).resolves.toBe(true);
      agent.stop();
    });

    it("should not pick up a task whose last comment is the agent's own reply", async () => {
      config.TASK_POLLING_INTERVAL = 1;
      const task = {
        id: "task-1",
        title: "Discuss the plan",
        status: "Plan",
        description: "Design the conversational flow",
        comments: [] as unknown[],
        attachments: [] as unknown[],
      };
      mockPlannerTasks([task]);
      mockQoder.performTask.mockResolvedValue("Agent analysis");

      const agent = createAgent(commentsActions());
      agent.start();
      await waitFor(() => mockQoder.performTask.mock.calls.length === 1);
      await waitFor(() =>
        mockPlanner.addTaskComment.mock.calls.some(
          (call) => call[1] === "Agent analysis",
        ),
      );

      // The agent's start and summary comments are now on the task: the
      // conversation waits for the user and the next poll picks nothing.
      task.comments = [
        {
          id: "c-start",
          userId: "user-1",
          userName: "Test User",
          text: "Agent started working on this task",
          dateCreated: "2026-10-19T12:00:00.000Z",
        },
        {
          id: "c-summary",
          userId: "user-1",
          userName: "Test User",
          text: "Agent analysis",
          dateCreated: "2026-10-19T12:01:00.000Z",
        },
      ];
      await waitFor(() => mockPlanner.getCurrentUser.mock.calls.length >= 2);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockQoder.performTask).toHaveBeenCalledTimes(1);

      // A user reply after the agent's summary re-triggers a run.
      task.comments = [
        ...task.comments,
        {
          id: "c-user",
          userId: "user-2",
          userName: "Alice",
          text: "Please also cover the failure path",
          dateCreated: "2026-10-19T12:02:00.000Z",
        },
      ];
      await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
      expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
      agent.stop();
    });

    it("should post only the failure comment when a comment-triggered task fails", async () => {
      mockPlannerTasks([
        {
          id: "task-1",
          title: "Discuss the plan",
          status: "Plan",
          description: "Design the conversational flow",
          comments: [],
          attachments: [],
        },
      ]);
      fse.outputFileSync(
        path.join(dataDir, "tasks", "task-1-Agent-Summary.md"),
        "## Partial progress",
      );
      mockQoder.performTask.mockRejectedValue(new Error("CLI failed"));

      const agent = createAgent(commentsActions());
      agent.start();
      await waitFor(() =>
        mockPlanner.addTaskComment.mock.calls.some((call) =>
          String(call[1]).includes("Task processing failed:"),
        ),
      );

      const failureComment = mockPlanner.addTaskComment.mock.calls
        .map((call) => call[1] as string)
        .find((text) => text.includes("Task processing failed:"));
      expect(failureComment).toContain("Partial summary written before the failure:");
      expect(failureComment).toContain(
        "The task keeps its status: post a new comment on the task to trigger a new run.",
      );
      expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
      agent.stop();
    });

    it("should keep the abort semantics of a comment-triggered task", async () => {
      config.TASK_POLLING_INTERVAL = 1;
      const tasks = [
        {
          id: "task-1",
          title: "Discuss the plan",
          status: "Plan",
          description: "Design the conversational flow",
          comments: [] as unknown[],
          attachments: [] as unknown[],
        },
      ];
      mockPlanner.listAssignedTasks.mockImplementation(async () =>
        tasks.map((task) => ({ ...task })),
      );
      mockQoder.performTask.mockImplementation(
        (_task: unknown, _notesFile: string, options?: TaskOptions) =>
          new Promise<string>((_resolve, reject) => {
            options?.abortSignal?.addEventListener(
              "abort",
              () => reject(new CliAbortedError("Qoder task execution aborted")),
              { once: true },
            );
          }),
      );

      const actions = commentsActions();
      actions.defaultStatusAbort = "Aborted";
      const agent = createAgent(actions);
      agent.start();
      await waitFor(() => mockQoder.performTask.mock.calls.length === 1);

      // The user cancels the task by moving it to the abort status.
      tasks[0].status = "Aborted";
      await waitFor(
        () =>
          mockPlanner.addTaskComment.mock.calls.some((call) =>
            String(call[1]).includes("Task aborted at user request"),
          ),
        10000,
      );
      expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
      agent.stop();
    });

    it("should bound the adjustment rounds of a comment-triggered run by TASK_ADJUSTMENT_MAX_ROUNDS", async () => {
      config.TASK_ADJUSTMENT_MAX_ROUNDS = 2;
      mockPlannerTasks([
        {
          id: "task-1",
          title: "Discuss the plan",
          status: "Plan",
          description: "Design the conversational flow",
          comments: [],
          attachments: [],
        },
      ]);
      // A new human comment every time the task is re-fetched.
      let fetchRound = 0;
      mockPlanner.getTask.mockImplementation(async () => {
        fetchRound++;
        return {
          id: "task-1",
          projectId: "",
          title: "Discuss the plan",
          status: "Plan",
          priority: "medium",
          description: "Design the conversational flow",
          dateUpdated: `2026-10-19T0${fetchRound}:00:00.000Z`,
          comments: [
            {
              id: `comment-during-${fetchRound}`,
              userId: "user-2",
              userName: "Alice",
              text: `Message ${fetchRound}`,
              dateCreated: `2026-10-19T0${fetchRound}:00:00.000Z`,
            },
          ],
          attachments: [],
          dependencies: [],
        };
      });
      mockQoder.performTask.mockImplementation(async () => {
        return `Summary after call ${mockQoder.performTask.mock.calls.length}`;
      });

      const agent = createAgent(commentsActions());
      agent.start();
      await waitFor(() =>
        mockPlanner.addTaskComment.mock.calls.some(
          (call) => call[1] === "Summary after call 3",
        ),
      );

      expect(mockQoder.performTask).toHaveBeenCalledTimes(3);
      expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
      agent.stop();
    });

    it("should post the start comment on the first run of a comment-triggered task only", async () => {
      config.TASK_POLLING_INTERVAL = 1;
      config.AGENT_START_COMMENT = true;
      const task = {
        id: "task-1",
        title: "Discuss the plan",
        status: "Plan",
        description: "Design the conversational flow",
        comments: [] as unknown[],
        attachments: [] as unknown[],
      };
      mockPlannerTasks([task]);
      mockQoder.performTask.mockResolvedValue("Agent analysis");

      const agent = createAgent(commentsActions());
      agent.start();
      await waitFor(() => mockQoder.performTask.mock.calls.length === 1);
      await waitFor(() =>
        mockPlanner.addTaskComment.mock.calls.some(
          (call) => call[1] === "Agent analysis",
        ),
      );
      const startComments = () =>
        mockPlanner.addTaskComment.mock.calls.filter((call) =>
          String(call[1]).startsWith("Agent '"),
        );
      expect(startComments()).toHaveLength(1);

      // A user reply triggers a second run: no new start comment.
      task.comments = [
        {
          id: "c-agent",
          userId: "user-1",
          userName: "Test User",
          text: "Agent analysis",
          dateCreated: "2026-10-19T12:01:00.000Z",
        },
        {
          id: "c-user",
          userId: "user-2",
          userName: "Alice",
          text: "One more thing",
          dateCreated: "2026-10-19T12:02:00.000Z",
        },
      ];
      await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
      expect(startComments()).toHaveLength(1);
      agent.stop();
    });

    it("should keep the polls at the base interval when a comment-triggered action is configured", async () => {
      jest.useFakeTimers();
      config.TASK_POLLING_INTERVAL = 1;
      config.TASK_POLLING_MAX_INTERVAL = 8;
      const realSetTimeout = jest.requireActual("timers").setTimeout;
      const waitUntilPolled = async (expected: number): Promise<void> => {
        for (
          let i = 0;
          i < 200 && mockPlanner.getCurrentUser.mock.calls.length < expected;
          i++
        ) {
          await new Promise((resolve) => realSetTimeout(resolve, 5));
        }
        await new Promise((resolve) => realSetTimeout(resolve, 5));
        expect(mockPlanner.getCurrentUser).toHaveBeenCalledTimes(expected);
      };
      const agent = createAgent(commentsActions());
      agent.start();
      await waitUntilPolled(1); // poll 1: idle

      // Without a comment-triggered action the idle backoff would double
      // here: the comments mode caps the backoff at the base interval so a
      // user comment is answered within one base interval.
      await jest.advanceTimersByTimeAsync(1000);
      await waitUntilPolled(2);

      await jest.advanceTimersByTimeAsync(1000);
      await waitUntilPolled(3);
      agent.stop();
    });

    describe("comments pickup helpers", () => {
      const buildTask = (comments: {
        id?: string;
        userId: string;
        text?: string;
        dateCreated: string;
      }[]): PlannerTask =>
        ({
          id: "task-1",
          projectId: "p1",
          title: "Task",
          status: "Plan",
          priority: "medium",
          description: "",
          dateUpdated: "2026-10-19T00:00:00.000Z",
          comments: comments.map((comment, index) => ({
            id: comment.id ?? `c-${index}`,
            userId: comment.userId,
            userName: "Someone",
            text: comment.text ?? "hello",
            dateCreated: comment.dateCreated,
          })),
          attachments: [],
        }) as PlannerTask;

      const AGENT = "user-1";
      const USER = "user-2";

      it("lastCommentOf should return the greatest dateCreated with the later index winning ties", () => {
        expect(lastCommentOf(buildTask([]))).toBeNull();
        const earlier = {
          userId: USER,
          dateCreated: "2026-10-19T12:00:00.000Z",
        };
        const later = {
          userId: AGENT,
          dateCreated: "2026-10-19T12:05:00.000Z",
        };
        expect(lastCommentOf(buildTask([earlier, later]))?.userId).toBe(AGENT);
        // Equal timestamps: the later array index wins.
        const sameTime = (userId: string, id: string) => ({
          id,
          userId,
          dateCreated: "2026-10-19T12:00:00.000Z",
        });
        expect(
          lastCommentOf(buildTask([sameTime(AGENT, "a"), sameTime(USER, "b")]))
            ?.id,
        ).toBe("b");
      });

      it("commentsPickupPending should be true for zero comments or a non-agent last comment", () => {
        expect(commentsPickupPending(buildTask([]), AGENT)).toBe(true);
        expect(
          commentsPickupPending(
            buildTask([{ userId: AGENT, dateCreated: "2026-10-19T12:00:00.000Z" }]),
            AGENT,
          ),
        ).toBe(false);
        expect(
          commentsPickupPending(
            buildTask([
              { userId: AGENT, dateCreated: "2026-10-19T12:00:00.000Z" },
              { userId: USER, dateCreated: "2026-10-19T12:01:00.000Z" },
            ]),
            AGENT,
          ),
        ).toBe(true);
        expect(
          commentsPickupPending(
            buildTask([
              { userId: USER, dateCreated: "2026-10-19T12:00:00.000Z" },
              { userId: AGENT, dateCreated: "2026-10-19T12:01:00.000Z" },
            ]),
            AGENT,
          ),
        ).toBe(false);
      });

      it("commentsPickupPending should fail safe when the agent user is unknown", () => {
        expect(commentsPickupPending(buildTask([]), null)).toBe(false);
        expect(
          commentsPickupPending(
            buildTask([{ userId: USER, dateCreated: "2026-10-19T12:00:00.000Z" }]),
            null,
          ),
        ).toBe(false);
      });

      it("hasAgentComment should detect any agent-authored comment", () => {
        expect(hasAgentComment(buildTask([]), AGENT)).toBe(false);
        expect(
          hasAgentComment(
            buildTask([{ userId: USER, dateCreated: "2026-10-19T12:00:00.000Z" }]),
            AGENT,
          ),
        ).toBe(false);
        expect(
          hasAgentComment(
            buildTask([{ userId: AGENT, dateCreated: "2026-10-19T12:00:00.000Z" }]),
            AGENT,
          ),
        ).toBe(true);
        expect(hasAgentComment(buildTask([]), null)).toBe(false);
      });
    });

    describe("label helpers", () => {
      it("normalizeLabelValue should produce lowercase kebab-case values", () => {
        expect(normalizeLabelValue("DeepSeek-Flash")).toBe("deepseek-flash");
        expect(normalizeLabelValue("Qwen3.8 Flash")).toBe("qwen3.8-flash");
        expect(normalizeLabelValue("  GPT 6 Luna ")).toBe("gpt-6-luna");
        expect(normalizeLabelValue("--auto--")).toBe("auto");
        expect(normalizeLabelValue("")).toBe("");
      });

      it("buildTaskLabel should apply the prefix, truncate and skip empty values", () => {
        expect(buildTaskLabel("model:", "Qwen3.8-Flash")).toBe(
          "model:qwen3.8-flash",
        );
        expect(buildTaskLabel("", "qoder")).toBeNull();
        expect(buildTaskLabel("agent:", "")).toBeNull();
        expect(buildTaskLabel("x".repeat(100), "model")).toHaveLength(100);
      });

      it("mergeLabels should preserve the existing labels, dedupe and append", () => {
        expect(
          mergeLabels(["urgent", "urgent"], ["agent:running", "urgent"]),
        ).toEqual(["urgent", "agent:running"]);
        expect(mergeLabels([], [])).toEqual([]);
      });
    });
  });
});
