import { Agent } from "./Agent";
import { Config } from "./Config";

describe("Agent", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, "log").mockImplementation(jest.fn());
    delete process.env.AGENT_NAME;
    delete process.env.TASK_POLLING_INTERVAL;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    process.env = originalEnv;
  });

  it("should log the agent name and polling interval on start", () => {
    const config = new Config();
    config.AGENT_NAME = "test-agent";
    config.TASK_POLLING_INTERVAL = 5;

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

  it("should poll for tasks at the configured interval", () => {
    const config = new Config();
    config.TASK_POLLING_INTERVAL = 5;

    const agent = new Agent(config);
    agent.start();
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining("Polling for assigned task"),
    );

    jest.advanceTimersByTime(15000);
    expect(console.log).toHaveBeenCalledTimes(3 + 1); // start + 3 polls
    agent.stop();
  });

  it("should stop polling when stopped", () => {
    const config = new Config();
    config.TASK_POLLING_INTERVAL = 5;

    const agent = new Agent(config);
    agent.start();
    agent.stop();
    jest.advanceTimersByTime(60000);

    const pollingCalls = (console.log as jest.Mock).mock.calls.filter(
      (args: unknown[]) =>
        String(args[0]).includes("Polling for assigned task"),
    );
    expect(pollingCalls).toHaveLength(0);
  });
});
