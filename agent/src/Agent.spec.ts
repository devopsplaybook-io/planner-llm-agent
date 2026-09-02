import { Agent } from "./Agent";
import { Config } from "./Config";
import { PlannerClient } from "./PlannerClient";

jest.mock("./PlannerClient", () => ({
  PlannerClient: jest.fn(),
}));

const MockedPlannerClient = PlannerClient as unknown as jest.Mock;
const mockPlanner = {
  getCurrentUser: jest.fn(),
  listAssignedTasks: jest.fn(),
};

describe("Agent", () => {
  const originalEnv = process.env;
  let config: Config;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, "log").mockImplementation(jest.fn());
    delete process.env.AGENT_NAME;
    delete process.env.TASK_POLLING_INTERVAL;
    config = new Config();
    config.TASK_POLLING_INTERVAL = 5;

    MockedPlannerClient.mockImplementation(() => mockPlanner);
    mockPlanner.getCurrentUser.mockReset();
    mockPlanner.listAssignedTasks.mockReset();
    mockPlanner.getCurrentUser.mockResolvedValue({
      id: "user-1",
      name: "Test User",
    });
    mockPlanner.listAssignedTasks.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
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
    const agent = new Agent(config);
    agent.start();
    expect(mockPlanner.getCurrentUser).toHaveBeenCalledTimes(1); // initial poll

    await jest.advanceTimersByTimeAsync(15000);
    expect(mockPlanner.getCurrentUser).toHaveBeenCalledTimes(4); // initial + 3 polls
    agent.stop();
  });

  it("should log the assigned tasks with their status", async () => {
    mockPlanner.listAssignedTasks.mockResolvedValue([
      { id: "task-1", title: "Fix the build", status: "In Progress" },
      { id: "task-2", title: "Review PR", status: "To Do" },
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
      expect.stringContaining("[To Do] Review PR"),
    );
    agent.stop();
  });

  it("should log when no tasks are assigned", async () => {
    const agent = new Agent(config);
    agent.start();
    await jest.advanceTimersByTimeAsync(0);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("No tasks currently assigned to 'Test User'"),
    );
    agent.stop();
  });

  it("should log an error and keep polling when the Planner fails", async () => {
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
    const agent = new Agent(config);
    agent.start();
    agent.stop();
    await jest.advanceTimersByTimeAsync(60000);

    expect(mockPlanner.getCurrentUser).toHaveBeenCalledTimes(1); // initial poll only
  });
});
