import { AgentAction, AgentActionsConfig, matchProjectPattern } from "./AgentActions";
import { PlannerProject } from "./PlannerClient";

// Bound of the projects listed in one aggregate warning.
const MAX_PROJECTS_LISTED = 10;

export interface ConfiguredStatusUsage {
  // Configuration path the status comes from (e.g. "actions[0].status_end").
  setting: string;
  status: string;
}

/**
 * Whether a project is known to expose a status. A project without a status
 * catalog (an older Planner, or a project whose catalog was not reported)
 * is "unknown": the status is accepted and no warning is emitted, matching
 * the existing degradation of the in-progress transition.
 */
export function projectHasStatus(
  project: PlannerProject | null | undefined,
  status: string,
): boolean {
  if (!project?.statuses || project.statuses.length === 0) {
    return true;
  }
  return project.statuses.includes(status);
}

/**
 * The statuses an action relies on, with the configuration path they are
 * resolved from. Comments-mode actions ignore the error and in-progress
 * statuses (they never move the task), so those are skipped; the abort
 * status stays honored in both modes.
 */
export function configuredStatusUsages(
  action: AgentAction,
  index: number,
  defaults: AgentActionsConfig,
): ConfiguredStatusUsage[] {
  const usages: ConfiguredStatusUsage[] = [
    {
      setting: `actions[${index}].status_start`,
      status: action.statusStart,
    },
  ];
  if (action.trigger !== "comments") {
    if (action.statusEnd) {
      usages.push({
        setting: `actions[${index}].status_end`,
        status: action.statusEnd,
      });
    }
    const errorStatus =
      action.statusError ??
      defaults.defaultStatusError ??
      action.statusEnd;
    if (errorStatus) {
      usages.push({
        setting: action.statusError
          ? `actions[${index}].status_error`
          : defaults.defaultStatusError
            ? "default.status_error"
            : `actions[${index}].status_end (used as the error status)`,
        status: errorStatus,
      });
    }
    const inProgressStatus =
      action.statusInProgress ?? defaults.defaultStatusInProgress;
    if (inProgressStatus) {
      usages.push({
        setting: action.statusInProgress
          ? `actions[${index}].status_in_progress`
          : "default.status_in_progress",
        status: inProgressStatus,
      });
    }
  }
  const abortStatus = action.statusAbort ?? defaults.defaultStatusAbort;
  if (abortStatus) {
    usages.push({
      setting: action.statusAbort
        ? `actions[${index}].status_abort`
        : "default.status_abort",
      status: abortStatus,
    });
  }
  return usages;
}

/**
 * The warnings for configured statuses that a project status catalog does
 * not contain: one warning per action status missing from a project the
 * action applies to, and one aggregate warning for the projects whose
 * catalog lacks the dependency satisfied status (a dependency can point
 * into any project). A project without a catalog is never reported.
 */
export function buildStatusWarnings(
  actions: AgentAction[],
  defaults: AgentActionsConfig,
  dependencyStatus: string,
  projects: PlannerProject[],
): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();
  actions.forEach((action, index) => {
    for (const usage of configuredStatusUsages(action, index, defaults)) {
      for (const project of projects) {
        if (
          !matchProjectPattern(action.project, project.name) ||
          projectHasStatus(project, usage.status)
        ) {
          continue;
        }
        const key = `${usage.setting}\n${usage.status}\n${project.id}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        warnings.push(
          `Configured status '${usage.status}' (${usage.setting}) does not exist in the status catalog of project '${project.name}' (statuses: ${project.statuses!.join(", ")})`,
        );
      }
    }
  });

  const missingDependencyProjects = projects.filter(
    (project) =>
      project.statuses !== undefined &&
      project.statuses.length > 0 &&
      !project.statuses.includes(dependencyStatus),
  );
  if (missingDependencyProjects.length > 0) {
    const names = missingDependencyProjects
      .slice(0, MAX_PROJECTS_LISTED)
      .map((project) => `'${project.name}'`)
      .join(", ");
    const suffix =
      missingDependencyProjects.length > MAX_PROJECTS_LISTED
        ? ` and ${missingDependencyProjects.length - MAX_PROJECTS_LISTED} more`
        : "";
    warnings.push(
      `Dependency satisfied status '${dependencyStatus}' (TASK_DEPENDENCY_SATISFIED_STATUS) does not exist in the status catalog of project(s) ${names}${suffix}: dependencies completed with another status keep the dependent tasks blocked`,
    );
  }

  return warnings;
}
