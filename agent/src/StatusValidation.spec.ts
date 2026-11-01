import { AgentAction, AgentActionsConfig } from "./AgentActions";
import { PlannerProject } from "./PlannerClient";
import {
  buildStatusWarnings,
  configuredStatusUsages,
  projectHasStatus,
} from "./StatusValidation";

function action(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    project: "",
    statusStart: "To Do",
    statusEnd: "Done",
    trigger: "status",
    model: "",
    instruction: "",
    timeout: null,
    weight: null,
    ...overrides,
  };
}

function defaults(
  overrides: Partial<AgentActionsConfig> = {},
): AgentActionsConfig {
  return {
    defaultModel: "",
    defaultTimeout: null,
    actions: [],
    ...overrides,
  };
}

function project(
  id: string,
  name: string,
  statuses?: string[],
): PlannerProject {
  return statuses === undefined
    ? { id, name, description: "" }
    : { id, name, description: "", statuses };
}

const COMPLETE_CATALOG = [
  "To Do",
  "In Progress",
  "Blocked",
  "Done",
  "Failed",
  "Aborted",
];

describe("projectHasStatus", () => {
  it("should accept any status when the catalog is unknown or empty", () => {
    expect(projectHasStatus(project("p1", "Web"), "Done")).toBe(true);
    expect(projectHasStatus(project("p1", "Web", []), "Done")).toBe(true);
    expect(projectHasStatus(null, "Done")).toBe(true);
  });

  it("should check a known catalog", () => {
    const value = project("p1", "Web", ["To Do", "Done"]);
    expect(projectHasStatus(value, "Done")).toBe(true);
    expect(projectHasStatus(value, "Completed")).toBe(false);
  });
});

describe("configuredStatusUsages", () => {
  it("should resolve the pipeline statuses with their settings", () => {
    expect(
      configuredStatusUsages(
        action({
          statusError: "Failed",
          statusInProgress: "In Progress",
          statusAbort: "Aborted",
        }),
        2,
        defaults(),
      ),
    ).toEqual([
      { setting: "actions[2].status_start", status: "To Do" },
      { setting: "actions[2].status_end", status: "Done" },
      { setting: "actions[2].status_error", status: "Failed" },
      { setting: "actions[2].status_in_progress", status: "In Progress" },
      { setting: "actions[2].status_abort", status: "Aborted" },
    ]);
  });

  it("should resolve the statuses from the defaults", () => {
    expect(
      configuredStatusUsages(
        action(),
        0,
        defaults({
          defaultStatusError: "Failed",
          defaultStatusInProgress: "In Progress",
          defaultStatusAbort: "Aborted",
        }),
      ),
    ).toEqual([
      { setting: "actions[0].status_start", status: "To Do" },
      { setting: "actions[0].status_end", status: "Done" },
      { setting: "default.status_error", status: "Failed" },
      { setting: "default.status_in_progress", status: "In Progress" },
      { setting: "default.status_abort", status: "Aborted" },
    ]);
  });

  it("should fall back to the end status for the error status", () => {
    const usages = configuredStatusUsages(action(), 0, defaults());
    expect(usages).toEqual(
      expect.arrayContaining([
        { setting: "actions[0].status_end", status: "Done" },
        {
          setting: "actions[0].status_end (used as the error status)",
          status: "Done",
        },
      ]),
    );
  });

  it("should skip the ignored statuses in comments mode but keep abort", () => {
    expect(
      configuredStatusUsages(
        action({ trigger: "comments", statusEnd: null, statusAbort: "Aborted" }),
        0,
        defaults({
          defaultStatusError: "Failed",
          defaultStatusInProgress: "In Progress",
          defaultStatusAbort: "Blocked",
        }),
      ),
    ).toEqual([
      { setting: "actions[0].status_start", status: "To Do" },
      { setting: "actions[0].status_abort", status: "Aborted" },
    ]);
  });
});

