import * as fse from "fs-extra";
import { parse } from "yaml";

/**
 * One action of the agent: the tasks matching the project pattern and the
 * start status are processed with the optional model and instruction, then
 * moved to the end status. An empty project matches any project (used by
 * the legacy status-based fallback when no actions file is configured); a
 * non-empty project is a glob pattern where '*' matches any sequence of
 * characters (see matchProjectPattern). An empty model or instruction means
 * the corresponding feature is not set. The timeout is the task timeout in
 * seconds for the tasks of this action; null falls back to the actions
 * default timeout.
 */
export interface AgentAction {
  project: string;
  statusStart: string;
  statusEnd: string;
  model: string;
  instruction: string;
  timeout: number | null;
}

/**
 * The agent actions configuration: the default model applied to the
 * actions without their own model, the default task timeout (seconds)
 * applied to the actions without their own timeout, and the actions
 * themselves.
 */
export interface AgentActionsConfig {
  defaultModel: string;
  defaultTimeout: number | null;
  actions: AgentAction[];
}

/**
 * Parses and validates the agent actions YAML content. The format is
 * checked strictly so a misconfiguration fails fast at startup:
 *
 * default:
 *   model: <model name>
 *   timeout: <seconds>
 * actions:
 *   - project: <project pattern>
 *     status_start: <status name>
 *     status_end: <status name>
 *     model: <model name>
 *     instruction: <instruction>
 *     timeout: <seconds>
 *
 * 'default' and per-action 'model'/'instruction'/'timeout' are optional;
 * 'project' is optional too: a missing, null or empty project matches any
 * project, and a non-empty project is a glob pattern where '*' matches any
 * sequence of characters. Everything else is required and unknown fields
 * are rejected. Throws an Error listing every problem found when the
 * configuration is invalid.
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
        if (key !== "model" && key !== "timeout") {
          errors.push(`Unknown 'default' field '${key}'`);
        }
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
    }
  }

  if (root.actions === undefined) {
    errors.push("'actions' is required");
  } else if (!Array.isArray(root.actions)) {
    errors.push("'actions' must be a list");
  } else {
    const seen = new Set<string>();
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
            "status_start",
            "status_end",
            "model",
            "instruction",
            "timeout",
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
      if (statusStart !== null) {
        const key = `${project}\n${statusStart}`;
        if (seen.has(key)) {
          errors.push(
            `actions[${index}] duplicates the project '${project}' and status_start '${statusStart}' of a previous action`,
          );
        } else {
          seen.add(key);
        }
      }
      if (statusStart !== null && statusEnd !== null) {
        config.actions.push({
          project: project,
          statusStart: statusStart,
          statusEnd: statusEnd,
          model: model ?? "",
          instruction: instruction ?? "",
          timeout: timeout,
        });
      }
    });
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
 */
export function matchProjectPattern(
  pattern: string,
  projectName: string,
): boolean {
  if (pattern.length === 0) {
    return true;
  }
  const regex = new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return regex.test(projectName);
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
