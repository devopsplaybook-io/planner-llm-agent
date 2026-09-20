import type { AgentAction } from "./AgentActions";
import { TASK_CONFLICT_MODES, type ConflictMode } from "./Config";
import type { PlannerTask } from "./PlannerClient";
import {
  DEFAULT_TASK_WEIGHT,
  MAX_TASK_WEIGHT,
  MIN_TASK_WEIGHT,
  SchedulerCandidate,
  RunningTask,
  clampWeight,
  extractAgentLockKeys,
  extractAgentWeight,
  extractRepoConflictKeys,
  maxConcurrentTasks,
  normalizeConflictMode,
  resolveStaticConflictKeys,
  resolveTaskWeight,
  sanitizeBudget,
  selectEvaluationShortlist,
  selectTasks,
  selectTasksLegacy,
} from "./Scheduler";

// A task with no repository mention and no directive: the default weight
// applies and no conflict key is derived.
const buildTask = (overrides: Partial<PlannerTask> & { id: string }): PlannerTask => ({
  projectId: "p1",
  title: `Task ${overrides.id}`,
  status: "To Do",
  priority: "medium",
  description: "",
  dateUpdated: "2026-09-01T00:00:00.000Z",
  comments: [],
  attachments: [],
  ...overrides,
});

const buildAction = (overrides: Partial<AgentAction> = {}): AgentAction => ({
  project: "",
  statusStart: "To Do",
  statusEnd: "Done",
  model: "",
  instruction: "",
  timeout: null,
  weight: null,
  ...overrides,
});

const buildCandidate = (
  task: PlannerTask,
  overrides: Partial<SchedulerCandidate> = {},
): SchedulerCandidate => ({
  task,
  action: buildAction(),
  projectName: "Projects",
  ...overrides,
});

const buildRunning = (overrides: Partial<RunningTask> & { taskId: string }): RunningTask => ({
  title: `Running ${overrides.taskId}`,
  projectName: "Projects",
  actionKey: "*:To Do",
  weight: DEFAULT_TASK_WEIGHT,
  conflictKeys: [],
  startedAt: Date.now() - 60000,
  model: "",
  ...overrides,
});

const mapOf = (running: RunningTask[]): Map<string, RunningTask> =>
  new Map(running.map((runningTask) => [runningTask.taskId, runningTask]));