describe("buildStatusWarnings", () => {
  it("should not warn when every configured status exists", () => {
    const warnings = buildStatusWarnings(
      [
        action({
          statusError: "Failed",
          statusInProgress: "In Progress",
          statusAbort: "Aborted",
        }),
        action({ statusStart: "Blocked", statusEnd: "Done" }),
      ],
      defaults(),
      "Done",
      [project("p1", "Web", COMPLETE_CATALOG)],
    );
    expect(warnings).toEqual([]);
  });

  it("should warn per missing action status with its setting", () => {
    const catalog = ["To Do", "Done"];
    const cases: [Partial<AgentAction>, string][] = [
      [{ statusStart: "Todo" }, "actions[0].status_start"],
      [{ statusEnd: "Complete", statusError: "Done" }, "actions[0].status_end"],
      [{ statusError: "Broken" }, "actions[0].status_error"],
      [{ statusInProgress: "Working" }, "actions[0].status_in_progress"],
      [{ statusAbort: "Stopped" }, "actions[0].status_abort"],
    ];
    for (const [overrides, setting] of cases) {
      const warnings = buildStatusWarnings(
        [action(overrides)],
        defaults(),
        "Done",
        [project("p1", "Web", catalog)],
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`(${setting})`);
      expect(warnings[0]).toContain("project 'Web'");
      expect(warnings[0]).toContain("statuses: To Do, Done");
    }
  });

  it("should name the default setting when a default status is missing", () => {
    const warnings = buildStatusWarnings(
      [action()],
      defaults({
        defaultStatusError: "Failed",
        defaultStatusInProgress: "Working",
        defaultStatusAbort: "Stopped",
      }),
      "Done",
      [project("p1", "Web", ["To Do", "Done"])],
    );
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toContain("(default.status_error)");
    expect(warnings.join("\n")).toContain("(default.status_in_progress)");
    expect(warnings.join("\n")).toContain("(default.status_abort)");
  });

  it("should only check the projects the action applies to", () => {
    const warnings = buildStatusWarnings(
      [action({ project: "Web*" })],
      defaults(),
      "Done",
      [
        project("p1", "Web", ["To Do", "Done"]),
        project("p2", "Mobile", ["To Do", "Done"]),
      ],
    );
    expect(warnings).toEqual([]);
  });

  it("should skip comments actions' ignored error and in-progress statuses", () => {
    const warnings = buildStatusWarnings(
      [action({ trigger: "comments", statusEnd: null })],
      defaults({
        defaultStatusError: "Failed",
        defaultStatusInProgress: "In Progress",
      }),
      "Done",
      [project("p1", "Web", ["To Do"])],
    );
    // Only the dependency satisfied status is missing from the catalog.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("TASK_DEPENDENCY_SATISFIED_STATUS");
  });

  it("should never warn about projects without a status catalog", () => {
    const warnings = buildStatusWarnings(
      [action({ statusStart: "Todo" })],
      defaults(),
      "Completed",
      [project("p1", "Web"), project("p2", "Mobile", [])],
    );
    expect(warnings).toEqual([]);
  });

  it("should emit one aggregate warning for projects missing the dependency status", () => {
    const warnings = buildStatusWarnings(
      [action({ trigger: "comments", statusEnd: null })],
      defaults(),
      "Done",
      [
        project("p1", "Web", ["To Do", "Done"]),
        project("p2", "Mobile", ["To Do", "Completed"]),
        project("p3", "Api", ["To Do", "Done"]),
        project("p4", "Unknown"),
      ],
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      "Dependency satisfied status 'Done' (TASK_DEPENDENCY_SATISFIED_STATUS)",
    );
    expect(warnings[0]).toContain("'Mobile'");
    expect(warnings[0]).not.toContain("'Web'");
    expect(warnings[0]).not.toContain("'Api'");
  });

  it("should not repeat a warning for the same setting, status and project", () => {
    const warnings = buildStatusWarnings(
      [action()],
      defaults(),
      "Done",
      [project("p1", "Web", ["To Do"])],
    );
    // The end status is used as the error status: one warning per setting,
    // and the dependency warning adds one more.
    expect(warnings).toHaveLength(3);
    expect(
      warnings.filter((warning) => warning.includes("actions[0].status_end")),
    ).toHaveLength(2);
  });
});
