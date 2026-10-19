import * as fse from "fs-extra";
import { parse } from "yaml";
import { CLI_AGENT_NAMES } from "./Config";

/**
 * One action of the agent: the tasks matching the project pattern and the
 * start status are processed with the optional model and instruction, then
 * moved to the end status. An empty project matches any project (used by
 * the legacy status-based fallback when no actions file is configured); a
 * non-empty project is a glob pattern where '*' matches any sequence of
 * characters (see matchProjectPattern). An empty model or instruction means
 * the corresponding feature is not set. The timeout is the task timeout in
 * seconds for the tasks of this action; null falls back to the actions
 * default timeout. The weight is the scheduling weight (task units) of the
 * tasks of this action in the weighted budget (see the Scheduler module);
 * null falls back to the default weight. The statusError is the status a
 * failed task is moved to; when not set it falls back to the actions
 * default status error, then to the end status. The statusInProgress is the
 * optional status a task is moved to while it is being processed; when not
 * set it falls back to the actions default status in progress (no
 * transition when neither is set). The statusAbort is the optional status
 * that cancels a running task when a user moves the task to it on Planner;
 * when not set it falls back to the actions default status abort. The
 * priority is the queue priority of the tasks of this action; when not set
 * the task's own Planner priority applies. The trigger selects the mode of
 * the action: 'status' (the default pipeline: the task is moved to the end
 * status once processed) or 'comments' (conversational: the agent never
 * changes the task status and re-processes it every time a new user
 * comment lands; statusEnd is then null).
 */
export interface AgentAction {
  project: string;
  statusStart: string;
  // End status the task is moved to once processed; null only in the
  // comments mode, where the agent never moves the task.
  statusEnd: string | null;
  trigger: "status" | "comments";
  agent?: string;
  statusError?: string;
  statusInProgress?: string;
  statusAbort?: string;
  priority?: string;
  model: string;
  instruction: string;
  timeout: number | null;
  weight: number | null;
}

/**
 * The agent actions configuration: the default model applied to the
 * actions without their own model, the default task timeout (seconds)
 * applied to the actions without their own timeout, the default statuses
 * applied to the actions without their own status error / in-progress /
 * abort status, the named instruction templates the actions can reference,
 * and the actions themselves.
 */
export interface AgentActionsConfig {
  defaultAgent?: string;
  defaultModel: string;
  defaultStatusError?: string;
  defaultStatusInProgress?: string;
  defaultStatusAbort?: string;
  defaultTimeout: number | null;
  instructions?: Record<string, string>;
  actions: AgentAction[];
}

/**
 * Parses and validates the agent actions YAML content. The format is
 * checked strictly so a misconfiguration fails fast at startup:
 *
 * instructions:
 *   <template name>: <instruction text>
 * default:
 *   agent: <CLI agent name>
 *   model: <model name>
 *   timeout: <seconds>
 *   status_error: <status name>
 *   status_in_progress: <status name>
 *   status_abort: <status name>
 * actions:
 *   - project: <project pattern>
 *     trigger: <status|comments>
 *     status_start: <status name>
 *     status_end: <status name>
 *     status_error: <status name>
 *     status_in_progress: <status name>
 *     status_abort: <status name>
 *     agent: <CLI agent name>
 *     model: <model name>
 *     instruction: <instruction or template name>
 *     timeout: <seconds>
 *     weight: <number>
 *     priority: <high|medium|low>
 *
 * 'default' and per-action 'agent'/'model'/'instruction'/'timeout'/'weight'/
 * 'status_error'/'status_in_progress'/'status_abort'/'priority'/'trigger'
 * are optional; 'project' is optional too: a missing, null or
 * empty project matches any project, and a non-empty project is a glob
 * pattern where '*' matches any sequence of characters. The optional
 * 'instructions' root mapping defines named instruction templates: an
 * action 'instruction' value that exactly matches a template name resolves
 * to the template content, any other value is used verbatim as an inline
 * instruction. The optional 'trigger' selects the mode of the action:
 * 'status' (the default) is the pipeline above; 'comments' is the
 * conversational mode, where the agent never changes the task status and
 * re-processes it on every new user comment — 'status_end' is then
 * forbidden and must stay unset, as must 'status_error' and
 * 'status_in_progress' (a status move would break the conversation), while
 * 'status_abort' stays honored (user-initiated cancellation). A comments
 * action sharing a start status and overlapping project patterns with a
 * pipeline action is rejected. Everything else is required and unknown
 * fields are rejected.
 * Throws an Error listing every problem found when the configuration is
 * invalid.
 */