describe("Scheduler", () => {
  describe("weight resolution", () => {
    it("extracts the agent-weight directive from the description", () => {
      expect(extractAgentWeight("agent-weight: 0.5")).toBe(0.5);
      expect(extractAgentWeight("Some text\n  Agent-Weight: 0.75")).toBe(0.75);
      expect(extractAgentWeight("agent-weight:2")).toBe(2);
    });

    it("returns null when the directive is missing or unparsable", () => {
      expect(extractAgentWeight("no directive here")).toBeNull();
      expect(extractAgentWeight("agent-weight: light")).toBeNull();
      expect(extractAgentWeight("agent-weight: ")).toBeNull();
    });

    it("clamps the weight to the bounded scale", () => {
      expect(clampWeight(0.1)).toBe(MIN_TASK_WEIGHT);
      expect(clampWeight(0.5)).toBe(0.5);
      expect(clampWeight(2)).toBe(MAX_TASK_WEIGHT);
      expect(clampWeight(Number.NaN)).toBe(DEFAULT_TASK_WEIGHT);
    });

    it("resolves the weight with the directive winning over the action weight", () => {
      expect(resolveTaskWeight("agent-weight: 0.5", 0.75)).toBe(0.5);
      expect(resolveTaskWeight("no directive", 0.75)).toBe(0.75);
      expect(resolveTaskWeight("no directive", null)).toBe(DEFAULT_TASK_WEIGHT);
      expect(resolveTaskWeight("agent-weight: 3", null)).toBe(MAX_TASK_WEIGHT);
    });
  });

  describe("conflict keys", () => {
    it("extracts the agent-lock keys: multiple lines, comma-separated, normalized", () => {
      expect(
        extractAgentLockKeys("Work on things\nagent-lock: repo:Acme/Web\nagent-lock: shared-resource, acme/api"),
      ).toEqual(["repo:acme/web", "shared-resource", "repo:acme/api"]);
    });

    it("returns no agent-lock key when the description has none", () => {
      expect(extractAgentLockKeys("nothing here")).toEqual([]);
    });

    it("extracts repository slugs from GitHub URLs, SSH clones and backtick slugs", () => {
      const task = buildTask({
        id: "t1",
        description: [
          "See https://github.com/Acme/Web-App and https://github.com/acme/web.git/actions.",
          "Clone with git@github.com:Acme/cli-tools.git or ssh git@github.com/acme/other.",
          "Also `acme/infra` in backticks.",
        ].join("\n"),
        comments: [
          {
            id: "c1",
            userId: "u1",
            userName: "User",
            text: "The fix belongs in `acme/infra` (see github.com/acme/infra/pull/12).",
            dateCreated: "2026-09-02T00:00:00.000Z",
          },
        ],
      });
      expect(extractRepoConflictKeys(task).sort()).toEqual([
        "repo:acme/cli-tools",
        "repo:acme/infra",
        "repo:acme/other",
        "repo:acme/web",
        "repo:acme/web-app",
      ]);
    });

    it("does not extract repository keys from plain text mentions", () => {
      const task = buildTask({
        id: "t1",
        description: "Work on the web app of the acme org and the cli-tools repo.",
      });
      expect(extractRepoConflictKeys(task)).toEqual([]);
    });

    it("derives the static conflict keys per conflict mode", () => {
      const candidate = buildCandidate(
        buildTask({
          id: "t1",
          description:
            "Work on https://github.com/acme/web.\nagent-lock: shared-resource",
        }),
      );
      expect(resolveStaticConflictKeys(candidate, "repo")).toEqual([
        "shared-resource",
        "repo:acme/web",
      ]);
      expect(resolveStaticConflictKeys(candidate, "project")).toEqual([
        "shared-resource",
        "repo:acme/web",
        "project:projects",
      ]);
      expect(resolveStaticConflictKeys(candidate, "none")).toEqual([
        "shared-resource",
      ]);
      const unresolvedProject = buildCandidate(
        buildTask({ id: "t2", description: "" }),
        { projectName: "" },
      );
      expect(resolveStaticConflictKeys(unresolvedProject, "project")).toEqual(
        [],
      );
    });
  });

  describe("selectTasks", () => {
    const options = (overrides: Record<string, unknown> = {}) => ({
      maxParallel: 2,
      conflictMode: "repo" as ConflictMode,
      ...overrides,
    });

    it("picks the candidates in queue order while the budget allows it", () => {
      const candidates = [
        buildCandidate(buildTask({ id: "t1" })),
        buildCandidate(buildTask({ id: "t2" })),
        buildCandidate(buildTask({ id: "t3" })),
      ];
      const selection = selectTasks(candidates, new Map(), options());
      expect(selection.picks.map((pick) => pick.task.id)).toEqual(["t1", "t2"]);
      expect(selection.deferrals).toEqual([
        { task: expect.objectContaining({ id: "t3" }), reason: "capacity" },
      ]);
      expect(selection.picks.every((pick) => pick.weight === 1)).toBe(true);
    });

    it("treats TASK_MAX_PARALLEL as a weighted budget and backfills decimals", () => {
      const candidates = [
        buildCandidate(buildTask({ id: "t1" })),
        buildCandidate(buildTask({ id: "t2" })),
        buildCandidate(
          buildTask({ id: "t3", description: "agent-weight: 0.25" }),
        ),
      ];
      const selection = selectTasks(
        candidates,
        new Map(),
        options({ maxParallel: 1.9 }),
      );
      // 1.0 fits, the second 1.0 does not (2 > 1.9) and the walk continues,
      // so the 0.25 task is still admitted (1.25 <= 1.9).
      expect(selection.picks.map((pick) => pick.task.id)).toEqual([
        "t1",
        "t3",
      ]);
      expect(selection.picks[1].weight).toBe(0.25);
      expect(selection.deferrals.map((deferral) => deferral.task.id)).toEqual([
        "t2",
      ]);
      expect(selection.deferrals[0].reason).toBe("capacity");
    });

    it("never runs more CLI processes than the budget count (ceil), whatever the weights", () => {
      const candidates = ["t1", "t2", "t3", "t4", "t5"].map((id) =>
        buildCandidate(
          buildTask({ id, description: "agent-weight: 0.25" }),
        ),
      );
      const selection = selectTasks(
        candidates,
        new Map(),
        options({ maxParallel: 1.9 }),
      );
      // 5 x 0.25 fits the 1.9 weight budget, but every task is one full CLI
      // process: the budget keeps running at most ceil(1.9) = 2 of them.
      expect(selection.picks.map((pick) => pick.task.id)).toEqual([
        "t1",
        "t2",
      ]);
      expect(selection.deferrals.map((deferral) => deferral.task.id)).toEqual([
        "t3",
        "t4",
        "t5",
      ]);
      expect(
        selection.deferrals.every(
          (deferral) => deferral.reason === "capacity",
        ),
      ).toBe(true);
    });

    it("counts the running tasks against the process cap even when they are small", () => {
      const candidates = ["t1", "t2", "t3"].map((id) =>
        buildCandidate(
          buildTask({ id, description: "agent-weight: 0.25" }),
        ),
      );
      const running = mapOf([
        buildRunning({ taskId: "r1", weight: 0.25 }),
      ]);
      const selection = selectTasks(
        candidates,
        running,
        options({ maxParallel: 2.5 }),
      );
      // The weight budget still has 1.75 free, but ceil(2.5) = 3 processes
      // minus the one already running leaves 2 process slots.
      expect(selection.picks.map((pick) => pick.task.id)).toEqual([
        "t1",
        "t2",
      ]);
      expect(selection.deferrals.map((deferral) => deferral.task.id)).toEqual([
        "t3",
      ]);
      expect(selection.deferrals[0].reason).toBe("capacity");
    });

    it("adds the picked weights and keys of the same round to the claimed state", () => {
      const candidates = [
        buildCandidate(
          buildTask({
            id: "t1",
            description: "agent-lock: repo:acme/web",
          }),
        ),
        buildCandidate(
          buildTask({
            id: "t2",
            description: "Work on https://github.com/acme/web",
          }),
        ),
      ];
      const selection = selectTasks(
        candidates,
        new Map(),
        options({ maxParallel: 5 }),
      );
      expect(selection.picks.map((pick) => pick.task.id)).toEqual(["t1"]);
      expect(selection.deferrals[0]).toEqual({
        task: expect.objectContaining({ id: "t2" }),
        reason: "conflict:repo:acme/web",
      });
    });

    it("does not block unrelated lower-priority tasks behind a conflicting one", () => {
      const candidates = [
        buildCandidate(
          buildTask({
            id: "t-high",
            priority: "high",
            description: "Work on https://github.com/acme/web",
          }),
        ),
        buildCandidate(buildTask({ id: "t-unrelated", priority: "low" })),
      ];
      const running = mapOf([
        buildRunning({ taskId: "r1", conflictKeys: ["repo:acme/web"] }),
      ]);
      const selection = selectTasks(
        candidates,
        running,
        options({ maxParallel: 5 }),
      );
      expect(selection.picks.map((pick) => pick.task.id)).toEqual([
        "t-unrelated",
      ]);
      expect(selection.deferrals[0].reason).toBe("conflict:repo:acme/web");
    });

    it("serializes the tasks of the same project in project mode", () => {
      const candidates = [
        buildCandidate(buildTask({ id: "t1" })),
        buildCandidate(buildTask({ id: "t2" })),
      ];
      const selection = selectTasks(
        candidates,
        new Map(),
        options({ maxParallel: 5, conflictMode: "project" }),
      );
      expect(selection.picks.map((pick) => pick.task.id)).toEqual(["t1"]);
      expect(selection.deferrals[0].reason).toBe("conflict:project:projects");
    });

    it("ignores the evaluator weight of the tasks with an explicit weight hint", () => {
      const candidates = [
        buildCandidate(buildTask({ id: "t1" }), {
          action: buildAction({ weight: 0.75 }),
        }),
      ];
      const evaluations = new Map([["t1", { weight: 0.25, conflicts: [], kind: "code-light" }]]);
      const selection = selectTasks(candidates, new Map(), {
        ...options({ maxParallel: 0.5 }),
        evaluations,
      });
      expect(selection.picks).toEqual([]);
      expect(selection.deferrals[0].reason).toBe("capacity");
    });

    it("uses the evaluator weight and normalized repo conflict keys of the hint-less tasks", () => {
      const candidates = [
        buildCandidate(buildTask({ id: "t1", description: "Some work" })),
      ];
      const evaluations = new Map([
        [
          "t1",
          {
            weight: 0.5,
            conflicts: ["repo:ACME/Web", "acme/api", "not a repo"],
            kind: "code-light",
          },
        ],
      ]);
      const selection = selectTasks(candidates, new Map(), {
        ...options({ maxParallel: 5 }),
        evaluations,
      });
      expect(selection.picks[0].weight).toBe(0.5);
      expect(selection.picks[0].conflictKeys).toEqual([
        "repo:acme/web",
        "repo:acme/api",
      ]);
    });

    it("respects the weight and conflict keys of the running tasks", () => {
      const candidates = [
        buildCandidate(buildTask({ id: "t1" })),
        buildCandidate(buildTask({ id: "t2" })),
      ];
      const running = mapOf([
        buildRunning({ taskId: "r1", weight: 1.5 }),
      ]);
      const selection = selectTasks(
        candidates,
        running,
        options({ maxParallel: 2.5 }),
      );
      // 1.5 + 1.0 fits exactly (2.5 <= 2.5), the second task does not.
      expect(selection.picks.map((pick) => pick.task.id)).toEqual(["t1"]);
      expect(selection.deferrals.map((deferral) => deferral.task.id)).toEqual([
        "t2",
      ]);
      expect(selection.deferrals[0].reason).toBe("capacity");
    });

    it("matches the kill-switch picks when every weight is the default", () => {
      const candidates = [
        buildCandidate(buildTask({ id: "t1" })),
        buildCandidate(buildTask({ id: "t2" })),
        buildCandidate(buildTask({ id: "t3" })),
      ];
      const smart = selectTasks(candidates, new Map(), options({ maxParallel: 2 }));
      const legacy = selectTasksLegacy(candidates, 2, 0);
      expect(smart.picks.map((pick) => pick.task.id)).toEqual(
        legacy.map((candidate) => candidate.task.id),
      );
    });
  });

  describe("selectTasksLegacy (kill switch)", () => {
    it("fills the free count-based slots from the queue order", () => {
      const candidates = [
        buildCandidate(buildTask({ id: "t1" })),
        buildCandidate(buildTask({ id: "t2" })),
        buildCandidate(buildTask({ id: "t3" })),
      ];
      expect(
        selectTasksLegacy(candidates, 2, 0).map((candidate) => candidate.task.id),
      ).toEqual(["t1", "t2"]);
      expect(
        selectTasksLegacy(candidates, 2, 1).map((candidate) => candidate.task.id),
      ).toEqual(["t1"]);
      expect(selectTasksLegacy(candidates, 2, 2)).toEqual([]);
    });

    it("ignores the weights completely", () => {
      const candidates = [
        buildCandidate(
          buildTask({ id: "t1", description: "agent-weight: 0.25" }),
        ),
        buildCandidate(buildTask({ id: "t2" })),
      ];
      expect(
        selectTasksLegacy(candidates, 2, 0).map((candidate) => candidate.task.id),
      ).toEqual(["t1", "t2"]);
    });
  });

  describe("selectEvaluationShortlist", () => {
    const options = (overrides: Record<string, unknown> = {}) => ({
      maxParallel: 1,
      conflictMode: "repo" as ConflictMode,
      ...overrides,
    });

    it("shortlists the hint-less candidates that could still be admitted", () => {
      const candidates = [
        buildCandidate(buildTask({ id: "t1" })),
        buildCandidate(buildTask({ id: "t2" })),
        buildCandidate(
          buildTask({ id: "t3", description: "agent-weight: 0.25" }),
        ),
      ];
      const shortlist = selectEvaluationShortlist(
        candidates,
        new Map(),
        options({ maxParallel: 2.5 }),
      );
      // Budget 2.5 and the process cap ceil(2.5) = 3: t1 and t2 are
      // evaluated (hint-less), the explicit 0.25 hint of t3 needs no
      // evaluation; with all three simulated the cap is reached.
      expect(shortlist.map((candidate) => candidate.task.id)).toEqual([
        "t1",
        "t2",
      ]);
    });

    it("stops shortlisting at the process cap of the round", () => {
      const candidates = ["t1", "t2", "t3"].map((id) =>
        buildCandidate(buildTask({ id })),
      );
      const shortlist = selectEvaluationShortlist(
        candidates,
        new Map(),
        options({ maxParallel: 1.9 }),
      );
      // Every 0.25-optimistic weight fits the 1.9 budget, but at most
      // ceil(1.9) = 2 CLI processes can run: only the first two candidates
      // can still be admitted this round, so only they are evaluated.
      expect(shortlist.map((candidate) => candidate.task.id)).toEqual([
        "t1",
        "t2",
      ]);
    });

    it("stops shortlisting when no candidate can fit the remaining budget", () => {
      const candidates = [
        buildCandidate(buildTask({ id: "t1" })),
        buildCandidate(buildTask({ id: "t2" })),
      ];
      const running = mapOf([buildRunning({ taskId: "r1", weight: 0.9 })]);
      const shortlist = selectEvaluationShortlist(
        candidates,
        running,
        options({ maxParallel: 1 }),
      );
      expect(shortlist).toEqual([]);
    });

    it("does not shortlist the statically conflicting or over-budget candidates", () => {
      const candidates = [
        buildCandidate(
          buildTask({
            id: "t-conflict",
            description: "Work on https://github.com/acme/web",
          }),
        ),
        buildCandidate(buildTask({ id: "t-fits" })),
        buildCandidate(buildTask({ id: "t-too-big" }), {
          action: buildAction({ weight: 0.75 }),
        }),
      ];
      const running = mapOf([
        buildRunning({
          taskId: "r1",
          weight: 0.25,
          conflictKeys: ["repo:acme/web"],
        }),
      ]);
      const shortlist = selectEvaluationShortlist(
        candidates,
        running,
        options({ maxParallel: 1.5 }),
      );
      // The process cap ceil(1.5) = 2 leaves one free slot (one task is
      // running): the conflicting candidate is skipped, the next one is
      // shortlisted and fills the slot.
      expect(shortlist.map((candidate) => candidate.task.id)).toEqual([
        "t-fits",
      ]);
    });
  });

  describe("config defenses", () => {
    it("falls back to the default budget on invalid hot-reloaded values", () => {
      expect(sanitizeBudget(1.9)).toBe(1.9);
      expect(sanitizeBudget(3)).toBe(3);
      expect(sanitizeBudget(0)).toBe(1);
      expect(sanitizeBudget(-1)).toBe(1);
      expect(sanitizeBudget(Number.NaN)).toBe(1);
    });

    it("derives the process cap from the budget", () => {
      expect(maxConcurrentTasks(1)).toBe(1);
      expect(maxConcurrentTasks(1.9)).toBe(2);
      expect(maxConcurrentTasks(2)).toBe(2);
      expect(maxConcurrentTasks(2.5)).toBe(3);
      expect(maxConcurrentTasks(0.5)).toBe(1);
      expect(maxConcurrentTasks(0)).toBe(1);
      expect(maxConcurrentTasks(Number.NaN)).toBe(1);
    });

    it("falls back to the repo mode on invalid hot-reloaded values", () => {
      for (const mode of TASK_CONFLICT_MODES) {
        expect(normalizeConflictMode(mode)).toBe(mode);
      }
      expect(normalizeConflictMode("everything")).toBe("repo");
      expect(normalizeConflictMode("")).toBe("repo");
    });
  });
});
