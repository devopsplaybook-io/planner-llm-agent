import * as os from "os";
import * as path from "path";
import * as fse from "fs-extra";
import {
  Agent,
  appendProcessedCommentsMarker,
  buildTaskLabel,
  commentsPickupPending,
  hasAgentComment,
  hasMatchingSummaryComment,
  isCanonicalTaskId,
  lastCommentOf,
  mergeLabels,
  normalizeLabelValue,
  parseProcessedCommentsMarker,
} from "./Agent";
import { AgentActionsConfig } from "./AgentActions";
import { Config } from "./Config";
import { FinalizationStore } from "./FinalizationStore";
import { CliAbortedError } from "./CliUtils";
import { createCliAgent } from "./clients/CliAgentRegistry";
import type { CliAgentClient, TaskOptions } from "./clients/CliAgent";
import {
  AttachmentTooLargeError,
  PlannerClient,
  PlannerRequestError,
  PlannerTask,
  PlannerTaskAttachment,
} from "./PlannerClient";

jest.mock("./PlannerClient", () => {
  class PlannerRequestError extends Error {
    public readonly status: number;

    constructor(message: string, status: number) {
      super(message);
      this.name = "PlannerRequestError";
      this.status = status;
    }
  }
  class AttachmentTooLargeError extends Error {
    public readonly limit: number;
    public readonly size: number | null;

    constructor(limit: number, size: number | null = null) {
      super(`Attachment exceeds the maximum size of ${limit} bytes`);
      this.name = "AttachmentTooLargeError";
      this.limit = limit;
      this.size = size;
    }
  }
  return { PlannerClient: jest.fn(), PlannerRequestError, AttachmentTooLargeError };
});

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
  mutateTaskLabels: jest.fn(),
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

// The agent only accepts canonical UUID task ids (they feed filesystem
// paths), so every fixture uses a deterministic one.
const TASK_1 = "11111111-1111-4111-8111-111111111111";
const TASK_2 = "22222222-2222-4222-8222-222222222222";
const TASK_3 = "33333333-3333-4333-8333-333333333333";
const TASK_OLDEST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_NEWEST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TASK_LOW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TASK_STALE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TASK_UNKNOWN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TASK_MIDDLE = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const TASK_MEDIUM = "a0000000-0000-4000-8000-000000000001";
const TASK_HIGH = "a0000000-0000-4000-8000-000000000002";
const TASK_GAMMA_HIGH = "a0000000-0000-4000-8000-000000000003";
const TASK_DELTA_MEDIUM = "a0000000-0000-4000-8000-000000000004";
const TASK_BETA_HIGH = "a0000000-0000-4000-8000-000000000005";
const TASK_B = "a0000000-0000-4000-8000-000000000006";
const TASK_ALPHA_LOW = "a0000000-0000-4000-8000-000000000007";
const TASK_A = "a0000000-0000-4000-8000-000000000008";
const TASK_C = "a0000000-0000-4000-8000-000000000009";
const TASK_ALREADY_CLEAR = "a0000000-0000-4000-8000-00000000000a";

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

// A Planner task fixture for the direct brief (writeTaskNotes) tests.
function notesTask(attachments: PlannerTaskAttachment[]): PlannerTask {
  return {
    id: TASK_1,
    projectId: "project-1",
    title: "Implement feature",
    status: "To Do",
    priority: "medium",
    description: "Add a feature",
    dateUpdated: "2026-09-02T00:00:00.000Z",
    comments: [],
    attachments,
  };
}

