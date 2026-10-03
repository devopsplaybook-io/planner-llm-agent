// Keeps the test suite hermetic: the ambient environment variables of the
// runtime environment (the agent container defines many of them) must never
// influence the tests. Every variable relevant to the configuration is
// deleted before each test; suites whose beforeEach restores a snapshot of
// the ambient environment call clearConfigEnvironment() again afterwards.
const ENV_VARIABLE_PREFIXES = [
  "AGENT_",
  "TASK_",
  "PLANNER_",
  "QODER_",
  "CLAUDE_",
  "COPILOT_",
  "CODEX_",
  "GEMINI_",
  "GITHUB_",
  "GH_TOKEN",
  "GIT_",
  "OPENTELEMETRY_",
];

const ENV_VARIABLE_NAMES = [
  "DATA_DIR",
  "TMP_DIR",
  "DEV_MODE",
  "CONFIG_FILE",
  "GNUPGHOME",
  "GIT_TERMINAL_PROMPT",
];

export function clearConfigEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (
      ENV_VARIABLE_NAMES.includes(key) ||
      ENV_VARIABLE_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      delete process.env[key];
    }
  }
}

beforeEach(() => {
  clearConfigEnvironment();
});
