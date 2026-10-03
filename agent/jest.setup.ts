// Hermetic test environment (L1): ambient environment variables (e.g. a
// real AGENT_NOTE_PROJECT or GH_TOKEN in the agent runtime) leak into the
// Config and Git tests and break them. Every Config-relevant and git
// related variable is cleared before each test; tests that need specific
// values set them explicitly in their own beforeEach (which runs after
// this one) or test body.
const AMBIENT_ENV_PATTERN =
  /^(AGENT|TASK|PLANNER|QODER|CLAUDE|COPILOT|CODEX|GEMINI|GIT|GITHUB|GH|DATA|TMP|DEV|CONFIG|OPENTELEMETRY)_/;

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (AMBIENT_ENV_PATTERN.test(key)) {
      delete process.env[key];
    }
  }
});
