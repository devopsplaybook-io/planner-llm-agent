import { AgentActionsManager } from "./AgentActionsManager";

// Offline validation of the agent actions file: loads and validates the
// YAML (strictly, exactly like the agent startup does) and prints the
// resolved configuration — defaults, instruction templates and every
// action with its statuses, agent, model, timeout, weight and priority —
// without connecting to Planner and without processing any task. Exit code
// 0 when the file is valid (or missing, which is a valid state), 1 when
// the file exists but is invalid.
//
// Run with the npm script (npm run check-config) or against the compiled
// output in the container (node dist/checkConfig.js). The file location
// follows AGENT_ACTIONS_FILE (default /etc/planner/llm-agent.yaml).
const INSTRUCTION_EXCERPT_LENGTH = 80;

function firstLine(text: string): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > INSTRUCTION_EXCERPT_LENGTH
    ? `${line.slice(0, INSTRUCTION_EXCERPT_LENGTH)}...`
    : line;
}

function describeAction(action: {
  project: string;
  statusStart: string;
  statusEnd: string | null;
  trigger: "status" | "comments";
  statusError?: string;
  statusInProgress?: string;
  statusAbort?: string;
  agent?: string;
  model: string;
  instruction: string;
  timeout: number | null;
  weight: number | null;
  priority?: string;
}): string[] {
  const project =
    action.project.length > 0 ? `'${action.project}'` : "(any project)";
  // The mode is visible in the action line itself: a comments action never
  // moves the task, so the end status is replaced by the mode description.
  const target =
    action.trigger === "comments"
      ? "(comments: no status change, re-runs on new user comments)"
      : action.statusEnd;
  const details = [
    ...(action.trigger === "comments" ? ["trigger: comments"] : []),
    `agent: ${action.agent ?? "(default)"}`,
    `model: ${action.model.length > 0 ? action.model : "(default)"}`,
    `timeout: ${action.timeout !== null ? `${action.timeout}s` : "(default)"}`,
    `weight: ${action.weight !== null ? String(action.weight) : "auto"}`,
    `priority: ${action.priority ?? "(task)"}`,
    `status_error: ${action.statusError ?? "(default)"}`,
    `status_in_progress: ${action.statusInProgress ?? "(none)"}`,
    `status_abort: ${action.statusAbort ?? "(none)"}`,
  ];
  const lines = [
    `${project}: ${action.statusStart} -> ${target}`,
    details.join(" | "),
  ];
  if (action.instruction.trim().length > 0) {
    lines.push(`  instruction: ${firstLine(action.instruction)}`);
  }
  return lines;
}

async function main(): Promise<number> {
  const filePath =
    process.env.AGENT_ACTIONS_FILE || "/etc/planner/llm-agent.yaml";
  console.log(`Validating agent actions file '${filePath}'...`);
  const manager = new AgentActionsManager(filePath);
  let config;
  try {
    config = await manager.load();
  } catch (error) {
    // The message already lists every problem found, one per line.
    console.error((error as Error).message);
    return 1;
  }
  if (config === null) {
    console.log(
      `File not found: the agent would start with no action and process no task.`,
    );
    return 0;
  }
  console.log(`Configuration is valid (${config.actions.length} action(s)).`);
  console.log("");
  console.log("Defaults:");
  console.log(
    [
      `  agent: ${config.defaultAgent ?? "(AGENT_CLI)"}`,
      `  model: ${config.defaultModel.length > 0 ? config.defaultModel : "(CLI default)"}`,
      `  timeout: ${config.defaultTimeout !== null ? `${config.defaultTimeout}s` : "(TASK_TIMEOUT)"}`,
      `  status_error: ${config.defaultStatusError ?? "(end status)"}`,
      `  status_in_progress: ${config.defaultStatusInProgress ?? "(none)"}`,
      `  status_abort: ${config.defaultStatusAbort ?? "(none)"}`,
    ].join("\n"),
  );
  const templates = Object.keys(config.instructions ?? {});
  console.log(
    `  instruction templates: ${templates.length > 0 ? templates.join(", ") : "(none)"}`,
  );
  if (config.actions.length === 0) {
    return 0;
  }
  console.log("");
  console.log("Actions:");
  config.actions.forEach((action, index) => {
    const lines = describeAction(action);
    console.log(`${index + 1}. ${lines[0]}`);
    for (const line of lines.slice(1)) {
      console.log(`   ${line.trimStart()}`);
    }
  });
  return 0;
}

main().then((exitCode) => {
  process.exitCode = exitCode;
});
