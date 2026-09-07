# planner-llm-agent

LLM agent that connects to a [Planner](https://github.com/devopsplaybook-io/planner) instance and can be assigned tasks to execute.

The agent polls the Planner API for tasks assigned to its user, executes the tasks in the start status (default `To Do`) with the [Qoder CLI](https://qoder.com), posts the result as a task comment and moves the task to the end status (default `Done`). For each task it maintains a documentation file at `/data/tasks/[id]-Agent.md` that keeps the context of the task across runs.

Polling stays quiet: log entries are only emitted when a task is ready to be processed and during its processing (plus errors), not on every poll cycle.

The container ships all the toolchains needed to perform the tasks (Node.js, Python, Go, Rust, Java, shellcheck, jq, yq, kubectl, helm) as well as a complete Git and GitHub tooling set (`git`, `gh`, `gnupg`, `openssh-client`).

## Configuration

Configuration values are resolved with the following priority:

1. Environment variables (highest)
2. `config.json` file
3. Defaults (lowest)

### Agent

| Variable | Default | Description |
| --- | --- | --- |
| `AGENT_NAME` | `planner-llm-agent` | Planner user name the agent acts as (also used as the agent note title) |
| `PLANNER_URL` | `http://localhost:8080` | Planner instance base URL |
| `PLANNER_API_KEY` | (empty) | Planner API key (required) |
| `TASK_POLLING_INTERVAL` | `60` | Seconds between polls of assigned tasks |
| `TASK_STATUS_START` | `To Do` | Only tasks with this status are executed |
| `TASK_STATUS_END` | `Done` | Status set after a task is executed |
| `DATA_DIR` | `/data` | Persistent data directory (task documentation files) |
| `TMP_DIR` | `/tmp` | Temporary directory |
| `DEV_MODE` | `false` | Development mode flag |

### Qoder CLI

| Variable | Default | Description |
| --- | --- | --- |
| `QODER_CLI` | `qoder` | Qoder CLI command |
| `QODER_AUTH_CHECK` | `true` | Verify Qoder authentication at startup (fail fast) |
| `QODER_MODEL` | (empty) | Default model passed to the Qoder CLI (`--model`); empty uses the CLI default |

### Model selection

The model used for a task is resolved with the following priority:

1. A `qoder-model: <model>` line in the task description (per-task override)
2. The `QODER_MODEL` configuration value (default model)
3. The Qoder CLI default model (when neither is set)

Example task description requesting a specific model:

```
Fix the failing unit tests in the payment module and update the documentation.
qoder-model: claude-sonnet-4-5
```

When `QODER_MODEL` is set, the startup authentication probe also runs with that model, so a misconfigured model fails fast at startup instead of on the first task.

### Task execution report

Every task comment posted to Planner ends with a footer that displays the model used and the qoder account credits before and after the task execution:

```
---
Model: claude-sonnet-4-5 · Qoder credits: 16.41 -> 16.35
```

The credit balance comes from the qoder CLI JSON output (`total_credits`) and is persisted in `<DATA_DIR>/qoder-credits.json` — captured at startup by the authentication probe and after each task — so the next task can display the "before" value. The model is displayed as `auto` when no model is configured for the task, and values not reported by the CLI are shown as `unknown`.

### Git and GitHub

All Git and GitHub settings are optional: the agent automatically prepares the environment based on what is configured, and skips the setup entirely when none of `GITHUB_TOKEN`, `GIT_SSH_PRIVATE_KEY` or `GIT_GPG_PRIVATE_KEY` is provided. The environment is prepared at startup, before the first task runs, and any invalid value makes the agent fail fast with a clear message.

| Variable | Default | Description |
| --- | --- | --- |
| `GIT_USER_NAME` | `planner-llm-agent` | Git committer name |
| `GIT_USER_EMAIL` | `planner-llm-agent@users.noreply.github.com` | Git committer email |
| `GITHUB_TOKEN` | (empty) | GitHub Personal Access Token |
| `GIT_SSH_PRIVATE_KEY` | (empty) | SSH private key for `git@github.com` (OpenSSH or PEM) |
| `GIT_SSH_SIGNING` | `false` | Use the SSH key for commit signing instead of GPG |
| `GIT_GPG_PRIVATE_KEY` | (empty) | Armored GPG private key for commit signing |
| `GIT_GPG_KEY_ID` | (empty) | Signing key id (auto-detected from the imported key when empty) |
| `GIT_GPG_PASSPHRASE` | (empty) | GPG key passphrase (cached in gpg-agent for headless signing) |

Multi-line values (SSH and GPG keys) can be provided either with real newlines or with literal `\n` escape sequences.

### Agent config repository

| Variable | Default | Description |
| --- | --- | --- |
| `AGENT_CONFIG_REPOSITORY` | (empty) | Git URL of the agent config repository (empty disables the feature) |
| `AGENT_CONFIG_BRANCH` | `main` | Branch to sync |
| `AGENT_CONFIG_FOLDER` | (empty) | Only sync this folder of the repository (sparse checkout) |
| `AGENT_CONFIG_SYNC_INTERVAL` | `300` | Seconds between refreshes of the local copy |

### Agent note

| Variable | Default | Description |
| --- | --- | --- |
| `AGENT_NOTE_PROJECT` | (empty) | Planner project where the agent note is published (id or name; empty disables the feature) |
| `AGENT_NOTE_INTERVAL` | `86400` | Seconds between agent note updates (default: daily); `0` disables the updates |

## Git and GitHub authentication

### Personal Access Token (recommended)

Set `GITHUB_TOKEN` to a [fine-grained or classic PAT](https://github.com/settings/tokens) with the `repo` scope (add `workflow` if tasks need to push workflow files). The agent then:

- exposes the token as `GH_TOKEN` so the `gh` CLI is authenticated out of the box (`gh repo clone`, `gh pr create`, `gh api`, ...),
- configures git to use `gh auth git-credential` as the credential helper for HTTPS push/pull,
- rewrites `git@github.com:` clone URLs to HTTPS when no SSH key is configured, so SSH-style URLs still authenticate with the token,
- disables interactive credential prompts (`GIT_TERMINAL_PROMPT=0`) so a missing credential fails fast instead of hanging the task.

### SSH key

Set `GIT_SSH_PRIVATE_KEY` to an SSH private key whose public part is registered on GitHub (account key or repository deploy key). The agent:

- writes the key to `~/.ssh/id_github` (mode `0600`) and derives the public key,
- pins the official GitHub host keys (`github.com` and `ssh.github.com:443`) in `~/.ssh/known_hosts`, so SSH runs with `StrictHostKeyChecking yes` and no trust-on-first-use prompt,
- writes an `~/.ssh/config` scoped to github.com with `IdentitiesOnly yes`.

### Commit signing (GPG)

Set `GIT_GPG_PRIVATE_KEY` to an armored GPG private key. The agent imports it into `~/.gnupg`, resolves the signing key id (or uses `GIT_GPG_KEY_ID`), and enables `commit.gpgsign`. If the key is protected, set `GIT_GPG_PASSPHRASE`: the agent configures loopback pinentry, presets the passphrase in gpg-agent with a long cache TTL and restarts the agent, so signing never prompts in the container. A dedicated passphrase-less signing key is also a good option.

### Commit signing (SSH alternative)

Set `GIT_SSH_SIGNING=true` together with `GIT_SSH_PRIVATE_KEY` to sign commits with the SSH key instead of GPG (git `gpg.format = ssh`), including an `~/.ssh/allowed_signers` file for local verification.

### Kubernetes deployment

When deployed with Flux (see `didier-home`), these values are provided as environment variables by the `didiercloud-planner-agent` secret, synced from AWS Secrets Manager. Example secret content:

```json
{
  "GITHUB_TOKEN": "github_pat_...",
  "GIT_USER_NAME": "planner-agent",
  "GIT_USER_EMAIL": "agent@users.noreply.github.com",
  "GIT_SSH_PRIVATE_KEY": "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----\n"
}
```

## Agent config repository

Skills, configuration files and other resources the agent should use are defined in a dedicated Git repository (the *agent config repository*). The agent clones it at startup, keeps a local copy under `/data/agent-config` (`/data/agent-config/<folder>` when `AGENT_CONFIG_FOLDER` is set) and refreshes it every `AGENT_CONFIG_SYNC_INTERVAL` seconds.

- The startup clone fails fast: the agent does not start when the repository cannot be cloned.
- A failed periodic refresh keeps the last synced copy and only logs an error.
- The working tree is forced to match the remote branch on every refresh, so the local copy is always a faithful mirror of the repository.
- Authentication uses the Git and GitHub settings above (GitHub token or SSH key); public repositories need no authentication.
- Every task prompt tells the agent where the configuration is synced, so skills and resources are directly usable during task execution.

Example:

```json
{
  "AGENT_CONFIG_REPOSITORY": "https://github.com/acme/agent-config.git",
  "AGENT_CONFIG_BRANCH": "main",
  "AGENT_CONFIG_FOLDER": "config",
  "AGENT_CONFIG_SYNC_INTERVAL": 300
}
```

## Agent note

When `AGENT_NOTE_PROJECT` is set, the agent maintains a single Planner note named after itself (`AGENT_NAME`) in that project. The note is created on the first run and updated in place afterwards — it is never duplicated.

The note content is generated by the LLM from facts collected by the agent:

- Agent identity: name, version, current date and session uptime
- Capabilities: the skills available from the agent config repository and the configured default model
- Git and GitHub integration: authentication and commit signing setup
- Activity: the number of tasks executed and the titles of the most recent ones
- Account status: the remaining qoder credits

At the end of the startup the agent checks that the note exists and creates it when missing (an existing note is left untouched); the content is then refreshed every `AGENT_NOTE_INTERVAL` seconds (86400 = daily by default, set `3600` for hourly updates). A failed update is logged and retried on the next interval; it never stops the agent.

Example configuration (hourly updates):

```json
{
  "AGENT_NOTE_PROJECT": "Agent Workspace",
  "AGENT_NOTE_INTERVAL": 3600
}
```

## Development

```bash
npm run build   # compile TypeScript
npm run lint    # eslint
npm test        # jest
npm run dev     # run locally against a Planner instance
```
