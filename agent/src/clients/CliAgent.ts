import type { PlannerTask } from "../PlannerClient";

// Task execution options coming from the matching action of the agent
// actions configuration: the model is the action model or the actions
// default model, the instruction is prepended to the task information and
// the timeout is the effective task timeout in seconds (action timeout,
// then actions default.timeout; missing values fall back to the global
// TASK_TIMEOUT configuration). The cwd is the per-task working directory
// (each task runs in its own directory so parallel tasks never share one).
export interface TaskOptions {
  model?: string;
  instruction?: string;
  timeoutSeconds?: number;
  cwd?: string;
}

// Options of a standalone prompt: the model overrides the actions default
// model and the timeout bounds the CLI call.
export interface PromptOptions {
  model?: string;
  timeoutMs?: number;
}

/**
 * A coding-agent CLI able to execute the tasks assigned by Planner. Every
 * supported CLI (Qoder, Claude Code, Copilot CLI, Codex, Gemini CLI)
 * implements this interface; the shared behavior lives in BaseCliAgent.
 */
export interface CliAgentClient {
  // Registry name of the CLI (e.g. "qoder", "claude-code").
  readonly name: string;
  // Human-readable name used in logs and error messages.
  readonly displayName: string;
  // Guidance displayed when the startup authentication check fails.
  readonly authHint: string;
  checkAuthentication(): Promise<void>;
  performTask(
    task: PlannerTask,
    notesFile: string,
    options?: TaskOptions,
  ): Promise<string>;
  runPrompt(prompt: string, options?: PromptOptions): Promise<string>;
  // Models available to the account, or null when the CLI cannot list them
  // (model validation is then skipped).
  listModels(): Promise<string[] | null>;
  // The usage metric of the last run (credits, cost, ...), or null when the
  // CLI does not report one.
  readUsage(): Promise<number | null>;
  // Human-readable usage fact for the agent note.
  usageSummary(): Promise<string>;
}
