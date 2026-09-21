import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import { AgentActionsManager } from "./AgentActionsManager";

jest.mock("./OTelContext", () => {
  // One logger instance per module name: tests can assert the lines logged
  // by a specific module (e.g. 'agent-actions').
  const moduleLoggers: Record<
    string,
    { debug: jest.Mock; info: jest.Mock; warn: jest.Mock; error: jest.Mock }
  > = {};
  return {
    OTelLogger: jest.fn(() => ({
      createModuleLogger: jest.fn((module: string) => {
        if (!moduleLoggers[module]) {
          moduleLoggers[module] = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
          };
        }
        return moduleLoggers[module];
      }),
    })),
    __moduleLoggers: moduleLoggers,
  };
});

const actionsLogger = (
  jest.requireMock("./OTelContext") as {
    __moduleLoggers: Record<
      string,
      { info: jest.Mock; warn: jest.Mock; error: jest.Mock }
    >;
  }
).__moduleLoggers["agent-actions"];

const VALID_ACTIONS = [
  "default:",
  "  model: default-model",
  "actions:",
  "  - status_start: To Do",
  "    status_end: Done",
].join("\n");

// Wait for the watched file change to be applied (the watcher polls the
// file stat at the interval configured in the test).
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

describe("AgentActionsManager", () => {
  let dir: string;
  let filePath: string;
  let managers: AgentActionsManager[] = [];

  const writeActions = (content: string): Promise<void> =>
    fse.writeFile(filePath, content);

  const createManager = (watchIntervalMs = 10): AgentActionsManager => {
    const manager = new AgentActionsManager(filePath, watchIntervalMs);
    managers.push(manager);
    return manager;
  };

  beforeEach(() => {
    dir = fse.mkdtempSync(
      path.join(os.tmpdir(), "agent-actions-manager-spec-"),
    );
    filePath = path.join(dir, "llm-agent.yaml");
    managers = [];
    for (const logger of Object.values(actionsLogger)) {
      logger.mockClear();
    }
  });

  afterEach(() => {
    for (const manager of managers) {
      manager.stop();
    }
    fse.removeSync(dir);
  });

  it("should load a valid file at startup and return the configuration", async () => {
    await writeActions(VALID_ACTIONS);

    const manager = createManager();
    const config = await manager.load();

    expect(config).toBe(manager.config);
    expect(manager.config).toEqual({
      defaultModel: "default-model",
      defaultTimeout: null,
      actions: [
        expect.objectContaining({ statusStart: "To Do", statusEnd: "Done" }),
      ],
    });
  });

  it("should return null and keep an empty configuration when the file is missing", async () => {
    const manager = createManager();

    await expect(manager.load()).resolves.toBeNull();
    expect(manager.config).toEqual({
      defaultModel: "",
      defaultTimeout: null,
      actions: [],
    });
  });

  it("should throw when the file exists but is invalid", async () => {
    await writeActions("actions: not-a-list");

    const manager = createManager();

    await expect(manager.load()).rejects.toThrow(
      /Invalid agent actions configuration/,
    );
  });

  it("should apply a valid change in place on reload", async () => {
    await writeActions(VALID_ACTIONS);
    const manager = createManager();
    await manager.load();
    const configBeforeReload = manager.config;

    await writeActions(VALID_ACTIONS.replace("default-model", "new-model"));
    await manager.reload();

    // The configuration object is updated in place: a consumer that kept
    // the reference observes the new values.
    expect(manager.config).toBe(configBeforeReload);
    expect(configBeforeReload.defaultModel).toBe("new-model");
    expect(actionsLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("Agent actions reloaded"),
    );
  });

  it("should do nothing when the content did not change", async () => {
    await writeActions(VALID_ACTIONS);
    const manager = createManager();
    await manager.load();
    actionsLogger.info.mockClear();

    await manager.reload();

    expect(actionsLogger.info).not.toHaveBeenCalled();
    expect(manager.config.defaultModel).toBe("default-model");
  });

  it("should keep the last valid configuration when the new content is invalid", async () => {
    await writeActions(VALID_ACTIONS);
    const manager = createManager();
    await manager.load();

    // An invalid content never throws at runtime and never disables the
    // agent: the last valid configuration is kept.
    await writeActions("actions: not-a-list");
    await expect(manager.reload()).resolves.toBeUndefined();
    expect(manager.config.defaultModel).toBe("default-model");
    expect(manager.config.actions).toHaveLength(1);
    expect(actionsLogger.error).toHaveBeenCalledTimes(1);

    // The same invalid content is only reported once...
    await manager.reload();
    expect(actionsLogger.error).toHaveBeenCalledTimes(1);

    // ...and a fixed content is applied.
    await writeActions(VALID_ACTIONS.replace("default-model", "fixed-model"));
    await manager.reload();
    expect(manager.config.defaultModel).toBe("fixed-model");
  });

  it("should keep the last valid configuration when the file is removed", async () => {
    await writeActions(VALID_ACTIONS);
    const manager = createManager();
    await manager.load();

    await fse.remove(filePath);
    await expect(manager.reload()).resolves.toBeUndefined();

    expect(manager.config.defaultModel).toBe("default-model");
    expect(manager.config.actions).toHaveLength(1);
    expect(actionsLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
    );
  });

  it("should apply a change written to the watched file without a restart", async () => {
    await writeActions(VALID_ACTIONS);
    const manager = createManager();
    await manager.load();
    manager.start();

    await writeActions(VALID_ACTIONS.replace("default-model", "watched-model"));

    await waitFor(() => manager.config.defaultModel === "watched-model");
    expect(manager.config.actions).toHaveLength(1);
    manager.stop();
  });

  it("should detect a file created after a missing startup load", async () => {
    const manager = createManager();
    await expect(manager.load()).resolves.toBeNull();
    manager.start();

    await writeActions(VALID_ACTIONS);

    await waitFor(() => manager.config.actions.length === 1);
    expect(manager.config.defaultModel).toBe("default-model");
    manager.stop();
  });
});