function attachmentFixture(
  overrides: Partial<PlannerTaskAttachment> = {},
): PlannerTaskAttachment {
  return {
    id: "attachment-1",
    fileName: "screenshot.png",
    filePath: "/uploads/screenshot.png",
    dateCreated: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

// The private helpers exercised directly: the path builders must reject
// non-canonical ids and the brief writer exposes the attachment manifest.
type NotesWriter = {
  writeTaskNotes(
    task: PlannerTask,
    notesFile: string,
    project: null,
  ): Promise<void>;
  getTaskDir(taskId: string): string;
  getTaskNotesFile(taskId: string): string;
  getTaskSummaryFile(taskId: string): string;
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
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  // otel-utils 1.9 mirrors a log record on the console stream of its level:
  // info on stdout, warn and error on their own. Tests that only care about
  // the message look it up across the three streams.
  const consoleLines = (): string[] =>
    [logSpy, warnSpy, errorSpy].flatMap((spy) =>
      spy.mock.calls.map((call: unknown[]) => String(call[0])),
    );

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

  // Stateful label store for the label tests: mutateTaskLabels applies the
  // add/remove sets and records the writes that actually changed the list;
  // updateTaskLabels persists the legacy whole-list fallback replacements.
  const mockTaskLabels = (task: Record<string, unknown>): string[][] => {
    const writes: string[][] = [];
    if (!Array.isArray(task.labels)) {
      task.labels = [];
    }
    const currentLabels = () => [...(task.labels as string[])];
    const persist = (labels: string[]): boolean => {
      const current = currentLabels();
      if (
        labels.length === current.length &&
        labels.every((label, index) => label === current[index])
      ) {
        return false;
      }
      writes.push([...labels]);
      task.labels = [...labels];
      return true;
    };
    mockPlanner.listAssignedTasks.mockImplementation(async () => [{ ...task }]);
    mockPlanner.getTask.mockImplementation(async () => ({
      ...task,
      labels: currentLabels(),
    }));
    mockPlanner.mutateTaskLabels.mockImplementation(
      async (
        _taskId: string,
        mutation: { add?: string[]; remove?: string[] },
      ) => {
        const removed = new Set(mutation.remove ?? []);
        const labels = mergeLabels(
          currentLabels().filter((label) => !removed.has(label)),
          mutation.add ?? [],
        );
        const changed = persist(labels);
        return { labels, changed };
      },
    );
    mockPlanner.updateTaskLabels.mockImplementation(
      async (_taskId: string, labels: string[]) => {
        persist([...labels]);
      },
    );
    return writes;
  };

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(jest.fn());
    warnSpy = jest.spyOn(console, "warn").mockImplementation(jest.fn());
    errorSpy = jest.spyOn(console, "error").mockImplementation(jest.fn());
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
      mockPlanner.mutateTaskLabels,
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
    mockPlanner.mutateTaskLabels.mockResolvedValue({
      labels: [],
      changed: false,
    });
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
        id: TASK_1,
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
      expect.objectContaining({ id: TASK_1 }),
      expect.any(String),
      expect.objectContaining({ cwd: expect.any(String) }),
    );
    expect(mockQoder.performTask).not.toHaveBeenCalled();
    agent.stop();
  });

  it("should prepare a CLI agent introduced by an action loaded after startup", async () => {
    mockPlannerTasks([
      {
        id: TASK_1,
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
        id: TASK_1,
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
        id: TASK_1,
        title: "Fix the build",
        status: "In Progress",
        description: "",
        comments: [],
        attachments: [],
      },
      {
        id: TASK_2,
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
        id: TASK_1,
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
      {
        id: TASK_2,
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
      expect.objectContaining({ id: TASK_1 }),
      path.join(dataDir, "tasks", `${TASK_1}-Agent.md`),
      expect.objectContaining({ model: "", instruction: "" }),
    );
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      TASK_1,
      "Feature implemented",
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_1, "Done");
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
                id: TASK_1,
                title: "Blocked work",
                status: "To Do",
                description: "Add a feature",
                comments: [],
                attachments: [],
                dependencies: [
                  { taskId: TASK_2, title: "First step", status: "In Progress" },
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
                id: TASK_1,
                title: "Blocked work",
                status: "To Do",
                description: "Add a feature",
                comments: [],
                attachments: [],
                dependencies: [{ taskId: TASK_2 }],
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
        id: TASK_1,
        title: "Unblocked work",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
        dependencies: [
          { taskId: TASK_2, title: "First step", status: "Done" },
        ],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_1 }),
      path.join(dataDir, "tasks", `${TASK_1}-Agent.md`),
      expect.objectContaining({ model: "", instruction: "" }),
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_1, "Done");
    agent.stop();
  });

  it("should render the dependencies in the task notes file", async () => {
    config.TASK_STATUS_CLEANUP = "Archived";
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: TASK_1,
        title: "Follow-up work",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
        dependencies: [
          { taskId: TASK_2, title: "First step", status: "Done" },
          { taskId: TASK_3, status: "Done" },
        ],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    const notesFile = path.join(dataDir, "tasks", `${TASK_1}-Agent.md`);
    expect(await fse.pathExists(notesFile)).toBe(true);
    const content = await fse.readFile(notesFile, "utf8");
    expect(content).toContain("## Dependencies");
    expect(content).toContain(`- First step (${TASK_2}) — status: Done`);
    expect(content).toContain(`- ${TASK_3} (${TASK_3}) — status: Done`);
    agent.stop();
  });

  it("should write the task notes file with description and comments", async () => {
    config.TASK_STATUS_CLEANUP = "Archived";
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: TASK_1,
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

    const notesFile = path.join(dataDir, "tasks", `${TASK_1}-Agent.md`);
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
    const notesFile = path.join(dataDir, "tasks", `${TASK_1}-Agent.md`);
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
        id: TASK_1,
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

  it("should preserve the Agent Notes when a comment quotes the marker", async () => {
    config.TASK_STATUS_CLEANUP = "Archived";
    const notesFile = path.join(dataDir, "tasks", `${TASK_1}-Agent.md`);
    const quotedMarkerComment = `Please use this marker: ${AGENT_NOTES_MARKER}`;
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
        "## Comments",
        "",
        `- **Alice** (2026-09-02T00:00:00.000Z): ${quotedMarkerComment}`,
        "",
        "## Attachments",
        "",
        "*(none)*",
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
        id: TASK_1,
        title: "Implement feature",
        status: "To Do",
        description: "New description",
        comments: [
          {
            id: "comment-1",
            userId: "user-2",
            userName: "Alice",
            text: quotedMarkerComment,
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

    const content = await fse.readFile(notesFile, "utf8");
    // The quoted marker must not be used as the split point: the brief is
    // regenerated once and the preserved notes are not duplicated.
    expect(content.match(/## Attachments/g)).toHaveLength(1);
    expect(content.match(/## Agent Notes/g)).toHaveLength(1);
    expect(content.match(/Previous findings from the last run/g)).toHaveLength(
      1,
    );
    expect(content.split(AGENT_NOTES_MARKER).length - 1).toBe(2);
    // The preserved notes stay after the final marker section.
    expect(content.indexOf("## Agent Notes")).toBeGreaterThan(
      content.lastIndexOf(AGENT_NOTES_MARKER),
    );
    agent.stop();
  });

  it("should move a failing task to the end status with an explanation", async () => {
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: TASK_1,
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

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        `Failed to process task 'Implement feature' (${TASK_1})`,
      ),
    );
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      TASK_1,
      expect.stringContaining("Task processing failed:"),
    );
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      TASK_1,
      expect.stringContaining("boom"),
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_1, "Done");
    agent.stop();
  });

  it("should move a failing task to the action error status when configured", async () => {
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: TASK_1,
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
      TASK_1,
      "Blocked",
    );
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      TASK_1,
      expect.stringContaining("The task was moved to 'Blocked'"),
    );
    agent.stop();
  });

  it("should re-run a failing task with the action fallback model", async () => {
    mockPlannerTasks([
      {
        id: TASK_1,
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask
      .mockRejectedValueOnce(
        new Error("Qoder task execution failed:\nlimit reached"),
      )
      .mockResolvedValueOnce("Recovered with the fallback model");

    const actions: AgentActionsConfig = {
      defaultModel: "",
      defaultTimeout: null,
      actions: [
        {
          project: "",
          statusStart: "To Do",
          statusEnd: "Done",
          trigger: "status",
          model: "DeepSeek-Flash",
          fallbackModel: "GLM-5.3-Flash",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    };
    const agent = createAgent(actions);
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledTimes(2);
    expect(mockQoder.performTask).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: TASK_1 }),
      expect.any(String),
      expect.objectContaining({ model: "DeepSeek-Flash" }),
    );
    expect(mockQoder.performTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: TASK_1 }),
      expect.any(String),
      expect.objectContaining({ model: "GLM-5.3-Flash" }),
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_1, "Done");
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      TASK_1,
      expect.stringContaining("Recovered with the fallback model"),
    );
    agent.stop();
  });

  it("should re-run a failing task with the default fallback agent and model", async () => {
    mockPlannerTasks([
      {
        id: TASK_1,
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockRejectedValueOnce(new Error("primary boom"));
    mockCopilot.performTask.mockResolvedValue("Recovered with Copilot");

    const actions: AgentActionsConfig = {
      defaultAgent: "qoder",
      defaultModel: "DeepSeek-Flash",
      defaultFallbackAgent: "copilot-cli",
      defaultFallbackModel: "gpt-6-luna",
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

    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(mockCopilot.performTask).toHaveBeenCalledTimes(1);
    expect(mockCopilot.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_1 }),
      expect.any(String),
      expect.objectContaining({ model: "gpt-6-luna" }),
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_1, "Done");
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      TASK_1,
      expect.stringContaining("Recovered with Copilot"),
    );
    agent.stop();
  });

  it("should record the fallback provenance labels", async () => {
    const task = {
      id: TASK_1,
      title: "Implement feature",
      status: "To Do",
      description: "Add a feature",
      comments: [],
      attachments: [],
    };
    const writes = mockTaskLabels(task);
    mockQoder.performTask
      .mockRejectedValueOnce(new Error("primary boom"))
      .mockResolvedValueOnce("Recovered with the fallback model");

    const actions: AgentActionsConfig = {
      defaultModel: "",
      defaultTimeout: null,
      actions: [
        {
          project: "",
          statusStart: "To Do",
          statusEnd: "Done",
          trigger: "status",
          model: "DeepSeek-Flash",
          fallbackModel: "GLM-5.3-Flash",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    };
    const agent = createAgent(actions);
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    const added = writes.flatMap((labels) => labels);
    expect(added).toContain("model:deepseek-flash");
    expect(added).toContain("model:glm-5.3-flash");
    agent.stop();
  });

  it("should report both errors when the fallback run also fails", async () => {
    mockPlannerTasks([
      {
        id: TASK_1,
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockRejectedValue(new Error("Qoder CLI exploded"));

    const actions: AgentActionsConfig = {
      defaultModel: "",
      defaultTimeout: null,
      actions: [
        {
          project: "",
          statusStart: "To Do",
          statusEnd: "Done",
          trigger: "status",
          model: "DeepSeek-Flash",
          fallbackModel: "GLM-5.3-Flash",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    };
    const agent = createAgent(actions);
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledTimes(2);
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_1, "Done");
    const failureComment = mockPlanner.addTaskComment.mock.calls
      .map((call) => call[1] as string)
      .find((text) => text.includes("Task processing failed:"));
    expect(failureComment).toContain(
      "failed on the primary agent 'qoder' (model 'DeepSeek-Flash')",
    );
    expect(failureComment).toContain(
      "the fallback agent 'qoder' (model 'GLM-5.3-Flash')",
    );
    expect(failureComment).toContain("Fallback error:");
    expect(failureComment).toContain("Primary error:");
    agent.stop();
  });

  it("should not run the fallback when the primary run is aborted by the user", async () => {
    mockPlannerTasks([
      {
        id: TASK_1,
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockRejectedValue(new CliAbortedError());

    const actions: AgentActionsConfig = {
      defaultModel: "",
      defaultTimeout: null,
      actions: [
        {
          project: "",
          statusStart: "To Do",
          statusEnd: "Done",
          trigger: "status",
          model: "DeepSeek-Flash",
          fallbackModel: "GLM-5.3-Flash",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    };
    const agent = createAgent(actions);
    agent.start();
    await waitFor(() =>
      mockPlanner.addTaskComment.mock.calls.some((call) =>
        String(call[1]).includes("Task aborted at user request"),
      ),
    );

    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
    agent.stop();
  });

  it("should not run a fallback identical to the primary pair", async () => {
    mockPlannerTasks([
      {
        id: TASK_1,
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockRejectedValue(new Error("Qoder CLI exploded"));

    const actions: AgentActionsConfig = {
      defaultModel: "",
      defaultTimeout: null,
      actions: [
        {
          project: "",
          statusStart: "To Do",
          statusEnd: "Done",
          trigger: "status",
          model: "DeepSeek-Flash",
          fallbackAgent: "qoder",
          fallbackModel: "DeepSeek-Flash",
          instruction: "",
          timeout: null,
          weight: null,
        },
      ],
    };
    const agent = createAgent(actions);
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    agent.stop();
  });

  it("should move a failing task to the default error status when the action has none", async () => {
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: TASK_1,
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
      TASK_1,
      "Review",
    );
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      TASK_1,
      expect.stringContaining("The task was moved to 'Review'"),
    );
    agent.stop();
  });

  it("should truncate a long failure explanation", async () => {
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: TASK_1,
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
        id: TASK_1,
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
      consoleLines().some((line) =>
        line.includes(
          `Failed to move task 'Implement feature' (${TASK_1}) to status 'Done'`,
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
        id: TASK_1,
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
        id: TASK_1,
        title: "First task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
      {
        id: TASK_2,
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
      expect.objectContaining({ id: TASK_1 }),
      expect.any(String),
      expect.anything(),
    );

    // Once it completes, the second task is picked on the next poll.
    resolveFirst("First task done");
    await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length === 2);
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_2, "Done");
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
        id: TASK_1,
        title: "First task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
      {
        id: TASK_2,
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
        id: TASK_1,
        title: "First task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
      {
        id: TASK_2,
        title: "Second task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
      {
        id: TASK_3,
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
      expect.objectContaining({ id: TASK_1 }),
      expect.any(String),
      expect.anything(),
    );
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_2 }),
      expect.any(String),
      expect.anything(),
    );

    // Once a slot frees up, the third task is picked on the next poll.
    resolvers[0]("First done");
    resolvers[1]("Second done");
    await waitFor(() => mockQoder.performTask.mock.calls.length === 3);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_3 }),
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
    expect(console.error).toHaveBeenCalledWith(
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
        id: TASK_1,
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
      TASK_1,
      "attachment-1",
    );
    const notesFile = path.join(dataDir, "tasks", `${TASK_1}-Agent.md`);
    const content = await fse.readFile(notesFile, "utf8");
    expect(content).toContain("## Attachments");
    expect(content).toContain("screenshot.png");
    const attachmentFile = path.join(
      dataDir,
      "tasks",
      TASK_1,
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
        id: TASK_1,
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
    const attachmentsDir = path.join(dataDir, "tasks", TASK_1, "attachments");
    expect((await fse.readdir(attachmentsDir)).sort()).toEqual([
      "attachments.json",
      "notes.txt",
    ]);
    const tasksDir = path.join(dataDir, "tasks");
    const taskDirEntries = await fse.readdir(tasksDir);
    expect(taskDirEntries).toContain(TASK_1);
    expect(taskDirEntries).not.toContain("escaped.txt");
    expect(taskDirEntries).not.toContain("deep");

    // The notes file lists the safe attachment and marks the unsafe ones.
    const content = await fse.readFile(
      path.join(dataDir, "tasks", `${TASK_1}-Agent.md`),
      "utf8",
    );
    expect(content).toContain("notes.txt");
    expect(content).toContain("(unsafe file name, skipped)");
    agent.stop();
  });

  it("should skip tasks with a non-canonical id and keep processing the other tasks", async () => {
    config.TASK_POLLING_INTERVAL = 0.05;
    mockPlannerTasks([
      {
        id: "../../escape",
        title: "Escape attempt",
        status: "To Do",
        description: "Write outside the data directory",
        comments: [],
        attachments: [],
      },
      {
        id: TASK_1,
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
    // The invalid entry does not break the polling loop.
    await waitFor(() => mockPlanner.listAssignedTasks.mock.calls.length >= 2);

    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledTimes(1);
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_1, "Done");
    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Skipping task 'Escape attempt' with an invalid id '../../escape'",
      ),
    );
    // No file or folder was created for the invalid id, inside or outside
    // the tasks directory.
    const tasksDir = path.join(dataDir, "tasks");
    const entries = (await fse.pathExists(tasksDir))
      ? await fse.readdir(tasksDir)
      : [];
    expect(entries.some((entry) => entry.includes("escape"))).toBe(false);
    expect(
      await fse.pathExists(path.join(dataDir, "..", "escape-Agent.md")),
    ).toBe(false);
    expect(await fse.pathExists(path.join(dataDir, "..", "escape"))).toBe(
      false,
    );
    agent.stop();
  });

  it("should only build task paths from canonical UUIDs", () => {
    const agent = createAgent();
    const writer = agent as unknown as NotesWriter;

    expect(isCanonicalTaskId(TASK_1)).toBe(true);
    expect(isCanonicalTaskId(TASK_OLDEST.toUpperCase())).toBe(true);
    expect(isCanonicalTaskId("task-1")).toBe(false);
    expect(writer.getTaskDir(TASK_OLDEST.toUpperCase())).toBe(
      path.join(dataDir, "tasks", TASK_OLDEST),
    );
    expect(writer.getTaskNotesFile(TASK_OLDEST)).toBe(
      path.join(dataDir, "tasks", `${TASK_OLDEST}-Agent.md`),
    );
    for (const invalidId of ["../../etc", "/etc/passwd", "task-1", ""]) {
      expect(() => writer.getTaskDir(invalidId)).toThrow(
        `Invalid task id '${invalidId}'`,
      );
      expect(() => writer.getTaskNotesFile(invalidId)).toThrow(
        `Invalid task id '${invalidId}'`,
      );
      expect(() => writer.getTaskSummaryFile(invalidId)).toThrow(
        `Invalid task id '${invalidId}'`,
      );
    }
  });

  it("should skip an oversized attachment and still process the task", async () => {
    config.TASK_STATUS_CLEANUP = "Archived";
    mockPlannerTasks([
      {
        id: TASK_1,
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [attachmentFixture()],
      },
    ]);
    mockPlanner.downloadTaskAttachment.mockRejectedValue(
      new AttachmentTooLargeError(1024, 2048),
    );
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    const attachmentFile = path.join(
      dataDir,
      "tasks",
      TASK_1,
      "attachments",
      "screenshot.png",
    );
    expect(await fse.pathExists(attachmentFile)).toBe(false);
    const content = await fse.readFile(
      path.join(dataDir, "tasks", `${TASK_1}-Agent.md`),
      "utf8",
    );
    expect(content).toContain(
      "screenshot.png (skipped: exceeds the maximum attachment size)",
    );
    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    agent.stop();
  });

  it("should reuse an attachment recorded in the manifest on the next brief", async () => {
    const agent = createAgent();
    const writer = agent as unknown as NotesWriter;
    const task = notesTask([attachmentFixture()]);
    const notesFile = writer.getTaskNotesFile(task.id);
    mockPlanner.downloadTaskAttachment.mockResolvedValue(Buffer.from("v1"));

    await writer.writeTaskNotes(task, notesFile, null);
    await writer.writeTaskNotes(task, notesFile, null);

    expect(mockPlanner.downloadTaskAttachment).toHaveBeenCalledTimes(1);
    const attachmentsDir = path.join(dataDir, "tasks", TASK_1, "attachments");
    const manifest = await fse.readJson(
      path.join(attachmentsDir, "attachments.json"),
    );
    expect(manifest).toEqual({
      version: 1,
      attachments: [
        {
          id: "attachment-1",
          dateCreated: "2026-09-02T00:00:00.000Z",
          fileName: "screenshot.png",
        },
      ],
    });
    const content = await fse.readFile(notesFile, "utf8");
    expect(content).toContain(
      `screenshot.png (${path.join(attachmentsDir, "screenshot.png")})`,
    );
  });

  it("should re-download an attachment whose dateCreated changed", async () => {
    const agent = createAgent();
    const writer = agent as unknown as NotesWriter;
    const notesFile = writer.getTaskNotesFile(TASK_1);
    mockPlanner.downloadTaskAttachment.mockResolvedValue(Buffer.from("v1"));
    await writer.writeTaskNotes(
      notesTask([attachmentFixture()]),
      notesFile,
      null,
    );

    mockPlanner.downloadTaskAttachment.mockResolvedValue(Buffer.from("v2"));
    await writer.writeTaskNotes(
      notesTask([
        attachmentFixture({ dateCreated: "2026-09-03T00:00:00.000Z" }),
      ]),
      notesFile,
      null,
    );

    expect(mockPlanner.downloadTaskAttachment).toHaveBeenCalledTimes(2);
    const attachmentFile = path.join(
      dataDir,
      "tasks",
      TASK_1,
      "attachments",
      "screenshot.png",
    );
    expect(await fse.readFile(attachmentFile)).toEqual(Buffer.from("v2"));
  });

  it("should drop the local copy of an attachment removed from the task", async () => {
    const agent = createAgent();
    const writer = agent as unknown as NotesWriter;
    const notesFile = writer.getTaskNotesFile(TASK_1);
    const attachmentsDir = path.join(dataDir, "tasks", TASK_1, "attachments");
    mockPlanner.downloadTaskAttachment.mockResolvedValue(
      Buffer.from("old image"),
    );
    await writer.writeTaskNotes(
      notesTask([attachmentFixture()]),
      notesFile,
      null,
    );
    expect(
      await fse.pathExists(path.join(attachmentsDir, "screenshot.png")),
    ).toBe(true);

    mockPlanner.downloadTaskAttachment.mockResolvedValue(
      Buffer.from("new image"),
    );
    await writer.writeTaskNotes(
      notesTask([
        attachmentFixture({ id: "attachment-2", fileName: "new.png" }),
      ]),
      notesFile,
      null,
    );

    expect(
      await fse.pathExists(path.join(attachmentsDir, "screenshot.png")),
    ).toBe(false);
    expect(await fse.pathExists(path.join(attachmentsDir, "new.png"))).toBe(
      true,
    );
    const manifest = await fse.readJson(
      path.join(attachmentsDir, "attachments.json"),
    );
    expect(
      manifest.attachments.map((entry: { id: string }) => entry.id),
    ).toEqual(["attachment-2"]);
  });

  it("should prune the attachments folder when the task loses its attachments", async () => {
    const agent = createAgent();
    const writer = agent as unknown as NotesWriter;
    const notesFile = writer.getTaskNotesFile(TASK_1);
    const attachmentsDir = path.join(dataDir, "tasks", TASK_1, "attachments");
    mockPlanner.downloadTaskAttachment.mockResolvedValue(Buffer.from("data"));
    await writer.writeTaskNotes(
      notesTask([attachmentFixture()]),
      notesFile,
      null,
    );

    await writer.writeTaskNotes(notesTask([]), notesFile, null);

    expect(
      await fse.pathExists(path.join(attachmentsDir, "screenshot.png")),
    ).toBe(false);
    const manifest = await fse.readJson(
      path.join(attachmentsDir, "attachments.json"),
    );
    expect(manifest.attachments).toEqual([]);
  });

  it("should rebuild an unreadable attachment manifest", async () => {
    const agent = createAgent();
    const writer = agent as unknown as NotesWriter;
    const attachmentsDir = path.join(dataDir, "tasks", TASK_1, "attachments");
    await fse.ensureDir(attachmentsDir);
    await fse.writeFile(
      path.join(attachmentsDir, "attachments.json"),
      "{not json",
    );
    mockPlanner.downloadTaskAttachment.mockResolvedValue(Buffer.from("data"));

    await writer.writeTaskNotes(
      notesTask([attachmentFixture()]),
      writer.getTaskNotesFile(TASK_1),
      null,
    );

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring the unreadable attachment manifest"),
    );
    const manifest = await fse.readJson(
      path.join(attachmentsDir, "attachments.json"),
    );
    expect(manifest.attachments).toHaveLength(1);
  });

  it("should keep the attachment manifest valid under concurrent briefs", async () => {
    const agent = createAgent();
    const writer = agent as unknown as NotesWriter;
    const notesFile = writer.getTaskNotesFile(TASK_1);
    mockPlanner.downloadTaskAttachment.mockImplementation(async () =>
      Buffer.from("data"),
    );

    await Promise.all([
      writer.writeTaskNotes(notesTask([attachmentFixture()]), notesFile, null),
      writer.writeTaskNotes(notesTask([attachmentFixture()]), notesFile, null),
    ]);

    const manifest = await fse.readJson(
      path.join(dataDir, "tasks", TASK_1, "attachments", "attachments.json"),
    );
    expect(manifest.attachments).toHaveLength(1);
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
        id: TASK_1,
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
          (call) => call[0] === TASK_1 && call[1] === "Done",
        ),
      5000,
    );

    // The CLI ran exactly once although the first finalization failed: only
    // the Planner updates were retried.
    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(summaryCommentAttempts).toBe(2);
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_1, "Done");
  });

  it("should not post the summary comment twice when only the status update fails", async () => {
    config.TASK_POLLING_INTERVAL = 0.05;
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: TASK_1,
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
          (call) => call[0] === TASK_1 && call[1] === "Done",
        ).length >= 2,
      5000,
    );

    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    const summaryComments = mockPlanner.addTaskComment.mock.calls.filter(
      (call) => call[1] === "All done",
    );
    expect(summaryComments).toHaveLength(1);
  });

  it("should resume a pending finalization after a restart without re-running the CLI", async () => {
    config.TASK_POLLING_INTERVAL = 0.05;
    const finalizationDir = path.join(dataDir, "finalization");
    const task = {
      id: TASK_1,
      title: "Implement feature",
      status: "To Do",
      description: "Add a feature",
      comments: [] as unknown[],
      attachments: [] as unknown[],
    };
    mockPlannerTasks([task]);
    mockQoder.performTask.mockResolvedValue("Should not run");

    // The previous process crashed between the CLI completion and the
    // Planner updates: the record was persisted but never delivered.
    const crashed = new FinalizationStore({ dir: finalizationDir });
    await crashed.record(TASK_1, {
      title: "Implement feature",
      contentVersion: "2026-10-15T01:00:00.000Z",
      summary: "All done",
      statusEnd: "Done",
      runStartedAt: Date.now() - 120_000,
    });

    const store = new FinalizationStore({ dir: finalizationDir });
    expect(await store.load()).toEqual({ loaded: 1, skipped: [] });

    const agent = createAgent(WILDCARD_ACTIONS, store);
    agent.start();
    await waitFor(
      () =>
        !store.has(TASK_1) &&
        mockPlanner.updateTaskStatus.mock.calls.some(
          (call) => call[0] === TASK_1 && call[1] === "Done",
        ),
      5000,
    );

    // The CLI was never re-executed: only the pending finalization ran.
    expect(mockQoder.performTask).not.toHaveBeenCalled();
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(TASK_1, "All done");
    expect(
      await fse.pathExists(path.join(finalizationDir, `${TASK_1}.json`)),
    ).toBe(false);
    agent.stop();
  });

  it("should not post the summary twice when the comment POST was applied but its response was lost", async () => {
    config.TASK_POLLING_INTERVAL = 0.05;
    const task = {
      id: TASK_1,
      title: "Implement feature",
      status: "To Do",
      description: "Add a feature",
      comments: [] as unknown[],
      attachments: [] as unknown[],
    };
    mockPlannerTasks([task]);
    mockQoder.performTask.mockResolvedValue("All done");
    let summaryAttempts = 0;
    mockPlanner.addTaskComment.mockImplementation(
      async (_id: string, text: string) => {
        if (text !== "All done") {
          return;
        }
        summaryAttempts++;
        // The server applied the comment and the response was lost.
        task.comments = [
          ...task.comments,
          {
            id: "comment-summary",
            userId: "user-1",
            userName: "Test User",
            text,
            dateCreated: new Date().toISOString(),
          },
        ];
        throw new Error("Response lost");
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
          (call) => call[0] === TASK_1 && call[1] === "Done",
        ),
      5000,
    );

    // The retry found the identical agent comment and did not post again.
    expect(summaryAttempts).toBe(1);
    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("the summary comment is already present"),
    );
    agent.stop();
  });

  it("should drop the finalization record when the task is no longer visible on retry", async () => {
    config.TASK_POLLING_INTERVAL = 0.05;
    const task = {
      id: TASK_1,
      title: "Implement feature",
      status: "To Do",
      description: "Add a feature",
      comments: [] as unknown[],
      attachments: [] as unknown[],
    };
    mockPlannerTasks([task]);
    mockQoder.performTask.mockResolvedValue("All done");
    // The summary POST fails on the first attempt (nothing applied).
    let summaryAttempts = 0;
    mockPlanner.addTaskComment.mockImplementation(
      async (_id: string, text: string) => {
        if (text === "All done") {
          summaryAttempts++;
          if (summaryAttempts === 1) {
            throw new Error("Planner is down");
          }
        }
      },
    );
    // The first getTask (post-run adjustment check) succeeds; the retry's
    // duplicate check finds the task deleted/unassigned.
    let getTaskCalls = 0;
    mockPlanner.getTask.mockImplementation(async () => {
      getTaskCalls++;
      if (getTaskCalls === 1) {
        return {
          id: TASK_1,
          projectId: "",
          title: "Implement feature",
          status: "To Do",
          priority: "medium",
          description: "Add a feature",
          dateUpdated: "2026-10-15T01:00:00.000Z",
          comments: [],
          attachments: [],
          dependencies: [],
        };
      }
      // The task left the assigned list meanwhile.
      task.status = "Done";
      throw new PlannerRequestError(
        `Planner request to '/api/tasks/${TASK_1}' failed with status 404`,
        404,
      );
    });

    const store = new FinalizationStore({ retryBaseMs: 10 });
    const agent = createAgent(WILDCARD_ACTIONS, store);
    agent.start();
    await waitFor(
      () => !store.has(TASK_1) && getTaskCalls >= 2,
      5000,
    );

    // The record is dropped instead of retried for 24h: no status update,
    // no crash.
    expect(summaryAttempts).toBe(1);
    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("no longer visible on Planner"),
    );
    agent.stop();
  });

  it("should process only the tasks matching the action project and start status", async () => {
    mockPlanner.listProjects.mockResolvedValue([
      { id: "p1", name: "Web", description: "" },
      { id: "p2", name: "Backend", description: "" },
    ]);
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: TASK_1,
        projectId: "p1",
        title: "Fix the build",
        status: "To Do",
        description: "The build is broken",
        comments: [],
        attachments: [],
      },
      {
        id: TASK_2,
        projectId: "p2",
        title: "Other project task",
        status: "To Do",
        description: "Not for this action",
        comments: [],
        attachments: [],
      },
      {
        id: TASK_3,
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
      expect.objectContaining({ id: TASK_1 }),
      expect.any(String),
      expect.anything(),
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(
      TASK_1,
      "In Review",
    );
    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalledWith(
      TASK_2,
      expect.anything(),
    );
    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalledWith(
      TASK_3,
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
        id: TASK_1,
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
        id: TASK_1,
        projectId: "p1",
        title: "Fix the build",
        status: "To Do",
        description: "The build is broken",
        comments: [],
        attachments: [],
      },
      {
        id: TASK_2,
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
      expect.objectContaining({ id: TASK_1 }),
      expect.any(String),
      expect.anything(),
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(
      TASK_1,
      "In Review",
    );
    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalledWith(
      TASK_2,
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
        id: TASK_1,
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
        id: TASK_1,
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
        id: TASK_1,
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
        id: TASK_1,
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
        id: TASK_1,
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
      TASK_1,
      "Agent 'test-agent' started working on this task.",
    );

    resolveTask("Feature implemented");
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      TASK_1,
      "Feature implemented",
    );
    agent.stop();
  });

  it("should not fail the task when the start notification fails", async () => {
    config.AGENT_START_COMMENT = true;
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: TASK_1,
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
      TASK_1,
      "Feature implemented",
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_1, "Done");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        `Failed to post the start notification for task 'Implement feature' (${TASK_1})`,
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
        id: TASK_1,
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
        id: TASK_1,
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
        id: TASK_1,
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
        id: TASK_1,
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
        id: TASK_LOW,
        title: "Low priority task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
        priority: "low",
      },
      {
        id: TASK_HIGH,
        title: "High priority task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
        priority: "high",
      },
      {
        id: TASK_MEDIUM,
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
      expect.objectContaining({ id: TASK_HIGH }),
      expect.any(String),
      expect.anything(),
    );

    resolvers[0]("High done");
    await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_MEDIUM }),
      expect.any(String),
      expect.anything(),
    );

    resolvers[1]("Medium done");
    await waitFor(() => mockQoder.performTask.mock.calls.length === 3);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_LOW }),
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
        id: TASK_NEWEST,
        title: "Newest task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
        priority: "high",
        dateUpdated: "2026-09-10T00:00:00.000Z",
      },
      {
        id: TASK_OLDEST,
        title: "Oldest task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
        priority: "high",
        dateUpdated: "2026-09-01T00:00:00.000Z",
      },
      {
        id: TASK_MIDDLE,
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
      expect.objectContaining({ id: TASK_OLDEST }),
      expect.any(String),
      expect.anything(),
    );

    resolvers[0]("Oldest done");
    await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_MIDDLE }),
      expect.any(String),
      expect.anything(),
    );

    resolvers[1]("Middle done");
    await waitFor(() => mockQoder.performTask.mock.calls.length === 3);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_NEWEST }),
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
        id: TASK_LOW,
        title: "Low priority task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
        priority: "low",
      },
      {
        id: TASK_UNKNOWN,
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
      expect.objectContaining({ id: TASK_UNKNOWN }),
      expect.any(String),
      expect.anything(),
    );

    resolvers[0]("Unknown done");
    await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_LOW }),
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
        id: TASK_ALPHA_LOW,
        projectId: "p1",
        title: "Low priority task of a high-priority action",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
        priority: "low",
      },
      {
        id: TASK_BETA_HIGH,
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
      expect.objectContaining({ id: TASK_ALPHA_LOW }),
      expect.any(String),
      expect.anything(),
    );

    resolvers[0]("Alpha done");
    await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_BETA_HIGH }),
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
        id: TASK_GAMMA_HIGH,
        projectId: "p1",
        title: "High priority task of a low-priority action",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
        priority: "high",
      },
      {
        id: TASK_DELTA_MEDIUM,
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
      expect.objectContaining({ id: TASK_DELTA_MEDIUM }),
      expect.any(String),
      expect.anything(),
    );

    resolvers[0]("Delta done");
    await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_GAMMA_HIGH }),
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
        id: TASK_NEWEST,
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
        id: TASK_OLDEST,
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
      expect.objectContaining({ id: TASK_OLDEST }),
      expect.any(String),
      expect.anything(),
    );

    resolvers[0]("Oldest done");
    await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_NEWEST }),
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
        id: TASK_1,
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
      path.join(dataDir, "tasks", `${TASK_1}-Agent.md`),
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
        id: TASK_1,
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
      path.join(dataDir, "tasks", `${TASK_1}-Agent.md`),
      "utf8",
    );
    expect(content).toContain("- **Project**: Web");
    expect(content).not.toContain("## Project");
    agent.stop();
  });

  it("should not process any task without an actions configuration", async () => {
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: TASK_1,
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
        id: TASK_1,
        title: "Implement feature",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
      {
        id: TASK_2,
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
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_1, "Done");

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
      TASK_2,
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
        id: TASK_A,
        title: "Heavy task",
        status: "To Do",
        description: "agent-weight: 1\nDo the heavy work",
        comments: [],
        attachments: [],
      },
      {
        id: TASK_B,
        title: "Small task",
        status: "To Do",
        description: "agent-weight: 0.5\nDo a small fix",
        comments: [],
        attachments: [],
      },
      {
        id: TASK_C,
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
      expect.objectContaining({ id: TASK_A }),
      expect.any(String),
      expect.anything(),
    );
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_B }),
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
        id: `a1000000-0000-4000-8000-00000000000${n}`,
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
        id: TASK_1,
        projectId: "p1",
        title: "Web migration",
        status: "To Do",
        description:
          "Migrate the web app\nagent-lock: repo:acme/web\nSee https://github.com/acme/web",
        comments: [],
        attachments: [],
      },
      {
        id: TASK_2,
        projectId: "p1",
        title: "Web follow-up",
        status: "To Do",
        description: "Touch the same https://github.com/acme/web repository",
        comments: [],
        attachments: [],
      },
      {
        id: TASK_3,
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
      expect.objectContaining({ id: TASK_1 }),
      expect.any(String),
      expect.anything(),
    );
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_3 }),
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
    resolveTask(TASK_3, "API fix done");
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(mockQoder.performTask).toHaveBeenCalledTimes(2);

    // Round 3: the migration completes and releases the lock; the follow-up
    // is finally picked.
    resolveTask(TASK_1, "Web migration done");
    await waitFor(
      () => mockQoder.performTask.mock.calls.length === 3,
      5000,
    );
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_2 }),
      expect.any(String),
      expect.anything(),
    );
    resolveTask(TASK_2, "Web follow-up done");
    agent.stop();
  });

  it("should evaluate hint-less tasks with the utility model and serialize them by repository", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    config.TASK_MAX_PARALLEL = 2;
    config.AGENT_UTILITY_MODEL = "utility-model";
    mockPlannerTasks([
      {
        id: TASK_1,
        title: "Refactor the service",
        status: "To Do",
        description: "Refactor the billing service",
        comments: [],
        attachments: [],
      },
      {
        id: TASK_2,
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
        id: TASK_1,
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
        id: TASK_1,
        title: "Locked task",
        status: "To Do",
        description: "agent-lock: repo:acme/web\nFirst work",
        comments: [],
        attachments: [],
      },
      {
        id: TASK_2,
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
      expect.objectContaining({ id: TASK_1 }),
      expect.any(String),
      expect.anything(),
    );
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_2 }),
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
        id: TASK_1,
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

    const taskDir = path.join(dataDir, "tasks", TASK_1);
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
        id: TASK_1,
        title: "Small task",
        status: "To Do",
        description: "agent-weight: 0.5\nSmall work",
        comments: [],
        attachments: [],
      },
      {
        id: TASK_2,
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
        id: TASK_1,
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
        id: TASK_1,
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
    // Label writes are atomic (no read-merge-write): the only re-read is the
    // new-comment check after the run.
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(mockPlanner.getTask).toHaveBeenCalledTimes(1);
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      TASK_1,
      "Feature implemented",
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledTimes(1);
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_1, "Done");
    agent.stop();
  });

  it("should re-run the CLI with the new comments before finalizing when a human comments during the run", async () => {
    config.TASK_STATUS_CLEANUP = "Archived";
    const notesFile = path.join(dataDir, "tasks", `${TASK_1}-Agent.md`);
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
        id: TASK_1,
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
      id: TASK_1,
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
      TASK_1,
      "Adjusted summary",
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledTimes(1);
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_1, "Done");
    agent.stop();
  });

  it("should not count the agent's own comments as new messages", async () => {
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: TASK_1,
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    // The agent's start comment (its own Planner user) is the only new one.
    mockPlanner.getTask.mockResolvedValue({
      id: TASK_1,
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
      TASK_1,
      "Feature implemented",
    );
    agent.stop();
  });

  it("should finalize the task as-is when the new-comment check fails", async () => {
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: TASK_1,
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    mockPlanner.getTask.mockRejectedValue(
      new Error(
        `Planner request to '/api/tasks/${TASK_1}' failed with status 500`,
      ),
    );
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      TASK_1,
      "Feature implemented",
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_1, "Done");
    expect(
      consoleLines().some((line) =>
        line.includes(
          `Failed to check task 'Implement feature' (${TASK_1}) for new comments`,
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
        id: TASK_1,
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
        id: TASK_1,
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
    // Two adjustment checks plus the bounded final check; the label writes
    // are atomic and re-read nothing. The end status confirms the processing
    // fully completed.
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledTimes(3);
    expect(mockPlanner.getTask).toHaveBeenCalledTimes(3);
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      TASK_1,
      "Summary after call 3",
    );
    expect(
      consoleLines().some((line) =>
        line.includes("adjustment budget of 2 round(s)"),
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
        id: TASK_1,
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    mockPlanner.getTask.mockResolvedValue({
      id: TASK_1,
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
    // Label writes are atomic (no read-merge-write): the only re-read is the
    // detection-only new-comment check after the run.
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(mockPlanner.getTask).toHaveBeenCalledTimes(1);
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      TASK_1,
      "Feature implemented",
    );
    expect(
      consoleLines().some((line) =>
        line.includes("adjustment budget of 0 round(s)"),
      ),
    ).toBe(true);
    agent.stop();
  });

  it("should finalize with the last successful summary when an adjustment run fails", async () => {
    mockPlannerTasks([
      {
        id: TASK_1,
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    mockPlanner.getTask.mockResolvedValue({
      id: TASK_1,
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

    // The failed adjustment never discards the completed first run: its
    // summary is posted with a note, and the task reaches its end status.
    expect(mockQoder.performTask).toHaveBeenCalledTimes(2);
    const comments = mockPlanner.addTaskComment.mock.calls
      .filter((call) => call[0] === TASK_1)
      .map((call) => String(call[1]));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("First run summary");
    expect(comments[0]).toContain("an adjustment round failed");
    expect(
      comments.some((text) => text.includes("Task processing failed:")),
    ).toBe(false);
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_1, "Done");
    agent.stop();
  });

  it("should finalize with the last successful summary when an adjustment run times out", async () => {
    mockPlannerTasks([
      {
        id: TASK_1,
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    mockPlanner.getTask.mockResolvedValue({
      id: TASK_1,
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
      .mockRejectedValueOnce(
        new Error("Qoder task execution timed out after 60 seconds"),
      );

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledTimes(2);
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      TASK_1,
      expect.stringContaining("First run summary"),
    );
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      TASK_1,
      expect.stringContaining("an adjustment round failed"),
    );
    expect(
      consoleLines().some((line) =>
        line.includes("adjustment round 1/2 failed"),
      ),
    ).toBe(true);
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_1, "Done");
    agent.stop();
  });

  it("should take the failure path when the initial run fails and never adjust", async () => {
    config.TASK_ADJUSTMENT_MAX_ROUNDS = 2;
    mockPlannerTasks([
      {
        id: TASK_1,
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    mockQoder.performTask.mockRejectedValue(new Error("CLI exploded"));

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    // Only the initial run failed: the generic error path applies, and no
    // adjustment check is ever attempted.
    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(mockPlanner.getTask).not.toHaveBeenCalled();
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      TASK_1,
      expect.stringContaining("Task processing failed:"),
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_1, "Done");
    agent.stop();
  });

  it("should still abort when an adjustment run is aborted", async () => {
    mockPlannerTasks([
      {
        id: TASK_1,
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    mockPlanner.getTask.mockResolvedValue({
      id: TASK_1,
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
      .mockRejectedValueOnce(
        new CliAbortedError("Qoder task execution aborted"),
      );
    const actions: AgentActionsConfig = {
      defaultStatusAbort: "Aborted",
      defaultModel: "",
      defaultTimeout: null,
      actions: WILDCARD_ACTIONS.actions,
    };
    const store = new FinalizationStore({ retryBaseMs: 60000 });

    const agent = createAgent(actions, store);
    agent.start();
    await waitFor(
      () =>
        mockPlanner.addTaskComment.mock.calls.some((call) =>
          String(call[1]).includes("Task aborted at user request"),
        ),
      5000,
    );

    // The abort wins over the finalization: the abort comment is posted, the
    // first run summary is not, and no status move or record happens.
    expect(mockQoder.performTask).toHaveBeenCalledTimes(2);
    expect(mockPlanner.addTaskComment).toHaveBeenCalledTimes(1);
    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
    expect(store.has(TASK_1)).toBe(false);
    agent.stop();
  });

  it("should record the last summary and the fresh content version in the finalization store", async () => {
    const store = new FinalizationStore({ retryBaseMs: 60000 });
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: TASK_1,
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    mockPlanner.getTask.mockResolvedValue({
      id: TASK_1,
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
      () => store.has(TASK_1) && store.get(TASK_1)!.attempts >= 1,
      5000,
    );

    const record = store.get(TASK_1)!;
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
        id: TASK_1,
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
        id: TASK_1,
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
        id: TASK_1,
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

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "the status does not exist in project 'Web'",
      ),
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledTimes(1);
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_1, "Done");
    agent.stop();
  });

  it("should not fail the task when the in-progress transition fails", async () => {
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: TASK_1,
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

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `Failed to move task 'Implement feature' (${TASK_1}) to the in-progress status 'In Progress' (continuing)`,
      ),
    );
    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_1, "Done");
    agent.stop();
  });

  it("should mention the resolved model in the start notification", async () => {
    config.AGENT_NAME = "test-agent";
    config.AGENT_START_COMMENT = true;
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: TASK_1,
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
      TASK_1,
      "Agent 'test-agent' started working on this task (model task-model).",
    );
    agent.stop();
  });

  it("should post progress comments while a long task runs", async () => {
    config.TASK_PROGRESS_COMMENT_INTERVAL = 1;
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: TASK_1,
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
      TASK_1,
      "Feature implemented",
    );
    agent.stop();
  });

  it("should abort a running task when its status moves to the abort status", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    const store = new FinalizationStore({ retryBaseMs: 60000 });
    const tasks = [
      {
        id: TASK_1,
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
      TASK_1,
      expect.stringContaining("the task status was moved to 'Aborted' on Planner"),
    );
    // The user-set status is kept: no end status, no error status, no
    // finalization record (the CLI work is never re-run either way).
    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
    expect(store.has(TASK_1)).toBe(false);
    agent.stop();
  });

  it("should post the summary but keep the user abort status when the task is aborted during finalization", async () => {
    const task = {
      id: TASK_1,
      title: "Implement feature",
      status: "To Do",
      description: "Add a feature",
      comments: [] as unknown[],
      attachments: [] as unknown[],
    };
    mockPlanner.listAssignedTasks.mockImplementation(async () => [
      { ...task },
    ]);
    const store = new FinalizationStore({ retryBaseMs: 60000 });
    mockQoder.performTask.mockImplementation(async () => {
      // The CLI finished, and the user moved the task to the abort status
      // before the finalization could apply the end status.
      task.status = "Aborted";
      return "Feature implemented";
    });
    const actions: AgentActionsConfig = {
      defaultStatusAbort: "Aborted",
      defaultModel: "",
      defaultTimeout: null,
      actions: WILDCARD_ACTIONS.actions,
    };

    const agent = createAgent(actions, store);
    agent.start();
    await waitFor(() => !store.has(TASK_1) && mockPlanner.addTaskComment.mock.calls.length > 0);

    // The aborted work is still reported, but the user-set status is kept:
    // no end status and no folder cleanup.
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      TASK_1,
      "Feature implemented",
    );
    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
    await expect(
      fse.pathExists(path.join(dataDir, "tasks", `${TASK_1}-Agent.md`)),
    ).resolves.toBe(true);
    expect(store.has(TASK_1)).toBe(false);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("is in its abort status 'Aborted'"),
    );
    agent.stop();
  });

  it("should keep the abort status on a finalization retry", async () => {
    config.TASK_POLLING_INTERVAL = 0.05;
    const task = {
      id: TASK_1,
      title: "Implement feature",
      status: "To Do",
      description: "Add a feature",
      comments: [] as unknown[],
      attachments: [] as unknown[],
    };
    mockPlanner.listAssignedTasks.mockImplementation(async () => [
      { ...task },
    ]);
    mockQoder.performTask.mockResolvedValue("All done");
    // The summary comment POST fails on the first attempt only; the user
    // moves the task to the abort status meanwhile.
    let summaryCommentAttempts = 0;
    mockPlanner.addTaskComment.mockImplementation(
      async (_id: string, text: string) => {
        if (text === "All done") {
          summaryCommentAttempts++;
          if (summaryCommentAttempts === 1) {
            task.status = "Aborted";
            throw new Error("Planner is down");
          }
        }
      },
    );
    const actions: AgentActionsConfig = {
      defaultStatusAbort: "Aborted",
      defaultModel: "",
      defaultTimeout: null,
      actions: WILDCARD_ACTIONS.actions,
    };

    const store = new FinalizationStore({ retryBaseMs: 10 });
    const agent = createAgent(actions, store);
    agent.start();
    await waitFor(
      () => summaryCommentAttempts === 2 && !store.has(TASK_1),
      5000,
    );

    // The retry posts the summary but never applies the end status.
    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
    await expect(
      fse.pathExists(path.join(dataDir, "tasks", `${TASK_1}-Agent.md`)),
    ).resolves.toBe(true);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "finalized on retry; its status 'Aborted' was kept (user abort)",
      ),
    );
    agent.stop();
  });

  it("should schedule a retry when the abort-status re-fetch fails", async () => {
    const task = {
      id: TASK_1,
      title: "Implement feature",
      status: "To Do",
      description: "Add a feature",
      comments: [] as unknown[],
      attachments: [] as unknown[],
    };
    mockPlanner.listAssignedTasks.mockImplementation(async () => [
      { ...task },
    ]);
    mockQoder.performTask.mockResolvedValue("All done");
    let getTaskCalls = 0;
    mockPlanner.getTask.mockImplementation(async () => {
      getTaskCalls++;
      if (getTaskCalls === 1) {
        // The adjustment check succeeds and sees no new comment.
        return {
          ...task,
          projectId: "",
          priority: "medium",
          dateUpdated: "2026-10-15T01:00:00.000Z",
          comments: [],
          dependencies: [],
        };
      }
      // The finalization abort-status re-fetch fails.
      throw new Error("Planner is down");
    });
    const actions: AgentActionsConfig = {
      defaultStatusAbort: "Aborted",
      defaultModel: "",
      defaultTimeout: null,
      actions: WILDCARD_ACTIONS.actions,
    };
    const store = new FinalizationStore({ retryBaseMs: 60000 });

    const agent = createAgent(actions, store);
    agent.start();
    await waitFor(
      () => store.has(TASK_1) && store.get(TASK_1)!.attempts >= 1,
      5000,
    );

    // The failed re-fetch defers the decision to a retry: no status update
    // is attempted and the summary is not re-posted.
    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
    expect(store.get(TASK_1)?.commentPosted).toBe(true);
    await expect(
      fse.pathExists(path.join(dataDir, "tasks", `${TASK_1}-Agent.md`)),
    ).resolves.toBe(true);
    agent.stop();
  });

  it("should mark the task running and record the model, then clear the running label", async () => {
    const task = {
      id: TASK_1,
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
    // Atomic quiet mutations: add before the run, remove when it ends.
    expect(mockPlanner.mutateTaskLabels).toHaveBeenCalledWith(TASK_1, {
      add: ["agent:running", "model:qwen3.8-flash"],
      remove: [],
      quiet: true,
    });
    expect(mockPlanner.mutateTaskLabels).toHaveBeenCalledWith(TASK_1, {
      add: [],
      remove: ["agent:running"],
      quiet: true,
    });
    // No read-merge-write on the happy path: the only re-read is the
    // post-run new-comment check.
    expect(mockPlanner.getTask).toHaveBeenCalledTimes(1);
    // The legacy start comment is off by default: only the summary is posted.
    expect(mockPlanner.addTaskComment).toHaveBeenCalledTimes(1);
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      TASK_1,
      "Feature implemented",
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_1, "Done");
    agent.stop();
  });

  it("should record the CLI agent label when a prefix is configured", async () => {
    config.TASK_CLI_LABEL_PREFIX = "agent:";
    const task = {
      id: TASK_1,
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

  it("should remove the originally added running label after TASK_RUNNING_LABEL is hot-reloaded during a run", async () => {
    const task = {
      id: TASK_1,
      title: "Implement feature",
      status: "To Do",
      description: "Add a feature",
      comments: [],
      attachments: [],
    };
    const writes = mockTaskLabels(task);
    mockQoder.performTask.mockImplementation(async () => {
      config.TASK_RUNNING_LABEL = "agent:busy";
      return "Feature implemented";
    });

    const agent = createAgent();
    agent.start();
    await waitFor(() => writes.length === 2);

    // Only the label added at start is removed: the hot-reloaded value is
    // never removed from the task.
    expect(writes).toEqual([["agent:running"], []]);
    expect(mockPlanner.mutateTaskLabels).toHaveBeenCalledWith(TASK_1, {
      add: [],
      remove: ["agent:running"],
      quiet: true,
    });
    expect(mockPlanner.mutateTaskLabels).not.toHaveBeenCalledWith(TASK_1, {
      add: [],
      remove: ["agent:busy"],
      quiet: true,
    });
    agent.stop();
  });

  it("should still remove the running label when TASK_LABELS is disabled during the run", async () => {
    const task = {
      id: TASK_1,
      title: "Implement feature",
      status: "To Do",
      description: "Add a feature",
      comments: [],
      attachments: [],
    };
    const writes = mockTaskLabels(task);
    mockQoder.performTask.mockImplementation(async () => {
      config.TASK_LABELS = false;
      return "Feature implemented";
    });

    const agent = createAgent();
    agent.start();
    await waitFor(() => writes.length === 2);

    expect(writes).toEqual([["agent:running"], []]);
    agent.stop();
  });

  it("should skip a no-op label write when the running label is already set", async () => {
    const task = {
      id: TASK_1,
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

  it("should fall back to a whole-list label replace on a Planner without the PATCH endpoint", async () => {
    const task = {
      id: TASK_1,
      title: "Implement feature",
      status: "To Do",
      description: "Add a feature",
      comments: [],
      attachments: [],
      labels: ["urgent"],
    };
    const writes = mockTaskLabels(task);
    mockPlanner.mutateTaskLabels.mockRejectedValue(
      new PlannerRequestError(
        `Planner request to '/api/tasks/${TASK_1}/labels' failed with status 405`,
        405,
      ),
    );
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = createAgent();
    agent.start();
    await waitFor(() => writes.length === 2);

    // The legacy fallback reads the fresh task first and replaces the whole
    // list, preserving the human label.
    expect(writes).toEqual([["urgent", "agent:running"], ["urgent"]]);
    expect(mockPlanner.getTask).toHaveBeenCalled();
    expect(mockPlanner.updateTaskLabels).toHaveBeenCalledWith(TASK_1, [
      "urgent",
      "agent:running",
    ]);
    agent.stop();
  });

  it("should clear the running label when the task fails", async () => {
    const task = {
      id: TASK_1,
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
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_1, "Done");
    agent.stop();
  });

  it("should clear the running label when the task is aborted", async () => {
    config.TASK_POLLING_INTERVAL = 1;
    const tasks = [
      {
        id: TASK_1,
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
    mockPlanner.mutateTaskLabels.mockImplementation(
      async (
        _taskId: string,
        mutation: { add?: string[]; remove?: string[] },
      ) => {
        const removed = new Set(mutation.remove ?? []);
        const labels = mergeLabels(
          tasks[0].labels.filter((label) => !removed.has(label)),
          mutation.add ?? [],
        );
        writes.push([...labels]);
        tasks[0].labels = [...labels];
        return { labels, changed: true };
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
        id: TASK_1,
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    mockPlanner.mutateTaskLabels.mockRejectedValue(
      new Error("Planner is down"),
    );
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      TASK_1,
      "Feature implemented",
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(TASK_1, "Done");
    // An operational failure is not an unsupported endpoint: no fallback.
    expect(mockPlanner.updateTaskLabels).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `Failed to add the agent labels (agent:running) for task 'Implement feature' (${TASK_1})`,
      ),
    );
    agent.stop();
  });

  it("should not write labels when TASK_LABELS is false", async () => {
    config.TASK_LABELS = false;
    const task = {
      id: TASK_1,
      title: "Implement feature",
      status: "To Do",
      description: "Add a feature",
      comments: [],
      attachments: [],
      labels: ["urgent"],
    };
    const writes = mockTaskLabels(task);
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = createAgent();
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    // Disabled before the run: no add and no remove at all.
    expect(mockPlanner.mutateTaskLabels).not.toHaveBeenCalled();
    expect(mockPlanner.updateTaskLabels).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    agent.stop();
  });

  it("should reconcile the stale running labels after the startup delay", async () => {
    jest.useFakeTimers();
    const tasks = [
      {
        id: TASK_STALE,
        title: "Stale task",
        status: "Done",
        description: "",
        comments: [],
        attachments: [],
        labels: ["agent:running", "model:qwen3.8-flash"],
      },
      {
        id: TASK_ALREADY_CLEAR,
        title: "Already clear task",
        status: "Done",
        description: "",
        comments: [],
        attachments: [],
        labels: ["agent:running"],
      },
    ];
    mockPlanner.listAssignedTasks.mockImplementation(
      async (_user, _projectIds, labels?: string[]) =>
        labels ? tasks.map((task) => ({ ...task })) : [],
    );
    // The second task reports no change (labeled meanwhile by someone else).
    mockPlanner.mutateTaskLabels.mockImplementation(async (taskId: string) =>
      taskId === TASK_STALE
        ? { labels: ["model:qwen3.8-flash"], changed: true }
        : { labels: ["agent:running"], changed: false },
    );

    const agent = createAgent();
    agent.start();
    await jest.advanceTimersByTimeAsync(59999);
    expect(mockPlanner.mutateTaskLabels).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(mockPlanner.listAssignedTasks).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-1" }),
      undefined,
      ["agent:running"],
    );
    expect(mockPlanner.mutateTaskLabels).toHaveBeenCalledWith(TASK_STALE, {
      add: [],
      remove: ["agent:running"],
      quiet: true,
    });
    // Only the changed task counts as cleared.
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Running label reconciliation: cleared 'agent:running' on 1 of 2 task(s)",
      ),
    );
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
        id: TASK_1,
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
        attachments: [],
      },
    ]);
    fse.outputFileSync(
      path.join(dataDir, "tasks", `${TASK_1}-Agent-Summary.md`),
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
        id: TASK_1,
        projectId: "p1",
        title: "First task",
        status: "To Do",
        description: "",
        comments: [],
        attachments: [],
      },
      {
        id: TASK_2,
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

  describe("first matching action ownership", () => {
    // Two actions matching the same task: the first one must process it and
    // the second one must never run, whatever the scheduling path.
    const overlappingActions = (): AgentActionsConfig => ({
      defaultModel: "",
      defaultTimeout: null,
      actions: [
        {
          project: "Web",
          statusStart: "To Do",
          statusEnd: "Done",
          trigger: "status",
          model: "",
          instruction: "FIRST_INSTRUCTION",
          timeout: null,
          weight: null,
        },
        {
          project: "W*",
          statusStart: "To Do",
          statusEnd: "Done",
          trigger: "status",
          model: "",
          instruction: "SECOND_INSTRUCTION",
          timeout: null,
          weight: null,
        },
      ],
    });

    it("should process an overlapping task with the first matching pipeline action only", async () => {
      mockPlanner.listProjects.mockResolvedValue([
        { id: "p1", name: "Web", description: "" },
      ]);
      mockPlannerTasks([
        {
          id: TASK_1,
          projectId: "p1",
          title: "Fix the build",
          status: "To Do",
          description: "",
          comments: [],
          attachments: [],
        },
      ]);
      mockQoder.performTask.mockResolvedValue("Done");

      const agent = createAgent(overlappingActions());
      agent.start();
      await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

      expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
      expect(
        (mockQoder.performTask.mock.calls[0]![2] as { instruction: string })
          .instruction,
      ).toBe("FIRST_INSTRUCTION");
      expect(mockPlanner.updateTaskStatus).toHaveBeenCalledTimes(1);
      expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(
        TASK_1,
        "Done",
      );
      agent.stop();
    });

    it("should report a dependency-blocked task once when several actions match it", async () => {
      config.TASK_POLLING_INTERVAL = 1;
      mockPlanner.listProjects.mockResolvedValue([
        { id: "p1", name: "Web", description: "" },
      ]);
      mockPlanner.listAssignedTasks.mockResolvedValue([
        {
          id: TASK_1,
          projectId: "p1",
          title: "Blocked work",
          status: "To Do",
          description: "",
          comments: [],
          attachments: [],
          dependencies: [
            { taskId: TASK_2, title: "First step", status: "In Progress" },
          ],
        },
      ]);

      const agent = createAgent(overlappingActions());
      agent.start();
      await waitFor(() => mockPlanner.getCurrentUser.mock.calls.length >= 2);

      const rounds = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((text) => text.includes("Scheduling round:"));
      const deferralRound = rounds.find((text) =>
        text.includes("Blocked work"),
      );
      expect(deferralRound).toBeDefined();
      expect(deferralRound).toContain(
        `deferred: 'Blocked work' (dependency:${TASK_2})`,
      );
      // The claim is taken before the dependency gate: the task is reported
      // once, not once per matching action.
      expect(deferralRound!.match(/'Blocked work'/g)).toHaveLength(1);
      expect(mockQoder.performTask).not.toHaveBeenCalled();
      expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
      agent.stop();
    });
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
          id: TASK_1,
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
          (call) => String(call[1]).startsWith("Agent analysis"),
        ),
      );

      // The summary carries the processed-comments watermark of the brief:
      // "none" since the task had no comment at pick time.
      expect(
        mockPlanner.addTaskComment.mock.calls.map((call) => call[1]),
      ).toContain("Agent analysis\n\n<!-- agent:processed-comments=none -->");
      expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
      // The summary comment is posted but the task never moves.
      expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
      // The task never reaches an end status, so its folder is kept.
      await expect(
        fse.pathExists(path.join(dataDir, "tasks", `${TASK_1}-Agent.md`)),
      ).resolves.toBe(true);
      agent.stop();
    });

    it("should not pick up a task whose last comment is the agent's own reply", async () => {
      config.TASK_POLLING_INTERVAL = 1;
      const task = {
        id: TASK_1,
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
          (call) => String(call[1]).startsWith("Agent analysis"),
        ),
      );
      const postedSummary = mockPlanner.addTaskComment.mock.calls
        .map((call) => call[1] as string)
        .find((text) => text.startsWith("Agent analysis"))!;
      expect(postedSummary).toBe(
        "Agent analysis\n\n<!-- agent:processed-comments=none -->",
      );

      // The agent's start and summary comments are now on the task, the
      // summary with its watermark: the conversation waits for the user and
      // the next poll picks nothing.
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
          text: postedSummary,
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

    it("should keep a comment-triggered task owned by the first matching action when a broader pipeline action follows", async () => {
      config.TASK_POLLING_INTERVAL = 1;
      mockPlanner.listProjects.mockResolvedValue([
        {
          id: "p1",
          name: "Projects/Ideation",
          description: "",
          statuses: ["To Do", "Doing", "Done"],
        },
      ]);
      const task = {
        id: TASK_1,
        projectId: "p1",
        title: "Investigate the failure",
        status: "Doing",
        description: "Investigate the failure",
        comments: [] as unknown[],
        attachments: [] as unknown[],
      };
      mockPlannerTasks([task]);
      mockQoder.performTask.mockResolvedValue("Investigation summary");

      const agent = createAgent({
        defaultModel: "",
        defaultTimeout: null,
        actions: [
          {
            project: "Projects/Ideation*",
            statusStart: "Doing",
            statusEnd: null,
            trigger: "comments",
            model: "",
            instruction: "IDEATION_INSTRUCTION",
            timeout: null,
            weight: null,
          },
          {
            project: "Project*",
            statusStart: "Doing",
            statusEnd: "Review",
            trigger: "status",
            model: "",
            instruction: "IMPLEMENTATION_INSTRUCTION",
            timeout: null,
            weight: null,
          },
        ],
      });
      agent.start();
      // The zero-comment task is processed by the first (comments) action.
      await waitFor(() =>
        mockPlanner.addTaskComment.mock.calls.some(
          (call) => String(call[1]).startsWith("Investigation summary"),
        ),
      );
      const postedSummary = mockPlanner.addTaskComment.mock.calls
        .map((call) => call[1] as string)
        .find((text) => text.startsWith("Investigation summary"))!;
      expect(postedSummary).toBe(
        "Investigation summary\n\n<!-- agent:processed-comments=none -->",
      );
      expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
      expect(
        (mockQoder.performTask.mock.calls[0]![2] as { instruction: string })
          .instruction,
      ).toBe("IDEATION_INSTRUCTION");
      expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();

      // The agent summary is now the last comment: the conversation waits
      // for the user, and the later pipeline action must never pick the
      // task up (the first matching action owns it).
      const pollsBefore = mockPlanner.getCurrentUser.mock.calls.length;
      task.comments = [
        {
          id: "c-agent",
          userId: "user-1",
          userName: "Test User",
          text: postedSummary,
          dateCreated: "2026-10-20T00:52:57.000Z",
        },
      ];
      await waitFor(
        () => mockPlanner.getCurrentUser.mock.calls.length >= pollsBefore + 2,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
      expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();

      // A user reply re-triggers exactly one run, still by the comments
      // action, and the task still never moves.
      task.comments = [
        ...task.comments,
        {
          id: "c-user",
          userId: "user-2",
          userName: "Alice",
          text: "Also check the labels",
          dateCreated: "2026-10-20T01:00:00.000Z",
        },
      ];
      await waitFor(() => mockQoder.performTask.mock.calls.length === 2);
      expect(
        (mockQoder.performTask.mock.calls[1]![2] as { instruction: string })
          .instruction,
      ).toBe("IDEATION_INSTRUCTION");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mockQoder.performTask).toHaveBeenCalledTimes(2);
      expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
      agent.stop();
    });

    it("should let the first of two overlapping comments actions own a task waiting for the user", async () => {
      config.TASK_POLLING_INTERVAL = 1;
      mockPlanner.listProjects.mockResolvedValue([
        { id: "p1", name: "Weekly Plan", description: "" },
      ]);
      const task = {
        id: TASK_1,
        projectId: "p1",
        title: "Discuss the plan",
        status: "Plan",
        description: "Design the conversational flow",
        comments: [
          {
            id: "c-agent",
            userId: "user-1",
            userName: "Test User",
            text: "First analysis",
            dateCreated: "2026-10-19T12:01:00.000Z",
          },
        ] as unknown[],
        attachments: [] as unknown[],
      };
      mockPlannerTasks([task]);
      mockQoder.performTask.mockResolvedValue("Second analysis");

      const agent = createAgent({
        defaultModel: "",
        defaultTimeout: null,
        actions: [
          {
            project: "Weekly*",
            statusStart: "Plan",
            statusEnd: null,
            trigger: "comments",
            model: "",
            instruction: "FIRST_INSTRUCTION",
            timeout: null,
            weight: null,
          },
          {
            project: "*",
            statusStart: "Plan",
            statusEnd: null,
            trigger: "comments",
            model: "",
            instruction: "SECOND_INSTRUCTION",
            timeout: null,
            weight: null,
          },
        ],
      });
      agent.start();
      // The first action owns the task and its conversation waits for the
      // user: neither action runs.
      await waitFor(() => mockPlanner.getCurrentUser.mock.calls.length >= 2);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mockQoder.performTask).not.toHaveBeenCalled();

      // A user reply re-triggers exactly one run, by the first action.
      task.comments = [
        ...task.comments,
        {
          id: "c-user",
          userId: "user-2",
          userName: "Alice",
          text: "Please continue",
          dateCreated: "2026-10-19T12:02:00.000Z",
        },
      ];
      await waitFor(() => mockQoder.performTask.mock.calls.length === 1);
      expect(
        (mockQoder.performTask.mock.calls[0]![2] as { instruction: string })
          .instruction,
      ).toBe("FIRST_INSTRUCTION");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
      agent.stop();
    });

    it("should post only the failure comment when a comment-triggered task fails", async () => {
      mockPlannerTasks([
        {
          id: TASK_1,
          title: "Discuss the plan",
          status: "Plan",
          description: "Design the conversational flow",
          comments: [],
          attachments: [],
        },
      ]);
      fse.outputFileSync(
        path.join(dataDir, "tasks", `${TASK_1}-Agent-Summary.md`),
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
          id: TASK_1,
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
          id: TASK_1,
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
          id: TASK_1,
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
          (call) => String(call[1]).startsWith("Summary after call 3"),
        ),
      );

      expect(mockQoder.performTask).toHaveBeenCalledTimes(3);
      // The budget ran out on comment-during-3: the watermark records the
      // last comment an adjustment round actually consumed, so the pending
      // comment stays newer and re-triggers the task on a later poll.
      expect(
        mockPlanner.addTaskComment.mock.calls
          .map((call) => call[1] as string)
          .find((text) => text.startsWith("Summary after call 3")),
      ).toBe(
        "Summary after call 3\n\n<!-- agent:processed-comments=comment-during-2 -->",
      );
      expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
      agent.stop();
    });

    // Builds comment fixtures with increasing dates, in insertion order, so
    // the watermark comparisons follow the scenario timeline.
    const commentMaker = () => {
      let tick = 0;
      return (
        id: string,
        userId: string,
        text: string,
      ): Record<string, unknown> => ({
        id,
        userId,
        userName: userId === "user-1" ? "Test User" : "Alice",
        text,
        dateCreated: new Date(
          Date.parse("2026-10-19T12:00:00.000Z") + tick++ * 60000,
        ).toISOString(),
      });
    };

    const commentsTask = (comments: unknown[]) => ({
      id: TASK_1,
      title: "Discuss the plan",
      status: "Plan",
      description: "Design the conversational flow",
      comments,
      attachments: [] as unknown[],
    });

    it("should re-trigger a run for a comment posted before the summary", async () => {
      config.TASK_POLLING_INTERVAL = 1;
      const makeComment = commentMaker();
      const task = commentsTask([]);
      mockPlannerTasks([task]);
      const summaries: string[] = [];
      let injected = false;
      mockQoder.performTask
        .mockResolvedValueOnce("First analysis")
        .mockResolvedValue("Second analysis");
      mockPlanner.addTaskComment.mockImplementation(
        async (_taskId: string, text: string) => {
          if (!injected && text.startsWith("First analysis")) {
            injected = true;
            // The comment lands after the last new-comment check, before
            // the summary is stored.
            task.comments = [
              ...task.comments,
              makeComment("c-late", "user-2", "One more thing"),
            ];
          }
          summaries.push(text);
          task.comments = [
            ...task.comments,
            makeComment(`c-summary-${summaries.length}`, "user-1", text),
          ];
        },
      );

      const agent = createAgent(commentsActions());
      agent.start();
      await waitFor(() => summaries.length === 2, 10000);

      // The first brief had no comment: its watermark is "none", so the
      // late comment is not covered and re-triggers the task.
      expect(summaries[0]).toBe(
        "First analysis\n\n<!-- agent:processed-comments=none -->",
      );
      // The second brief covered the late comment and the first summary.
      expect(summaries[1]).toBe(
        "Second analysis\n\n<!-- agent:processed-comments=c-summary-1 -->",
      );
      // The summary never re-triggers itself: no third run.
      await waitFor(
        () => mockPlanner.getCurrentUser.mock.calls.length >= 4,
        5000,
      );
      expect(mockQoder.performTask).toHaveBeenCalledTimes(2);
      agent.stop();
    }, 20000);

    it("should keep the watermark behind a comment posted after the adjustment budget", async () => {
      config.TASK_POLLING_INTERVAL = 1;
      config.TASK_ADJUSTMENT_MAX_ROUNDS = 0;
      const makeComment = commentMaker();
      const task = commentsTask([
        makeComment("c-first", "user-2", "Initial message"),
      ]);
      mockPlannerTasks([task]);
      const summaries: string[] = [];
      let runCount = 0;
      mockQoder.performTask.mockImplementation(async () => {
        runCount++;
        if (runCount === 1) {
          // A second comment lands while the CLI runs, with no adjustment
          // budget left to consume it.
          task.comments = [
            ...task.comments,
            makeComment("c-second", "user-2", "Second message"),
          ];
        }
        return `Summary ${runCount}`;
      });
      mockPlanner.addTaskComment.mockImplementation(
        async (_taskId: string, text: string) => {
          summaries.push(text);
          task.comments = [
            ...task.comments,
            makeComment(`c-summary-${summaries.length}`, "user-1", text),
          ];
        },
      );

      const agent = createAgent(commentsActions());
      agent.start();
      await waitFor(() => summaries.length === 2, 10000);

      // The summary records the last consumed comment, not the pending one:
      // the next poll re-runs the task exactly once.
      expect(summaries[0]).toBe(
        "Summary 1\n\n<!-- agent:processed-comments=c-first -->",
      );
      expect(summaries[1]).toBe(
        "Summary 2\n\n<!-- agent:processed-comments=c-summary-1 -->",
      );
      await waitFor(
        () => mockPlanner.getCurrentUser.mock.calls.length >= 4,
        5000,
      );
      expect(mockQoder.performTask).toHaveBeenCalledTimes(2);
      agent.stop();
    }, 20000);

    it("should retry once automatically for a comment posted during a failed run", async () => {
      config.TASK_POLLING_INTERVAL = 1;
      const makeComment = commentMaker();
      const task = commentsTask([
        makeComment("c-first", "user-2", "Initial message"),
      ]);
      mockPlannerTasks([task]);
      const posted: string[] = [];
      let runCount = 0;
      mockQoder.performTask.mockImplementation(async () => {
        runCount++;
        if (runCount === 1) {
          task.comments = [
            ...task.comments,
            makeComment("c-second", "user-2", "Posted while failing"),
          ];
          throw new Error("CLI failed");
        }
        return "Retry summary";
      });
      mockPlanner.addTaskComment.mockImplementation(
        async (_taskId: string, text: string) => {
          posted.push(text);
          task.comments = [
            ...task.comments,
            makeComment(`c-posted-${posted.length}`, "user-1", text),
          ];
        },
      );

      const agent = createAgent(commentsActions());
      agent.start();
      await waitFor(() => runCount === 2 && posted.length >= 2, 10000);

      // The failure comment carries the pick-time watermark: the comment
      // posted during the failed run stays newer and triggers the retry.
      const failure = posted.find((text) =>
        text.includes("Task processing failed:"),
      );
      expect(failure).toBeDefined();
      expect(
        failure!.endsWith("<!-- agent:processed-comments=c-first -->"),
      ).toBe(true);
      // The retry summary covers the failure comment: no third run.
      await waitFor(
        () => mockPlanner.getCurrentUser.mock.calls.length >= 4,
        5000,
      );
      expect(mockQoder.performTask).toHaveBeenCalledTimes(2);
      agent.stop();
    }, 20000);

    it("should re-trigger a run for a comment posted during the finalization retry backoff", async () => {
      config.TASK_POLLING_INTERVAL = 1;
      const makeComment = commentMaker();
      const task = commentsTask([]);
      mockPlannerTasks([task]);
      const finalizationStore = new FinalizationStore({
        retryBaseMs: 20,
        retryMaxMs: 20,
      });
      const posted: string[] = [];
      let summaryPosts = 0;
      let runCount = 0;
      mockQoder.performTask.mockImplementation(async () => {
        runCount++;
        return runCount === 1 ? "First analysis" : "Second analysis";
      });
      mockPlanner.addTaskComment.mockImplementation(
        async (_taskId: string, text: string) => {
          summaryPosts++;
          if (summaryPosts === 1) {
            // The summary POST fails and a human comment lands during the
            // backoff, while the task is excluded from the candidates.
            task.comments = [
              ...task.comments,
              makeComment("c-backoff", "user-2", "During backoff"),
            ];
            throw new Error("Planner unavailable");
          }
          posted.push(text);
          task.comments = [
            ...task.comments,
            makeComment(`c-summary-${summaryPosts}`, "user-1", text),
          ];
        },
      );

      const agent = createAgent(commentsActions(), finalizationStore);
      agent.start();
      await waitFor(() => runCount === 2 && posted.length >= 2, 10000);

      // The retry re-posts the stored summary with its old watermark: the
      // backoff comment was not covered, so it re-triggers a run.
      expect(posted[0]).toBe(
        "First analysis\n\n<!-- agent:processed-comments=none -->",
      );
      expect(posted[1]).toBe(
        "Second analysis\n\n<!-- agent:processed-comments=c-summary-2 -->",
      );
      await waitFor(
        () => mockPlanner.getCurrentUser.mock.calls.length >= 5,
        5000,
      );
      expect(mockQoder.performTask).toHaveBeenCalledTimes(2);
      agent.stop();
    }, 20000);

    it("should pick up a comment after a restart from the summary watermark", async () => {
      config.TASK_POLLING_INTERVAL = 1;
      const makeComment = commentMaker();
      const task = commentsTask([]);
      mockPlannerTasks([task]);
      const summaries: string[] = [];
      mockQoder.performTask.mockResolvedValue("Agent analysis");
      mockPlanner.addTaskComment.mockImplementation(
        async (_taskId: string, text: string) => {
          summaries.push(text);
          task.comments = [
            ...task.comments,
            makeComment(`c-summary-${summaries.length}`, "user-1", text),
          ];
        },
      );

      const firstAgent = createAgent(commentsActions(), new FinalizationStore());
      firstAgent.start();
      await waitFor(() => summaries.length === 1, 10000);
      firstAgent.stop();

      // A fresh agent with no in-memory state: the watermark lives only in
      // the Planner summary comment.
      task.comments = [
        ...task.comments,
        makeComment("c-human-after-restart", "user-2", "After restart"),
      ];
      const secondAgent = createAgent(
        commentsActions(),
        new FinalizationStore(),
      );
      secondAgent.start();
      await waitFor(() => summaries.length === 2, 10000);

      expect(summaries[0]).toBe(
        "Agent analysis\n\n<!-- agent:processed-comments=none -->",
      );
      // The second brief's newest comment is the human one: covering it
      // leaves no pending comment, so the conversation waits for the user.
      expect(summaries[1]).toBe(
        "Agent analysis\n\n<!-- agent:processed-comments=c-human-after-restart -->",
      );
      secondAgent.stop();
    }, 20000);

    it("should finalize with the last successful summary when an adjustment run fails", async () => {
      mockPlannerTasks([
        {
          id: TASK_1,
          title: "Discuss the plan",
          status: "Plan",
          description: "Design the conversational flow",
          comments: [],
          attachments: [],
        },
      ]);
      mockPlanner.getTask.mockResolvedValue({
        id: TASK_1,
        projectId: "",
        title: "Discuss the plan",
        status: "Plan",
        priority: "medium",
        description: "Design the conversational flow",
        dateUpdated: "2026-10-19T01:00:00.000Z",
        comments: [
          {
            id: "comment-new",
            userId: "user-2",
            userName: "Alice",
            text: "One more thing",
            dateCreated: "2026-10-19T00:30:00.000Z",
          },
        ],
        attachments: [],
        dependencies: [],
      });
      mockQoder.performTask
        .mockResolvedValueOnce("Agent analysis")
        .mockRejectedValueOnce(new Error("Adjustment run failed"));

      const agent = createAgent(commentsActions());
      agent.start();
      await waitFor(
        () =>
          mockPlanner.addTaskComment.mock.calls.some((call) =>
            String(call[1]).includes("an adjustment round failed"),
          ),
        5000,
      );

      // Comments mode: the first summary is posted with the note and the
      // task keeps its status (no status move anyway).
      expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
        TASK_1,
        expect.stringContaining("Agent analysis"),
      );
      expect(
        mockPlanner.addTaskComment.mock.calls.some((call) =>
          String(call[1]).includes("Task processing failed:"),
        ),
      ).toBe(false);
      expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
      agent.stop();
    });

    it("should never re-fetch the task for a comment-only finalization", async () => {
      mockPlannerTasks([
        {
          id: TASK_1,
          title: "Discuss the plan",
          status: "Plan",
          description: "Design the conversational flow",
          comments: [],
          attachments: [],
        },
      ]);
      mockQoder.performTask.mockResolvedValue("Agent analysis");
      const actions = commentsActions();
      actions.defaultStatusAbort = "Aborted";

      const agent = createAgent(actions);
      agent.start();
      await waitFor(() =>
        mockPlanner.addTaskComment.mock.calls.some(
          (call) => String(call[1]).startsWith("Agent analysis"),
        ),
      );

      // Only the adjustment check re-reads the task: the comment-only
      // finalization never moves the status, so it needs no abort check.
      expect(mockPlanner.getTask).toHaveBeenCalledTimes(1);
      expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
      agent.stop();
    });

    it("should post the start comment on the first run of a comment-triggered task only", async () => {
      config.TASK_POLLING_INTERVAL = 1;
      config.AGENT_START_COMMENT = true;
      const task = {
        id: TASK_1,
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
          (call) => String(call[1]).startsWith("Agent analysis"),
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
          id: TASK_1,
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

      it("appendProcessedCommentsMarker should append the id or none, trimming trailing whitespace", () => {
        expect(appendProcessedCommentsMarker("Summary", "c-1")).toBe(
          "Summary\n\n<!-- agent:processed-comments=c-1 -->",
        );
        expect(appendProcessedCommentsMarker("Summary", null)).toBe(
          "Summary\n\n<!-- agent:processed-comments=none -->",
        );
        expect(appendProcessedCommentsMarker("Summary  \n\n", "c-1")).toBe(
          "Summary\n\n<!-- agent:processed-comments=c-1 -->",
        );
      });

      it("parseProcessedCommentsMarker should only read a trailing marker", () => {
        expect(
          parseProcessedCommentsMarker(
            "Summary\n\n<!-- agent:processed-comments=c-1 -->",
          ),
        ).toBe("c-1");
        expect(
          parseProcessedCommentsMarker(
            "Summary\n\n<!-- agent:processed-comments=none -->",
          ),
        ).toBe("none");
        expect(parseProcessedCommentsMarker("Summary")).toBeNull();
        expect(
          parseProcessedCommentsMarker(
            "<!-- agent:processed-comments=c-1 -->\nMore text",
          ),
        ).toBeNull();
        expect(
          parseProcessedCommentsMarker(
            "Summary\n\n<!-- agent:processed-comments=c-1 -->\n",
          ),
        ).toBe("c-1");
      });

      it("commentsPickupPending should compare the summary watermark with newer human comments", () => {
        const summary = (id: string, dateCreated: string) => ({
          id: `summary-${id}`,
          userId: AGENT,
          text: appendProcessedCommentsMarker("Summary", id),
          dateCreated,
        });
        // The watermark covers the newest human comment: no loop.
        expect(
          commentsPickupPending(
            buildTask([
              {
                id: "h1",
                userId: USER,
                dateCreated: "2026-10-19T12:00:00.000Z",
              },
              summary("h1", "2026-10-19T12:02:00.000Z"),
            ]),
            AGENT,
          ),
        ).toBe(false);
        // A human comment newer than the watermark: pending.
        expect(
          commentsPickupPending(
            buildTask([
              {
                id: "h1",
                userId: USER,
                dateCreated: "2026-10-19T12:00:00.000Z",
              },
              {
                id: "h2",
                userId: USER,
                dateCreated: "2026-10-19T12:01:00.000Z",
              },
              summary("h1", "2026-10-19T12:02:00.000Z"),
            ]),
            AGENT,
          ),
        ).toBe(true);
        // Equal timestamps: the human comment at a later array index wins.
        expect(
          commentsPickupPending(
            buildTask([
              {
                id: "h1",
                userId: USER,
                dateCreated: "2026-10-19T12:00:00.000Z",
              },
              {
                id: "h2",
                userId: USER,
                dateCreated: "2026-10-19T12:00:00.000Z",
              },
              summary("h1", "2026-10-19T12:02:00.000Z"),
            ]),
            AGENT,
          ),
        ).toBe(true);
        // The "none" watermark only waits for the first human comment.
        expect(
          commentsPickupPending(
            buildTask([summary("none", "2026-10-19T12:02:00.000Z")]),
            AGENT,
          ),
        ).toBe(false);
        expect(
          commentsPickupPending(
            buildTask([
              {
                id: "h1",
                userId: USER,
                dateCreated: "2026-10-19T12:00:00.000Z",
              },
              summary("none", "2026-10-19T12:02:00.000Z"),
            ]),
            AGENT,
          ),
        ).toBe(true);
        // A watermark comment that no longer exists fails closed (no loop).
        expect(
          commentsPickupPending(
            buildTask([
              {
                id: "h1",
                userId: USER,
                dateCreated: "2026-10-19T12:00:00.000Z",
              },
              summary("deleted", "2026-10-19T12:02:00.000Z"),
            ]),
            AGENT,
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

      it("hasMatchingSummaryComment should match the same text from the agent after the run start", () => {
        const comments = [
          {
            id: "c1",
            userId: AGENT,
            text: "All done",
            dateCreated: "2026-10-19T12:00:00.000Z",
          },
        ];
        const since = Date.parse("2026-10-19T11:59:00.000Z");
        expect(
          hasMatchingSummaryComment(comments, "All done", AGENT, since),
        ).toBe(true);
        // An older identical comment belongs to a previous run.
        expect(
          hasMatchingSummaryComment(
            comments,
            "All done",
            AGENT,
            Date.parse("2026-10-19T12:01:00.000Z"),
          ),
        ).toBe(false);
        // A different author or a different text never matches.
        expect(
          hasMatchingSummaryComment(comments, "All done", USER, since),
        ).toBe(false);
        expect(
          hasMatchingSummaryComment(comments, "Other summary", AGENT, since),
        ).toBe(false);
      });

      it("hasMatchingSummaryComment should count an unparseable date on a text and author match", () => {
        expect(
          hasMatchingSummaryComment(
            [
              {
                id: "c1",
                userId: AGENT,
                text: "All done",
                dateCreated: "not-a-date",
              },
            ],
            "All done",
            AGENT,
            Date.now(),
          ),
        ).toBe(true);
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
