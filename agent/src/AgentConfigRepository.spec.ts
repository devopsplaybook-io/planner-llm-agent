import { execFile } from "child_process";
import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import { AgentConfigRepository } from "./AgentConfigRepository";
import { Config } from "./Config";

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

jest.mock("child_process", () => ({
  execFile: jest.fn(),
}));

const mockExecFile = execFile as unknown as jest.Mock;

const REPOSITORY = "https://github.com/acme/agent-config.git";
const OLD_REPOSITORY = "https://github.com/acme/old-config.git";

type CliCallback = (error: Error | null, stdout: string, stderr: string) => void;

// Configure the execFile mock to invoke the handler for each command. The
// handler returns the stdout, or an Error to simulate a failing command.
function mockCli(handler: (command: string, args: string[]) => string | Error): void {
  mockExecFile.mockImplementation(
    (command: string, args: string[], _options: unknown, callback: CliCallback) => {
      const result = handler(command, args);
      if (result instanceof Error) {
        callback(result, "", "");
      } else {
        callback(null, result ?? "", "");
      }
    },
  );
}

describe("AgentConfigRepository", () => {
  let dataDir: string;
  let config: Config;
  let repository: AgentConfigRepository;

  beforeEach(async () => {
    dataDir = await fse.mkdtemp(path.join(os.tmpdir(), "agent-config-spec-"));
    config = new Config();
    config.DATA_DIR = dataDir;
    mockExecFile.mockReset();
    repository = new AgentConfigRepository(config);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fse.remove(dataDir);
  });

  function targetDir(): string {
    return path.join(dataDir, "agent-config");
  }

  function gitCalls(): [string, string[], { cwd?: string }][] {
    return mockExecFile.mock.calls.map((call) => [call[0], call[1], call[2]]);
  }

  it("does nothing when no repository is configured", async () => {
    await expect(repository.sync()).resolves.toBe("");

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("clones the repository into DATA_DIR/agent-config", async () => {
    config.AGENT_CONFIG_REPOSITORY = REPOSITORY;
    mockCli((command, args) => {
      if (args[0] === "rev-parse") {
        return "abc1234";
      }
      return "";
    });

    await expect(repository.sync()).resolves.toBe(targetDir());

    const cloneCall = gitCalls().find((call) => call[1][0] === "clone");
    expect(cloneCall).toBeDefined();
    expect(cloneCall?.[1]).toEqual([
      "clone",
      "--depth",
      "1",
      "--branch",
      "main",
      REPOSITORY,
      targetDir(),
    ]);

    const revParseCall = gitCalls().find((call) => call[1][0] === "rev-parse");
    expect(revParseCall?.[2].cwd).toBe(targetDir());
    expect(await fse.pathExists(path.join(targetDir(), ".git"))).toBe(false);
  });

  it("clones with a sparse checkout when a folder is configured", async () => {
    config.AGENT_CONFIG_REPOSITORY = REPOSITORY;
    config.AGENT_CONFIG_FOLDER = "skills/";
    mockCli(() => "");

    await expect(repository.sync()).resolves.toBe(
      path.join(targetDir(), "skills"),
    );

    const sparseInit = gitCalls().find(
      (call) => call[1][0] === "sparse-checkout" && call[1][1] === "init",
    );
    expect(sparseInit?.[1]).toEqual(["sparse-checkout", "init", "--cone"]);
    expect(sparseInit?.[2].cwd).toBe(targetDir());
    const sparseSet = gitCalls().find(
      (call) => call[1][0] === "sparse-checkout" && call[1][1] === "set",
    );
    expect(sparseSet?.[1]).toEqual(["sparse-checkout", "set", "skills"]);
    // The folder is trimmed: no second sparse-checkout call for "skills/".
    expect(
      gitCalls().filter((call) => call[1][0] === "sparse-checkout").length,
    ).toBe(2);
  });

  it("updates an existing clone instead of re-cloning", async () => {
    config.AGENT_CONFIG_REPOSITORY = REPOSITORY;
    await fse.ensureDir(path.join(targetDir(), ".git"));
    mockCli((command, args) => {
      if (args[0] === "remote") {
        return REPOSITORY;
      }
      if (args[0] === "rev-parse") {
        return "abc1234";
      }
      return "";
    });

    await expect(repository.sync()).resolves.toBe(targetDir());

    expect(gitCalls().some((call) => call[1][0] === "clone")).toBe(false);
    const fetchCall = gitCalls().find((call) => call[1][0] === "fetch");
    expect(fetchCall?.[1]).toEqual(["fetch", "--depth", "1", "origin", "main"]);
    expect(fetchCall?.[2].cwd).toBe(targetDir());
    const checkoutCall = gitCalls().find((call) => call[1][0] === "checkout");
    expect(checkoutCall?.[1]).toEqual([
      "checkout",
      "-f",
      "-B",
      "main",
      "FETCH_HEAD",
    ]);
    expect(checkoutCall?.[2].cwd).toBe(targetDir());
    const cleanCall = gitCalls().find((call) => call[1][0] === "clean");
    expect(cleanCall?.[1]).toEqual(["clean", "-fd"]);
  });

  it("re-clones when the repository URL changed", async () => {
    config.AGENT_CONFIG_REPOSITORY = OLD_REPOSITORY;
    await fse.ensureDir(path.join(targetDir(), ".git"));
    mockCli((command, args) => {
      if (args[0] === "remote") {
        return OLD_REPOSITORY;
      }
      if (args[0] === "rev-parse") {
        return "def5678";
      }
      return "";
    });

    config.AGENT_CONFIG_REPOSITORY = REPOSITORY;
    await expect(repository.sync()).resolves.toBe(targetDir());

    // The stale clone was removed before cloning the new repository.
    expect(await fse.pathExists(path.join(targetDir(), ".git"))).toBe(false);
    const cloneCall = gitCalls().find((call) => call[1][0] === "clone");
    expect(cloneCall?.[1]).toContain(REPOSITORY);
    expect(cloneCall?.[1]).not.toContain(OLD_REPOSITORY);
  });

  it("rejects when a git command fails", async () => {
    config.AGENT_CONFIG_REPOSITORY = REPOSITORY;
    mockCli((command, args) => {
      if (args[0] === "clone") {
        return new Error("Authentication failed");
      }
      return "";
    });

    await expect(repository.sync()).rejects.toThrow(
      /Agent config repository sync failed/,
    );
  });

  it("skips the sync while another sync is already running", async () => {
    config.AGENT_CONFIG_REPOSITORY = REPOSITORY;
    let releaseFirstSync!: () => void;
    const firstSyncGate = new Promise<void>((resolve) => {
      releaseFirstSync = resolve;
    });
    let gitCallCount = 0;
    mockExecFile.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: CliCallback) => {
        gitCallCount += 1;
        if (gitCallCount === 1) {
          void firstSyncGate.then(() => callback(null, "abc1234", ""));
        } else {
          callback(null, "abc1234", "");
        }
      },
    );

    const firstSync = repository.sync();
    // The second sync runs while the first one is blocked on its git call.
    await expect(repository.sync()).resolves.toBe(targetDir());
    releaseFirstSync();
    await expect(firstSync).resolves.toBe(targetDir());

    expect(gitCallCount).toBe(2);
  });
});
