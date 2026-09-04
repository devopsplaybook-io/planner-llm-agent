import * as os from "os";
import * as path from "path";
import * as fse from "fs-extra";
import { Agent } from "./Agent";
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
  addTaskComment: jest.fn(),
  updateTaskStatus: jest.fn(),
};
const mockQoder = {
  checkAuthentication: jest.fn(),
  performTask: jest.fn(),
};

const AGENT_NOTES_MARKER =
  "<!-- AGENT-NOTES: the content below is maintained by the Qoder agent. Do not remove this marker. -->";

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
      mockPlanner.addTaskComment,
      mockPlanner.updateTaskStatus,
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
    jest.useRealTimers();
    jest.restoreAllMocks();
    fse.removeSync(dataDir);
    process.env = originalEnv;
  });

  it("should log the agent name and polling interval on start", () => {
    config.AGENT_NAME = "test-agent";

    const agent = new Agent(config);
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
    const agent = new Agent(config);
    agent.start();
    expect(mockPlanner.getCurrentUser).toHaveBeenCalledTimes(1); // initial poll

    await jest.advanceTimersByTimeAsync(15000);
    expect(mockPlanner.getCurrentUser).toHaveBeenCalledTimes(4); // initial + 3 polls
    agent.stop();
  });

  it("should log the assigned tasks with their status", async () => {
    jest.useFakeTimers();
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        title: "Fix the build",
        status: "In Progress",
        description: "",
        comments: [],
      },
      {
        id: "task-2",
        title: "Review PR",
        status: "Blocked",
        description: "",
        comments: [],
      },
    ]);

    const agent = new Agent(config);
    agent.start();
    await jest.advanceTimersByTimeAsync(0);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Tasks assigned to 'Test User' (2):"),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("[In Progress] Fix the build"),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("[Blocked] Review PR"),
    );
    agent.stop();
  });

  it("should log when no tasks are assigned", async () => {
    jest.useFakeTimers();
    const agent = new Agent(config);
    agent.start();
    await jest.advanceTimersByTimeAsync(0);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("No tasks currently assigned to 'Test User'"),
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
      },
      {
        id: "task-2",
        title: "Already running",
        status: "In Progress",
        description: "Another task",
        comments: [],
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = new Agent(config);
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    expect(mockQoder.performTask).toHaveBeenCalledTimes(1);
    expect(mockQoder.performTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      path.join(dataDir, "tasks", "task-1-Agent.md"),
    );
    expect(mockPlanner.addTaskComment).toHaveBeenCalledWith(
      "task-1",
      "Feature implemented",
    );
    expect(mockPlanner.updateTaskStatus).toHaveBeenCalledWith(
      "task-1",
      "Done",
    );
    agent.stop();
  });

  it("should write the task notes file with description and comments", async () => {
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
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = new Agent(config);
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    const notesFile = path.join(dataDir, "tasks", "task-1-Agent.md");
    expect(await fse.pathExists(notesFile)).toBe(true);
    const content = await fse.readFile(notesFile, "utf8");
    expect(content).toContain("# Task: Implement feature");
    expect(content).toContain("Add a feature");
    expect(content).toContain("**Alice** (2026-09-02T00:00:00.000Z): Please add tests");
    expect(content).toContain(AGENT_NOTES_MARKER);
    expect(content).toContain("## Agent Notes");
    agent.stop();
  });

  it("should preserve existing agent notes across runs", async () => {
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
      },
    ]);
    mockQoder.performTask.mockResolvedValue("Feature implemented");

    const agent = new Agent(config);
    agent.start();
    await waitFor(() => mockPlanner.updateTaskStatus.mock.calls.length > 0);

    const content = await fse.readFile(notesFile, "utf8");
    expect(content).toContain("New description");
    expect(content).not.toContain("Old description");
    expect(content).toContain("Previous findings from the last run");
    agent.stop();
  });

  it("should not comment or update status when qoder fails", async () => {
    mockPlanner.listAssignedTasks.mockResolvedValue([
      {
        id: "task-1",
        title: "Implement feature",
        status: "To Do",
        description: "Add a feature",
        comments: [],
      },
    ]);
    mockQoder.performTask.mockRejectedValue(
      new Error("Qoder task execution failed:\nboom"),
    );

    const agent = new Agent(config);
    agent.start();
    await waitFor(() =>
      logSpy.mock.calls.some((call) =>
        String(call[0]).includes(
          "Failed to process task 'Implement feature' (task-1)",
        ),
      ),
    );

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Failed to process task 'Implement feature' (task-1)",
      ),
    );
    expect(mockPlanner.addTaskComment).not.toHaveBeenCalled();
    expect(mockPlanner.updateTaskStatus).not.toHaveBeenCalled();
    agent.stop();
  });

  it("should log an error and keep polling when the Planner fails", async () => {
    jest.useFakeTimers();
    mockPlanner.getCurrentUser.mockRejectedValue(
      new Error(
        "Planner request to '/api/users/session' failed with status 403",
      ),
    );

    const agent = new Agent(config);
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
    const agent = new Agent(config);
    agent.start();
    agent.stop();
    await jest.advanceTimersByTimeAsync(60000);

    expect(mockPlanner.getCurrentUser).toHaveBeenCalledTimes(1); // initial poll only
  });
});
