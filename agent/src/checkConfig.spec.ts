import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";

// The module runs its main() at import time: every run loads a fresh copy
// through isolateModules with the AGENT_ACTIONS_FILE env var pointing at the
// fixture of the test.
describe("checkConfig", () => {
  let tmpDir: string;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  const run = async (actionsFile: string | undefined): Promise<number> => {
    if (actionsFile === undefined) {
      delete process.env.AGENT_ACTIONS_FILE;
    } else {
      process.env.AGENT_ACTIONS_FILE = actionsFile;
    }
    // main() sets process.exitCode when it settles: poll until it does.
    process.exitCode = undefined;
    jest.isolateModules(() => {
      require("./checkConfig");
    });
    const deadline = Date.now() + 2000;
    while (process.exitCode === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return process.exitCode ?? 1;
  };

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `check-config-spec-${Date.now()}`);
    logSpy = jest.spyOn(console, "log").mockImplementation(jest.fn());
    errorSpy = jest.spyOn(console, "error").mockImplementation(jest.fn());
  });

  afterEach(() => {
    fse.removeSync(tmpDir);
    jest.restoreAllMocks();
    delete process.env.AGENT_ACTIONS_FILE;
  });

  it("prints the resolved configuration and exits 0 for a valid file", async () => {
    const filePath = path.join(tmpDir, "llm-agent.yaml");
    await fse.outputFile(
      filePath,
      [
        "instructions:",
        "  plan: Post an implementation plan as the task summary.",
        "default:",
        "  model: default-model",
        "  status_abort: Aborted",
        "actions:",
        "  - project: Web",
        "    status_start: To Do",
        "    status_end: Done",
        "    instruction: plan",
      ].join("\n"),
    );

    await expect(run(filePath)).resolves.toBe(0);
    const logs = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).toContain("Configuration is valid (1 action(s)).");
    expect(logs).toContain("model: default-model");
    expect(logs).toContain("status_abort: Aborted");
    expect(logs).toContain("instruction templates: plan");
    expect(logs).toContain("'Web': To Do -> Done");
    expect(logs).toContain(
      "instruction: Post an implementation plan as the task summary.",
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("exits 1 with the list of problems for an invalid file", async () => {
    const filePath = path.join(tmpDir, "llm-agent.yaml");
    await fse.outputFile(filePath, "actions:\n  - project: Web\n");

    await expect(run(filePath)).resolves.toBe(1);
    const errors = errorSpy.mock.calls
      .map((call) => String(call[0]))
      .join("\n");
    expect(errors).toContain("Invalid agent actions configuration:");
    expect(errors).toContain("'actions[0].status_start' is required");
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain(
      "Configuration is valid",
    );
  });

  it("exits 0 for a missing file", async () => {
    await expect(
      run(path.join(tmpDir, "missing.yaml")),
    ).resolves.toBe(0);
    expect(
      logSpy.mock.calls.map((call) => String(call[0])).join("\n"),
    ).toContain("File not found");
  });

  it("shows the mode of both action kinds and validates a mixed configuration", async () => {
    const filePath = path.join(tmpDir, "llm-agent.yaml");
    await fse.outputFile(
      filePath,
      [
        "actions:",
        "  - project: Web",
        "    status_start: To Do",
        "    status_end: Done",
        "  - project: Projects/Ideation",
        "    trigger: comments",
        "    status_start: Plan",
        "    instruction: plan",
      ].join("\n"),
    );

    await expect(run(filePath)).resolves.toBe(0);
    const logs = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).toContain("'Web': To Do -> Done");
    expect(logs).toContain(
      "'Projects/Ideation': Plan -> (comments: no status change, re-runs on new user comments)",
    );
    expect(logs).toContain("trigger: comments");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("exits 1 when a comments action competes with a pipeline action", async () => {
    const filePath = path.join(tmpDir, "llm-agent.yaml");
    await fse.outputFile(
      filePath,
      [
        "actions:",
        "  - project: Web",
        "    trigger: comments",
        "    status_start: To Do",
        "  - project: 'W*'",
        "    status_start: To Do",
        "    status_end: Done",
      ].join("\n"),
    );

    await expect(run(filePath)).resolves.toBe(1);
    const errors = errorSpy.mock.calls
      .map((call) => String(call[0]))
      .join("\n");
    expect(errors).toContain("Invalid agent actions configuration:");
    expect(errors).toContain(
      "actions[0] (trigger: comments) competes with actions[1] (status pipeline)",
    );
  });
});