export function parseAgentActions(content: string): AgentActionsConfig {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch (error) {
    throw new Error(`Invalid YAML: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (parsed === null || parsed === undefined) {
    throw new Error("The configuration is empty");
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "The configuration must be a mapping with 'default' and 'actions'",
    );
  }
  const root = parsed as Record<string, unknown>;

  const errors: string[] = [];
  const config: AgentActionsConfig = {
    defaultModel: "",
    defaultTimeout: null,
    actions: [],
  };

  const instructions = readInstructions(root, errors);
  if (instructions !== null) {
    config.instructions = instructions;
  }

  if (root.default !== undefined) {
    if (
      typeof root.default !== "object" ||
      root.default === null ||
      Array.isArray(root.default)
    ) {
      errors.push("'default' must be a mapping");
    } else {
      const defaults = root.default as Record<string, unknown>;
      for (const key of Object.keys(defaults)) {
        if (
          key !== "agent" &&
          key !== "model" &&
          key !== "timeout" &&
          key !== "status_error" &&
          key !== "status_in_progress" &&
          key !== "status_abort"
        ) {
          errors.push(`Unknown 'default' field '${key}'`);
        }
      }
      const agent = readAgent(
        defaults,
        "agent",
        "default.agent",
        errors,
      );
      if (agent !== null) {
        config.defaultAgent = agent;
      }
      const model = defaults.model;
      if (model !== undefined) {
        if (typeof model !== "string" || model.trim().length === 0) {
          errors.push("'default.model' must be a non-empty string");
        } else {
          config.defaultModel = model.trim();
        }
      }
      const timeout = readPositiveInteger(
        defaults,
        "timeout",
        "default.timeout",
        errors,
      );
      if (timeout !== null) {
        config.defaultTimeout = timeout;
      }
      const statusError = readString(
        defaults,
        "status_error",
        "default.status_error",
        errors,
        true,
      );
      if (statusError !== null) {
        config.defaultStatusError = statusError;
      }
      const statusInProgress = readString(
        defaults,
        "status_in_progress",
        "default.status_in_progress",
        errors,
        true,
      );
      if (statusInProgress !== null) {
        config.defaultStatusInProgress = statusInProgress;
      }
      const statusAbort = readString(
        defaults,
        "status_abort",
        "default.status_abort",
        errors,
        true,
      );
      if (statusAbort !== null) {
        config.defaultStatusAbort = statusAbort;
      }
    }
  }

  if (root.actions === undefined) {
    errors.push("'actions' is required");
  } else if (!Array.isArray(root.actions)) {
    errors.push("'actions' must be a list");
  } else {
    const seen = new Set<string>();
    // Parsed actions with their index in the YAML: the cross-action rules
    // below report the original indexes even when some entries failed to
    // parse and were not pushed.
    const parsed: { index: number; action: AgentAction }[] = [];
    root.actions.forEach((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        errors.push(`actions[${index}] must be a mapping`);
        return;
      }
      const action = entry as Record<string, unknown>;
      for (const key of Object.keys(action)) {
        if (
          ![
            "project",
            "trigger",
            "status_start",
            "status_end",
            "status_error",
            "status_in_progress",
            "status_abort",
            "agent",
            "model",
            "instruction",
            "timeout",
            "weight",
            "priority",
          ].includes(key)
        ) {
          errors.push(`actions[${index}] has unknown field '${key}'`);
        }
      }
      const project = readProjectPattern(
        action,
        `actions[${index}].project`,
        errors,
      );
      const trigger = readTrigger(
        action,
        "trigger",
        `actions[${index}].trigger`,
        errors,
      );
      const statusStart = readString(
        action,
        "status_start",
        `actions[${index}].status_start`,
        errors,
      );
      const statusEnd = readString(
        action,
        "status_end",
        `actions[${index}].status_end`,
        errors,
        true,
      );
      const statusError = readString(
        action,
        "status_error",
        `actions[${index}].status_error`,
        errors,
        true,
      );
      const statusInProgress = readString(
        action,
        "status_in_progress",
        `actions[${index}].status_in_progress`,
        errors,
        true,
      );
      // Mode-specific rules (strict fail-fast, like the rest of the
      // schema): a comments action never moves the task, so any status
      // transition field contradicts the mode — except status_abort, which
      // stays honored as the user-initiated cancellation.
      if (trigger === "comments") {
        if (statusEnd !== null) {
          errors.push(
            `'actions[${index}].status_end' must not be set in comments mode (a set end status contradicts 'trigger: comments'; the agent never changes the task status)`,
          );
        }
        if (statusError !== null) {
          errors.push(
            `'actions[${index}].status_error' must not be set in comments mode (the agent never changes the task status; failures are reported as a comment)`,
          );
        }
        if (statusInProgress !== null) {
          errors.push(
            `'actions[${index}].status_in_progress' must not be set in comments mode (the agent never changes the task status)`,
          );
        }
      } else if (statusStart !== null && statusEnd === null) {
        errors.push(`'actions[${index}].status_end' is required`);
      }
      const statusAbort = readString(
        action,
        "status_abort",
        `actions[${index}].status_abort`,
        errors,
        true,
      );
      const agent = readAgent(
        action,
        "agent",
        `actions[${index}].agent`,
        errors,
      );
      const model = readString(
        action,
        "model",
        `actions[${index}].model`,
        errors,
        true,
      );
      const instruction = readString(
        action,
        "instruction",
        `actions[${index}].instruction`,
        errors,
        true,
      );
      const timeout = readPositiveInteger(
        action,
        "timeout",
        `actions[${index}].timeout`,
        errors,
      );
      const weight = readPositiveWeight(
        action,
        "weight",
        `actions[${index}].weight`,
        errors,
      );
      const priority = readPriority(
        action,
        "priority",
        `actions[${index}].priority`,
        errors,
      );
      if (statusStart !== null) {
        // Same-mode duplicates are rejected outright; a cross-mode pair
        // (same project and start status) passes this check so the more
        // specific competition rule below reports it.
        const key = `${project}\n${statusStart}\n${trigger}`;
        if (seen.has(key)) {
          errors.push(
            `actions[${index}] duplicates the project '${project}' and status_start '${statusStart}' of a previous action`,
          );
        } else {
          seen.add(key);
        }
      }
      if (statusStart !== null && (statusEnd !== null || trigger === "comments")) {
        const action: AgentAction = {
          project: project,
          statusStart: statusStart,
          statusEnd: statusEnd,
          trigger: trigger,
          ...(statusError === null ? {} : { statusError }),
          ...(statusInProgress === null ? {} : { statusInProgress }),
          ...(statusAbort === null ? {} : { statusAbort }),
          ...(agent === null ? {} : { agent }),
          ...(priority === null ? {} : { priority }),
          model: model ?? "",
          instruction: resolveInstruction(instruction, instructions) ?? "",
          timeout: timeout,
          weight: weight,
        };
        config.actions.push(action);
        parsed.push({ index, action });
      }
    });
    // A comments action must not ambiguously compete with a pipeline action
    // on the same start status: when both match the same task, the "first
    // matching action wins" rule would silently turn one mode or the other
    // off. Two comments actions overlapping stays allowed (the first one
    // wins, like the documented overlapping pipeline patterns).
    for (let i = 0; i < parsed.length; i++) {
      for (let j = i + 1; j < parsed.length; j++) {
        const first = parsed[i].action;
        const second = parsed[j].action;
        if (
          first.trigger === second.trigger ||
          first.statusStart !== second.statusStart ||
          !projectPatternsMayOverlap(first.project, second.project)
        ) {
          continue;
        }
        const comments =
          first.trigger === "comments" ? parsed[i] : parsed[j];
        const pipeline =
          first.trigger === "comments" ? parsed[j] : parsed[i];
        errors.push(
          `actions[${comments.index}] (trigger: comments) competes with actions[${pipeline.index}] (status pipeline): both match the status_start '${comments.action.statusStart}' and overlapping project patterns; a comments action must not ambiguously compete with a pipeline action`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      [
        "Invalid agent actions configuration:",
        ...errors.map((error) => `  - ${error}`),
      ].join("\n"),
    );
  }
  return config;
}

/**
 * Loads and parses the agent actions file. Returns null when the file does
 * not exist (the agent then runs without any action and processes no task);
 * throws an Error when the file exists but is invalid, so the caller can
 * fail fast at startup.
 */
export async function loadAgentActions(
  filePath: string,
): Promise<AgentActionsConfig | null> {
  if (!(await fse.pathExists(filePath))) {
    return null;
  }
  return parseAgentActions(await fse.readFile(filePath, "utf8"));
}

/**
 * Whether a project name matches an action project pattern. An empty
 * pattern matches any project; otherwise the pattern is a glob with '*'
 * wildcards only ('*' matches any sequence of characters, including the
 * empty one) matched in full and case-sensitively.
 *
 * Implemented as a greedy linear scan with a single backtrack point instead
 * of a RegExp so a pathological pattern cannot backtrack exponentially
 * (ReDoS).
 */
export function matchProjectPattern(
  pattern: string,
  projectName: string,
): boolean {
  if (pattern.length === 0) {
    return true;
  }
  let g = 0;
  let v = 0;
  // Index of the last '*' seen in the glob and the value position that
  // followed its (initially empty) match; on a mismatch the retry lets that
  // '*' swallow one more character.
  let starG = -1;
  let starV = 0;
  while (v < projectName.length) {
    if (g < pattern.length && pattern[g] === "*") {
      starG = g;
      starV = v;
      g++;
    } else if (g < pattern.length && pattern[g] === projectName[v]) {
      g++;
      v++;
    } else if (starG !== -1) {
      // Retry: the last '*' swallows one more character; the scan resumes
      // just after the star.
      g = starG + 1;
      v = starV + 1;
      starV++;
    } else {
      return false;
    }
  }
  while (g < pattern.length && pattern[g] === "*") {
    g++;
  }
  return g === pattern.length;
}

/**
 * Whether two project patterns can match the same project: an exact
 * language-intersection test over the restricted glob language of
 * matchProjectPattern (only the '*' wildcard, full-string, case-sensitive).
 * An empty pattern matches any project, so it overlaps everything.
 *
 * Implemented as a synchronized walk over the state (i, j) = positions in
 * both patterns, i.e. the product of the two pattern automata: a '*' also
 * matches the empty sequence (epsilon-moves), and both patterns consume one
 * common character together — equal literals, or a '*' absorbing it while
 * it stays on itself to keep absorbing (and possibly ends later). Reaching
 * the end of both patterns means a common project exists. The visited
 * states are memoized, so the worst case is linear in the product of the
 * pattern lengths.
 */
export function projectPatternsMayOverlap(
  p1: string,
  p2: string,
): boolean {
  if (p1.length === 0 || p2.length === 0) {
    return true;
  }
  const visited = new Set<string>();
  const stack: [number, number][] = [[0, 0]];
  while (stack.length > 0) {
    const [i, j] = stack.pop()!;
    const key = `${i}:${j}`;
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);
    if (i === p1.length && j === p2.length) {
      return true;
    }
    const star1 = i < p1.length && p1[i] === "*";
    const star2 = j < p2.length && p2[j] === "*";
    // A '*' can also match the empty sequence: skip it on either side.
    if (star1) {
      stack.push([i + 1, j]);
    }
    if (star2) {
      stack.push([i, j + 1]);
    }
    // Both patterns consume one common character: equal literals, or a '*'
    // on either side — absorbing it while staying on itself (it may keep
    // absorbing) or ending right after it.
    if (i < p1.length && j < p2.length) {
      if (star1 && !star2) {
        stack.push([i, j + 1]);
      }
      if (!star1 && star2) {
        stack.push([i + 1, j]);
      }
      if (star1 || star2 || p1[i] === p2[j]) {
        stack.push([i + 1, j + 1]);
      }
    }
  }
  return false;
}

// Reads the optional project pattern of an action: a missing, null or
// empty value normalizes to '' (= matches any project). A non-string value
// always produces a validation error so typos fail fast at startup.
function readProjectPattern(
  action: Record<string, unknown>,
  label: string,
  errors: string[],
): string {
  const value = action.project;
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    errors.push(`'${label}' must be a string`);
    return "";
  }
  return value.trim();
}

// Reads the optional mode of an action: 'status' (the default pipeline
// behavior when missing) or 'comments' (conversational). Missing fields
// report the default; values are compared case-insensitively after
// trimming. An empty, non-string or unsupported value always produces a
// validation error so typos fail fast at startup.
function readTrigger(
  source: Record<string, unknown>,
  field: string,
  label: string,
  errors: string[],
): "status" | "comments" {
  const value = source[field];
  if (value === undefined) {
    return "status";
  }
  const raw = typeof value === "string" ? value.trim() : String(value);
  const trigger = raw.toLowerCase();
  if (trigger !== "status" && trigger !== "comments") {
    errors.push(
      `'${label}' must be 'status' or 'comments' (current value: '${raw}')`,
    );
    return "status";
  }
  return trigger;
}

// Reads a required string field; optional fields report 'not set' (null)
// when missing instead of an error. Empty or non-string values always
// produce a validation error so typos fail fast at startup.
function readString(
  action: Record<string, unknown>,
  field: string,
  label: string,
  errors: string[],
  optional = false,
): string | null {
  const value = action[field];
  if (value === undefined) {
    if (optional) {
      return null;
    }
    errors.push(`'${label}' is required`);
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`'${label}' must be a non-empty string`);
    return null;
  }
  return value.trim();
}

function readAgent(
  source: Record<string, unknown>,
  field: string,
  label: string,
  errors: string[],
): string | null {
  const agent = readString(source, field, label, errors, true);
  if (agent === null) {
    return null;
  }
  const selector = agent.toLowerCase();
  if (!CLI_AGENT_NAMES.includes(selector as (typeof CLI_AGENT_NAMES)[number])) {
    errors.push(
      `'${label}' must be one of ${CLI_AGENT_NAMES.join(", ")} (current value: '${agent}')`,
    );
    return null;
  }
  return selector;
}

// Reads an optional queue priority of an action: high, medium or low
// (case-insensitive). Missing fields report 'not set' (null). An empty,
// non-string or unsupported value always produces a validation error so
// typos fail fast at startup.
function readPriority(
  source: Record<string, unknown>,
  field: string,
  label: string,
  errors: string[],
): string | null {
  const value = source[field];
  if (value === undefined) {
    return null;
  }
  const raw = typeof value === "string" ? value.trim() : String(value);
  const priority = raw.toLowerCase();
  if (!["high", "medium", "low"].includes(priority)) {
    errors.push(
      `'${label}' must be one of high, medium, low (current value: '${raw}')`,
    );
    return null;
  }
  return priority;
}

// Reads an optional positive integer field (a timeout in seconds); missing
// fields report 'not set' (null). Non-integer, zero, negative or float
// values always produce a validation error so typos fail fast at startup.
function readPositiveInteger(
  source: Record<string, unknown>,
  field: string,
  label: string,
  errors: string[],
): number | null {
  const value = source[field];
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    errors.push(`'${label}' must be a positive integer (seconds)`);
    return null;
  }
  return value;
}

// Reads an optional scheduling weight (a number in (0, 1]); missing fields
// report 'not set' (null). Zero, negative, non-finite or values above 1
// always produce a validation error so typos fail fast at startup.
function readPositiveWeight(
  source: Record<string, unknown>,
  field: string,
  label: string,
  errors: string[],
): number | null {
  const value = source[field];
  if (value === undefined) {
    return null;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > 1
  ) {
    errors.push(`'${label}' must be a number greater than 0 and at most 1`);
    return null;
  }
  return value;
}

// Reads the optional top-level instruction templates: a mapping of template
// names to instruction texts. A missing or null 'instructions' key reports
// 'not set' (null); a non-mapping value or an empty/blank template always
// produces a validation error so typos fail fast at startup.
function readInstructions(
  root: Record<string, unknown>,
  errors: string[],
): Record<string, string> | null {
  const value = root.instructions;
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    errors.push(
      "'instructions' must be a mapping of template names to instruction texts",
    );
    return null;
  }
  const templates: Record<string, string> = {};
  for (const [name, content] of Object.entries(value as Record<string, unknown>)) {
    if (typeof content !== "string" || content.trim().length === 0) {
      errors.push(`'instructions.${name}' must be a non-empty string`);
      continue;
    }
    templates[name] = content.trim();
  }
  return Object.keys(templates).length > 0 ? templates : null;
}

// An action instruction that exactly matches a template name resolves to
// the template content; any other value is used verbatim as an inline
// instruction (backward compatible).
function resolveInstruction(
  instruction: string | null,
  templates: Record<string, string> | null,
): string | null {
  if (instruction === null || templates === null) {
    return instruction;
  }
  return templates[instruction] ?? instruction;
}
