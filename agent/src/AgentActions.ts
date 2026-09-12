import * as fse from "fs-extra";
import { parse } from "yaml";

/**
 * One action of the agent: the tasks matching the project and the start
 * status are processed with the optional model and instruction, then moved
 * to the end status. An empty project matches any project (used by the
 * legacy status-based fallback when no actions file is configured); an
 * empty model or instruction means the corresponding feature is not set.
 */
export interface AgentAction {
  project: string;
  statusStart: string;
  statusEnd: string;
  model: string;
  instruction: string;
}

/**
 * The agent actions configuration: the default model applied to the
 * actions without their own model, and the actions themselves.
 */
export interface AgentActionsConfig {
  defaultModel: string;
  actions: AgentAction[];
}

/**
 * Parses and validates the agent actions YAML content. The format is
 * checked strictly so a misconfiguration fails fast at startup:
 *
 * default:
 *   model: <model name>
 * actions:
 *   - project: <project name>
 *     status_start: <status name>
 *     status_end: <status name>
 *     model: <model name>
 *     instruction: <instruction>
 *
 * 'default' and per-action 'model'/'instruction' are optional; everything
 * else is required and unknown fields are rejected. Throws an Error
 * listing every problem found when the configuration is invalid.
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
  const config: AgentActionsConfig = { defaultModel: "", actions: [] };

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
        if (key !== "model") {
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
          ].includes(key)
        ) {
          errors.push(`actions[${index}] has unknown field '${key}'`);
        }
      }
      const project = readString(
        action,
        "project",
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
      if (project !== null && statusStart !== null) {
        const key = `${project}\n${statusStart}`;
        if (seen.has(key)) {
          errors.push(
            `actions[${index}] duplicates the project '${project}' and status_start '${statusStart}' of a previous action`,
          );
        } else {
          seen.add(key);
        }
      }
      if (project !== null && statusStart !== null && statusEnd !== null) {
        config.actions.push({
          project: project,
          statusStart: statusStart,
          statusEnd: statusEnd,
          model: model ?? "",
          instruction: instruction ?? "",
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
