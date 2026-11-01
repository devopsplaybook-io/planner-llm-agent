# planner-llm-agent

LLM agent that connects to a [Planner](https://github.com/devopsplaybook-io/planner) instance and can be assigned tasks to execute.

The agent polls the Planner API for tasks assigned to its user and executes the tasks selected by its _actions_ configuration (a YAML file, see [Agent actions](#agent-actions)). It runs the tasks with a coding-agent CLI (Qoder by default; Claude Code, Copilot CLI, Codex and Gemini CLI are also supported, see [CLI agent](#cli-agent)), marks the task as running with an agent-managed label while it works on it, accumulates the models that worked on the task as provenance labels (see [Task labels](#task-labels)), posts the result as a task comment and moves the task to the end status of the matching action. For each task it maintains a documentation file at `/data/tasks/[id]-Agent.md` that keeps the context of the task across runs and includes the name and description of the task project. Task attachments are downloaded to `/data/tasks/[id]/attachments/` (bounded by `TASK_ATTACHMENT_MAX_BYTES`), recorded in an `attachments.json` manifest so a later run reuses the local copy instead of downloading it again, and listed in the documentation file so the LLM can use them. When a task reaches the cleanup status (default `Done`) the agent deletes its local task folder, and periodically removes folders for tasks that are no longer assigned or have reached the cleanup status. The poll is scoped server-side to the agent's own user with the `assigneeUserId` filter and `fields` sparse fieldsets (the client-side assignee filter is kept as a safety net for older Planner deploys).

Polling stays quiet: log entries are only emitted when a task is ready to be processed and during its processing (plus errors), not on every poll cycle.

> **Security:** anyone able to create or assign a task to the agent's Planner user can execute arbitrary commands in the agent container and read every configured secret. Use a dedicated Planner user, restrict who can assign tasks to it and treat every task author as trusted as the agent itself. See [Security and trust model](#security-and-trust-model) before deploying in a shared environment.

Tasks are processed with a bounded parallelism driven by a weighted capacity budget (`TASK_MAX_PARALLEL`, default `1`): every task consumes a scheduling weight between 0.25 and 1, and tasks are admitted while their total weight fits the budget, so several small tasks can share what a single large task would consume. Tasks that would exceed the budget or work on a resource already claimed by a running task are deferred to a later poll (with the reason logged) instead of blocking the queue, and a task already being processed is never picked again by a subsequent poll. Ready tasks are picked by priority first (high, then medium, then low; an unknown or missing priority ranks as medium) — the queue priority of a task is the `priority` of its matching action when set, and the task's own Planner priority otherwise — and, within the same priority, the task whose last update is the oldest is picked first, so the tasks waiting the longest without any update go first. A task that fails to process is not retried forever: it is moved to the resolved error status (the `status_error` of the matching action, then `default.status_error`, then the action `status_end`) with a comment explaining the error (kept concise in the comment; see the agent logs for full details), so it does not block the queue. The whole scheduling model is described in [Parallel scheduling](#parallel-scheduling) and can be reverted to the historical count-based behavior with `TASK_SMART_SCHEDULING=false`.

The container ships all the toolchains needed to perform the tasks (Node.js, Python, Go, Rust, Java, shellcheck, jq, yq, kubectl, helm), every supported coding-agent CLI (see [CLI agent](#cli-agent)) as well as a complete Git and GitHub tooling set (`git`, `gh`, `gnupg`, `openssh-client`).

## Configuration

Configuration values are resolved with the following priority:

1. Environment variables (highest)
2. `config.json` file
3. Defaults (lowest)

The location of `config.json` is set by `CONFIG_FILE` (environment only, default `config.json` next to the compiled code: `/opt/app/planner-llm-agent/config.json` in the image, `agent/config.json` in a source checkout). It cannot be set from `config.json` itself and is fixed at startup.

### Configuration file and reload

- On every reload, `config.json` is read first and the environment values are re-applied afterwards, so an environment-provided value always wins over the file. Changing an environment variable requires a process restart.
- `config.json` is watched and applied without restarting the agent. When the new content is invalid JSON, the reload fails, the error is logged and the previous in-memory configuration stays active. A successful reload also re-arms the scheduled agent note and agent config repository refresh timers with their current intervals.
- Most keys are applied only when **truthy**: removing a key, or setting it to `0`, `""` or `false`, does **not** reset the in-memory value to its default — the previous value stays until a restart. Keys that accept an explicit clearing/zero/false value are `DEV_MODE` (explicit `false`), `TASK_SMART_SCHEDULING`, `TASK_ADJUSTMENT_MAX_ROUNDS` (`0`), `TASK_PROGRESS_COMMENT_INTERVAL` (`0`), `TASK_ATTACHMENT_MAX_BYTES` (`0`), `TASK_LABELS`, `TASK_RUNNING_LABEL`, `TASK_MODEL_LABEL_PREFIX`, `TASK_CLI_LABEL_PREFIX` (empty disables), `AGENT_START_COMMENT`, `AGENT_UTILITY_MODEL` (empty disables), `AGENT_NOTE_INTERVAL` (`0` disables), `AGENT_CONFIG_SYNC_INTERVAL` (`0` disables the periodic refresh) and `CORE_SKILLS_PATH`. The two interval timers are re-armed on every successful reload, so a changed interval takes effect without a restart and a previously disabled timer starts when given a positive interval.
- Hot-reloaded values are **not** re-validated (`validate()` runs at startup only). Consumers of bounded durations fall back to their built-in defaults when a value is invalid; startup validation still rejects invalid values. An invalid hot-reloaded `AGENT_NOTE_INTERVAL` or `AGENT_CONFIG_SYNC_INTERVAL` therefore falls back to its built-in default (`86400` / `300` seconds) and logs a warning instead of silently disabling the timer.
- The actions YAML (`AGENT_ACTIONS_FILE`) has its own watcher and is applied without restart (see [Agent actions](#agent-actions)); an invalid new content keeps the last valid configuration.
- Startup-only settings that a hot reload does not re-apply: `CONFIG_FILE`, enabling the agent config repository from empty (`AGENT_CONFIG_REPOSITORY`, which needs the initial clone), the Git/GitHub environment prepared once at startup (`GITHUB_TOKEN`, `GITHUB_TOKENS`, the SSH/GPG keys and `~/.gitconfig` are not rewritten), the CLI authentication probe and the OpenTelemetry exporters initialized at startup. Changing them requires a restart.
- A restart is required to revert removed keys or return to defaults.
- `cd agent && npm run check-config` (`node dist/checkConfig.js` in the container) validates **the actions YAML** and prints the resolved actions offline; it does not validate `config.json` (see [Validating the configuration](#validating-the-configuration)).

### Agent

| Variable                | Default                       | Description                                                               |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `AGENT_NAME`            | `planner-llm-agent`           | Planner user name the agent acts as (also used in the agent note title)   |
| `AGENT_ACTIONS_FILE`    | `/etc/planner/llm-agent.yaml` | Path of the agent actions YAML file, watched for changes at runtime (see [Agent actions](#agent-actions)) |
| `PLANNER_URL`           | `http://localhost:8080`       | Planner instance base URL                                                 |
| `PLANNER_API_KEY`       | (empty)                       | Planner API key (required)                                                |
| `TASK_POLLING_INTERVAL` | `60`                          | Seconds between polls of assigned tasks; doubles after every consecutive idle poll (see [Adaptive polling](#adaptive-polling)) |
| `TASK_POLLING_MAX_INTERVAL` | `300`                     | Ceiling of the adaptive polling backoff in seconds (the base interval always applies when lower) |
| `TASK_STATUS_CLEANUP`   | `Done`                        | Local task folder is deleted when a task reaches this status              |
| `TASK_DEPENDENCY_SATISFIED_STATUS` | `Done`             | Status that satisfies a task dependency; a dependency with any other status keeps the dependent task blocked. Validated against the project status catalogs at startup |
| `TASK_MAX_PARALLEL`     | `1`                           | Weighted capacity budget of the parallel scheduling (decimals allowed, e.g. `1.9`; at most ceil(budget) CLI processes run concurrently; see [Parallel scheduling](#parallel-scheduling)) |
| `TASK_SMART_SCHEDULING` | `true`                        | Weighted, conflict-aware scheduling when `true`; `false` restores the historical count-based parallelism |
| `TASK_CONFLICT_MODE`    | `repo`                        | Automatic conflict keys derived from the task content: `repo`, `project` or `none` (see [Parallel scheduling](#parallel-scheduling)) |
| `TASK_ADJUSTMENT_MAX_ROUNDS` | `2`                      | Maximum number of adjustment passes re-running the CLI when new comments arrive on a task while a step runs (see [New comment check](#new-comment-check)); `0` only detects and logs them, and comments that arrived during the run are picked up by the next poll via the summary watermark |
| `TASK_PROGRESS_COMMENT_INTERVAL` | `0`                  | Seconds between periodic "still working" comments posted on a running task; `0` disables the heartbeats |
| `TASK_LABELS`           | `true`                        | Manage Planner task labels while processing: the transient running label and the model/CLI provenance labels (see [Task labels](#task-labels)); `false` disables every label write |
| `TASK_RUNNING_LABEL`    | `agent:running`               | Transient label set while a task executes and removed on every exit path (the exact label set at start, even if this value is hot-reloaded); empty disables it |
| `TASK_MODEL_LABEL_PREFIX` | `model:`                    | Prefix of the accumulated provenance label recording each model used on the task (e.g. `model:deepseek-flash`); empty disables it |
| `TASK_CLI_LABEL_PREFIX` | (empty)                       | Prefix of the accumulated provenance label recording each CLI agent used on the task (e.g. `agent:qoder`); empty disables it (recommended while a single CLI is configured) |
| `AGENT_START_COMMENT`   | `false`                       | Legacy one-line "started working" comment posted on every run (first run only for comment-triggered actions); off by default, the running label replaces it |
| `AGENT_UTILITY_MODEL`   | (empty)                       | Fast/cheap model (on the configured CLI) pre-evaluating the weight and repositories of hint-less tasks; empty disables it (zero LLM calls) |
| `AGENT_EVALUATION_TIMEOUT` | `30`                       | Maximum duration in seconds of one scheduling round's utility-model evaluations (see [Utility model](#utility-model-optional)) |
| `TASK_TIMEOUT`          | `3600`                        | Maximum duration of a task execution in seconds (fallback when the actions configuration defines no timeout) |
| `TASK_ATTACHMENT_MAX_BYTES` | `52428800` (50 MiB)       | Maximum size in bytes of one downloaded task attachment: a larger attachment is skipped (streaming download aborted) and reported as skipped in the task brief; `0` disables the cap |
| `DATA_DIR`              | `/data`                       | Persistent data directory (task documentation files and pending finalization records) |
| `TMP_DIR`               | `/tmp`                        | Temporary directory                                                       |
| `DEV_MODE`              | `false`                       | Development mode flag                                                     |

Every duration setting expressed in seconds (`TASK_POLLING_INTERVAL`, `TASK_POLLING_MAX_INTERVAL`, `TASK_TIMEOUT`, `TASK_PROGRESS_COMMENT_INTERVAL`, `AGENT_EVALUATION_TIMEOUT`, `AGENT_CONFIG_SYNC_INTERVAL`, `AGENT_NOTE_INTERVAL` and the actions timeouts) is capped at `2147483` seconds (about 24.8 days): the largest delay Node.js timers accept. A larger value is rejected at startup instead of silently overflowing into a hot loop. Hot-reloaded values are not re-validated: when a value invalid at runtime is consumed, the consumer falls back to its built-in default (see [Configuration file and reload](#configuration-file-and-reload)).

### CLI agent

| Variable           | Default  | Description                                                             |
| ------------------ | -------- | ----------------------------------------------------------------------- |
| `AGENT_CLI`        | `qoder`  | Coding-agent CLI running the tasks: `qoder`, `claude-code`, `copilot-cli`, `codex` or `gemini-cli` |
| `AGENT_AUTH_CHECK` | `true`   | Verify the CLI authentication at startup with a headless probe (fail fast) |

The command of each CLI is configurable, and the container ships every supported CLI:

| Variable      | Default   | CLI                                      | Authentication (read by the CLI itself)                          |
| ------------- | --------- | ---------------------------------------- | ---------------------------------------------------------------- |
| `QODER_CLI`   | `qoder`   | [Qoder](https://qoder.com)               | `QODER_PERSONAL_ACCESS_TOKEN`                                    |
| `CLAUDE_CLI`  | `claude`  | [Claude Code](https://code.claude.com)   | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`                 |
| `COPILOT_CLI` | `copilot` | [Copilot CLI](https://docs.github.com/copilot/concepts/agents/about-copilot-cli) | `GH_TOKEN` (GitHub token with a Copilot subscription) |
| `CODEX_CLI`   | `codex`   | [Codex](https://developers.openai.com/codex) | `OPENAI_API_KEY` or the ChatGPT login (`codex login`)         |
| `GEMINI_CLI`  | `gemini`  | [Gemini CLI](https://google-gemini.github.io/gemini-cli/) | `GEMINI_API_KEY` or the OAuth login (`gemini`)  |

Only Qoder supports a model listing; for the other CLIs the model validation is skipped. Some CLIs do not report a usage metric (credits or cost): the task report footer then displays the model and the duration, without a usage part (see [Task execution report](#task-execution-report)).

The Copilot CLI runs with `--output-format text --silent` (only the final reply is captured) and the agent registers its skills directories at startup: the core skills directory shipped with the image is always registered and, when the agent config repository is configured, the synced skills directory joins it (`copilot skill add <path>`). Copilot does not discover the image skills or the synced repository on its own, so without this registration the model would not see the skills. The registration is idempotent and best-effort — a failure is logged and the tasks keep running with the skills listed in the task prompt.

### Model selection

The model used for a task is resolved with the following priority:

1. An `agent-model: <model>` line in the task description (per-task override; the legacy `qoder-model:` line is still accepted)
2. The `model` of the matching action (see [Agent actions](#agent-actions))
3. The `default.model` of the actions configuration
4. The CLI default model (when none of the above is set)

When a task starts and the selected CLI supports a model listing (Qoder), the resolved model is checked against the models available to the account (`qoder --list-models`, fetched once and cached). A failed or empty listing is cached as a negative result for 5 minutes, so a broken CLI or account does not pay the probe on every task (concurrent tasks share the same in-flight fetch). A model outside of that list is logged as a warning (with the available models) but the task still runs — the CLI remains the authority on what it can execute. For the other CLIs the validation is skipped.

Example task description requesting a specific model:

```
Fix the failing unit tests in the payment module and update the documentation.
agent-model: claude-sonnet-4-5
```

When the actions configuration sets a `default.model`, the startup authentication probe also runs with that model, so a misconfigured model fails fast at startup instead of on the first task.

When the primary run of a task fails and a fallback is configured (see [Agent actions](#agent-actions)), the fallback run resolves its model the same way, with the `fallback_model` of the matching action, then `default.fallback_model`, in place of the configured model.

### Task execution report

Every task comment posted to Planner ends with a footer built as `---`, then `Model: <model> · <usage> · Duration: <duration>` (the usage part is omitted when the CLI reports no metric). The model is displayed as `auto` when no model is configured for the task, and the duration is compact (e.g. `23m`, `1h05m`). The usage part depends on the selected CLI:

- Qoder: `Qoder credits used: <n.nn>` — the credits consumed by the run (`total_credits`), persisted in `<DATA_DIR>/qoder-credits.json`;
- Claude Code: `Claude cost: $<n.nn>` — the cost of the run (`total_cost_usd`), persisted in `<DATA_DIR>/claude-code-usage.json`;
- Copilot CLI, Codex and Gemini CLI: no usage part, the footer shows the model and the duration only.

All reported values are per-run values, not account balances. Examples:

```
---
Model: qwen3.8-flash · Qoder credits used: 15.81 · Duration: 23m
```

```
---
Model: claude-sonnet-4-5 · Claude cost: $0.42 · Duration: 23m
```

When a task fails, the failure comment salvages what the CLI run left behind: the partial summary file written by the CLI (when any) and the tail of its captured output, so the state of the interrupted work is visible on Planner without digging through the agent logs.

### Git and GitHub

All Git and GitHub settings are optional: the agent automatically prepares the environment based on what is configured, and skips the setup entirely when none of `GITHUB_TOKEN`, `GITHUB_TOKENS`, `GIT_SSH_PRIVATE_KEY` or `GIT_GPG_PRIVATE_KEY` is provided. The environment is prepared at startup, before the first task runs, and any invalid value makes the agent fail fast with a clear message.

| Variable              | Default                                      | Description                                                                |
| --------------------- | -------------------------------------------- | -------------------------------------------------------------------------- |
| `GIT_USER_NAME`       | `planner-llm-agent`                          | Git committer name                                                         |
| `GIT_USER_EMAIL`      | `planner-llm-agent@users.noreply.github.com` | Git committer email                                                        |
| `GITHUB_TOKEN`        | (empty)                                      | GitHub Personal Access Token used as the default token                     |
| `GITHUB_TOKENS`       | (empty)                                      | Additional tokens scoped by organization, format `org1=token1,org2=token2` |
| `GIT_SSH_PRIVATE_KEY` | (empty)                                      | SSH private key for `git@github.com` (OpenSSH or PEM)                      |
| `GIT_SSH_SIGNING`     | `false`                                      | Use the SSH key for commit signing instead of GPG                          |
| `GIT_GPG_PRIVATE_KEY` | (empty)                                      | Armored GPG private key for commit signing                                 |
| `GIT_GPG_KEY_ID`      | (empty)                                      | Signing key id (auto-detected from the imported key when empty)            |
| `GIT_GPG_PASSPHRASE`  | (empty)                                      | GPG key passphrase (cached in gpg-agent for headless signing)              |

Multi-line values (SSH and GPG keys) can be provided either with real newlines or with literal `\n` escape sequences.

### Multiple organization tokens

Tasks can involve repositories from several GitHub organizations, while each token is scoped to a single organization. Set `GITHUB_TOKENS` to a comma-separated list of `organization=token` pairs (in the environment or in `config.json`):

```json
{
  "GITHUB_TOKEN": "github_pat_default_token",
  "GITHUB_TOKENS": "my-org=github_pat_org1token,other-org=github_pat_org2token"
}
```

Git HTTPS operations against `https://github.com/<organization>/...` automatically use the matching organization token (per-organization credential helpers, with the path component considered); everything else keeps using the default `GITHUB_TOKEN` through the `gh` credential helper. Organization names are matched exactly as they appear in the repository URLs, so configure them in the casing used by the repositories (lowercase is typical). The default token stays optional when every accessed organization has its own token, and the tokens are validated at startup (format, duplicate organizations, obviously too-short values).

Each organization token is also exposed to the tasks as a `GH_TOKEN_<ORG>` environment variable (e.g. `my-org` becomes `GH_TOKEN_MY_ORG`), because the `gh` CLI only reads the default `GH_TOKEN`, which is not guaranteed to have the rights required for every organization. Tasks are instructed to prefix `gh` commands with the matching variable for the organization they operate on:

```sh
GH_TOKEN="$GH_TOKEN_MY_ORG" gh pr create ...
```

When no default token is configured and exactly one organization token exists, that token is additionally used as the default `GH_TOKEN`.

### Agent config repository

| Variable                     | Default | Description                                                         |
| ---------------------------- | ------- | ------------------------------------------------------------------- |
| `AGENT_CONFIG_REPOSITORY`    | (empty) | Git URL of the agent config repository (empty disables the feature) |
| `AGENT_CONFIG_BRANCH`        | `main`  | Branch to sync                                                      |
| `AGENT_CONFIG_FOLDER`        | (empty) | Only sync this folder of the repository (sparse checkout; a relative path without `..` or empty segments) |
| `AGENT_CONFIG_SYNC_INTERVAL` | `300`   | Seconds between refreshes of the local copy (at most `2147483`, hot-applied); `0` disables the periodic refresh (the startup clone still runs) |
| `CORE_SKILLS_PATH`           | (empty) | Core skills directory override (empty resolves to the skills directory shipped with the image, next to the compiled code) |

### Agent note

| Variable              | Default | Description                                                                                |
| --------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `AGENT_NOTE_PROJECT`  | (empty) | Planner project where the agent note is published (id or name; empty disables the feature) |
| `AGENT_NOTE_INTERVAL` | `86400` | Seconds between agent note updates (default: daily, hot-applied); `0` disables the updates |

### OpenTelemetry

| Variable                                        | Default | Description                                                              |
| ----------------------------------------------- | ------- | ------------------------------------------------------------------------ |
| `OPENTELEMETRY_COLLECTOR_HTTP_TRACES`           | (empty) | OTLP HTTP endpoint for traces; empty means the signal is not exported    |
| `OPENTELEMETRY_COLLECTOR_HTTP_METRICS`          | (empty) | OTLP HTTP endpoint for metrics; empty means the signal is not exported   |
| `OPENTELEMETRY_COLLECTOR_HTTP_LOGS`             | (empty) | OTLP HTTP endpoint for logs; empty means the signal is not exported      |
| `OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER`    | (empty) | Value sent as `Authorization: Bearer <value>` on every exported request  |

These settings are consumed when OpenTelemetry initializes at startup, so changing them requires a restart.

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

Set `GIT_GPG_PRIVATE_KEY` to an armored GPG private key. The agent imports it into `~/.gnupg`, resolves the signing key id (or uses `GIT_GPG_KEY_ID`), and enables `commit.gpgsign`. If the key is protected, set `GIT_GPG_PASSPHRASE`: the agent configures loopback pinentry, presets the passphrase in `gpg-agent` with a long cache TTL (one year: `default-cache-ttl`/`max-cache-ttl 31536000`) and restarts `gpg-agent`, so signing never prompts in the container. A dedicated passphrase-less signing key is also a good option.

### Commit signing (SSH alternative)

Set `GIT_SSH_SIGNING=true` together with `GIT_SSH_PRIVATE_KEY` to sign commits with the SSH key instead of GPG (git `gpg.format = ssh`), including an `~/.ssh/allowed_signers` file for local verification.

### Kubernetes deployment

When deployed on Kubernetes, these values are provided as environment variables from a Kubernetes secret. Example secret content:

```json
{
  "GITHUB_TOKEN": "github_pat_...",
  "GIT_USER_NAME": "planner-agent",
  "GIT_USER_EMAIL": "agent@users.noreply.github.com",
  "GIT_SSH_PRIVATE_KEY": "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----\n"
}
```

The agent actions file is provided by a ConfigMap mounted at `/etc/planner/llm-agent.yaml`. An example Kubernetes deployment (namespace, PVC, ConfigMap with the actions file, Deployment, Kustomize) is available in [`docs/deployments/kubernetes`](docs/deployments/kubernetes).

## Security and trust model

The agent is designed to run trusted tasks with broad credentials, not to sandbox untrusted work. This section states the trust boundary operators must understand before deploying it.

### Who can execute code

Every task runs a coding-agent CLI with permission bypass. Creating or assigning a task to the agent's Planner user is therefore equivalent to executing arbitrary commands in the agent container with the agent's credentials, and to reading every secret injected into it. Use a dedicated Planner user, restrict its projects and visibility, and keep a tight assignee list; treat every task author as trusted as the agent itself.

### Secrets visible to every task

The agent process environment is inherited by every CLI, `git` and `gh` child process, so any code a task runs can read all of:

- `PLANNER_API_KEY` and `PLANNER_URL`;
- `GITHUB_TOKEN` / `GH_TOKEN` and every `GH_TOKEN_<ORG>` organization token;
- `GIT_SSH_PRIVATE_KEY` (written to `~/.ssh/id_github`, mode `0600`) and `GIT_GPG_PRIVATE_KEY` with `GIT_GPG_PASSPHRASE` (key in `~/.gnupg`, mode `0700`; the passphrase is cached in `gpg-agent` with a one-year cache TTL);
- `OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER`;
- the credentials the CLIs read themselves: `QODER_PERSONAL_ACCESS_TOKEN`, `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY` (the Copilot CLI uses `GH_TOKEN`).

### GitHub organization tokens

Every configured organization token is exported as `GH_TOKEN_<ORG>` **to every task**, regardless of which repositories the task touches, and is referenced by name in a credential-helper command in `~/.gitconfig` (`password=${GH_TOKEN_<ORG>}`): the file and `git config --list` contain only the variable name, never the token. Git scopes each token by URL prefix `https://github.com/<organization>`, but this is git configuration, not process isolation: all configured tokens remain readable in the process environment by any code the agent runs. The default token is used host-wide through `gh auth git-credential`. An already-set `GH_TOKEN` in the environment is not overwritten.

### Untrusted task input

Task descriptions, comments, checklists, attachments and the repository content the agent reads are untrusted input: they can steer the model, which runs without a sandbox or approval gate. The agent bounds the accidental damage:

- attachment file names containing `/` or `\`, empty names, `.` and `..` are skipped and reported in the task brief;
- downloads are capped by `TASK_ATTACHMENT_MAX_BYTES` (default `52428800`, 50 MiB; `0` disables the cap): a larger attachment is aborted in streaming, skipped and reported, and the downloaded files are stored under `DATA_DIR/tasks/<taskId>/attachments/` with an `attachments.json` manifest so a later run reuses them;
- tasks whose Planner id is not a canonical hyphenated UUID are skipped (defense against path traversal).

These measures bound accidental damage, not a hostile task author.

### Least-privilege recommendations

- Use fine-grained, short-lived organization tokens with minimal scopes, and prefer per-organization tokens over one broad default token; keep the default token only when necessary.
- Rotate every credential if a task, the Planner account or a CLI token is suspected compromised.
- Restrict the container network egress (for example a NetworkPolicy allowlist for Planner, GitHub, the model providers and the package registries).
- Run the agent in a dedicated namespace and service account, do not co-locate unrelated workloads in the same pod or namespace, and do not share volumes with them.
- Keep the example deployment hardening: non-root user, no privilege escalation, dropped capabilities.

### Transport security

With an `http://` `PLANNER_URL`, the `PLANNER_API_KEY` and all Planner traffic travel in cleartext. The agent logs one startup warning in that case and keeps HTTP valid for trusted in-cluster or local networks:

```
PLANNER_URL uses plain HTTP: the Planner API key is sent in cleartext; use HTTPS unless Planner is reached over a trusted in-cluster or local network.
```

The warning is emitted once at startup (a hot reload of `PLANNER_URL` does not emit it again) and is non-fatal. The default `PLANNER_URL` is `http://localhost:8080`, so local development runs warn too. Prefer HTTPS everywhere else.

### Dependency security

The production tree is expected to be clean: `npm audit --omit=dev` reports **0 vulnerabilities** (the production image is built from the compiled output and copies the build stage's `node_modules` after `npm prune --omit=dev`, so it ships production dependencies only). Dev-toolchain advisories may appear in the full `npm audit` output; they are tracked with the periodic dependency-update tasks and shown in the build logs.

### Current limitation and possible hardening

Today every configured organization token is exposed to every task. Exposing only the tokens relevant to an action or task would require per-child-process environment and per-task git config/HOME isolation (plus prompt and token-selection changes); it is deliberately not implemented. The isolation boundary today is the container and its namespace: one agent identity per container, single replica.

## Parallel scheduling

When `TASK_SMART_SCHEDULING` is `true` (the default), `TASK_MAX_PARALLEL` is a weighted capacity budget instead of a task count. Every task is assigned a scheduling weight between `0.25` and `1` (a large task can occupy a full slot, a tiny one a quarter of a slot) and the agent walks the ready tasks in the queue order (priority, then oldest update), admitting every task whose weight fits the remaining budget. A task that does not fit — or that conflicts with a resource claimed by a running or already-picked task — is deferred with a logged reason (`capacity` or `conflict:<key>`) and retried naturally on the next poll; the walk continues, so a blocked high-priority task never prevents unrelated lower-priority tasks from starting (no head-of-line blocking).

Every running task executes one full CLI process, whatever its scheduling weight, and the CLI is a Node.js process whose heap is sized from the container memory limit — the process count, not the weight sum, is what the container memory must hold. The scheduler therefore never runs more CLI processes than the budget count (`ceil(TASK_MAX_PARALLEL)`): small weights pack several small tasks into the same process slots, they never multiply the process count (`TASK_MAX_PARALLEL=1.9` runs at most 2 CLI processes at a time, the default budget `1` exactly one). Size the container memory for the agent plus `ceil(TASK_MAX_PARALLEL)` concurrent CLI processes and their build toolchains.

The weight of a task is resolved with the cheapest source first:

1. An `agent-weight: <n>` line in the task description (per-task hint)
2. The `weight` of the matching action (see [Agent actions](#agent-actions))
3. The utility-model evaluation, for tasks with no explicit hint (see below)
4. The default weight `1`

Values are clamped to the `0.25`–`1` scale.

Conflict keys serialize the tasks that must not run in parallel. They come from three sources:

- **Explicit locks (always honored):** any `agent-lock: <key>` line in the task description (comma-separated keys, multiple lines allowed). Keys shaped like `owner/repo` are normalized to `repo:owner/repo`; anything else is used verbatim (lowercased).
- **Automatic repository keys** (when `TASK_CONFLICT_MODE` is `repo`, the default): repository slugs are extracted from the task description and comments — GitHub HTTPS and SSH clone URLs and `` `owner/repo` `` backtick mentions — and normalized to `repo:owner/name`. The extraction is deliberately conservative to avoid locking on prose mentions.
- **Project serialization** (when `TASK_CONFLICT_MODE` is `project`): additionally, two tasks of the same Planner project never run in parallel. `none` keeps only the explicit locks.

Example task description using the directives:

```
Refactor the checkout flow and update its documentation.
agent-weight: 0.5
agent-lock: repo:acme/shop, deploy:checkout
```

### Utility model (optional)

When `AGENT_UTILITY_MODEL` is set to a model available on the configured CLI, the agent asks that fast/cheap model to pre-evaluate the tasks that carry no `agent-weight:` directive and whose action defines no `weight`, before the selection:

- The prompt contains the task title, project and description (plus the latest comments) and expects a single JSON reply: `{"weight": <number>, "conflicts": ["repo:owner/name", ...], "kind": "<code-heavy|code-light|non-code>"}`.
- The evaluated weight fills the same slot as an action weight (the description directive still wins) and the repository keys returned by the model are merged into the conflict keys. Only keys with the `repo:` shape are accepted, so a model answer cannot inject arbitrary locks; everything else fails open (fallback weight `1`, no extra conflicts).
- Evaluations are cached per task content version (a task is evaluated once per update, not per poll), only the tasks that could still be admitted this round are evaluated, at most 3 evaluations run concurrently and never more than the process cap of the scheduler (every evaluation is one CLI process), and each is bounded by the `AGENT_EVALUATION_TIMEOUT` timeout. A failing or slow utility model never blocks the scheduling: the task falls back to the default weight and the deterministic conflict keys, and the failure is logged once per content version.
- The scheduling round itself is bounded by the same `AGENT_EVALUATION_TIMEOUT` (seconds, default `30`): the evaluations still running when the bound is hit keep running in the background and feed the later rounds through the cache, while the round proceeds with the fallback for the tasks it could not evaluate in time.
- A repeatedly timing-out utility model opens a circuit breaker: after 3 consecutive timeouts the utility model is skipped for 5 minutes (the cached evaluations still apply), so a hung model cannot stall every round.
- When `AGENT_UTILITY_MODEL` is empty (the default) the evaluator makes zero LLM calls.

### Adaptive polling

The agent polls Planner immediately at startup, then again after every completed poll: the delay between polls is `TASK_POLLING_INTERVAL` (default `60` seconds), doubled after every consecutive poll that found nothing to do (no ready task, nothing running and no pending finalization), capped by `TASK_POLLING_MAX_INTERVAL` (default `300` seconds). Any activity — a task picked, tasks running, a pending Planner finalization — resets the backoff to the base interval, so the pickup latency stays low whenever there is work while an idle agent reduces the Planner polling load to one request per `TASK_POLLING_MAX_INTERVAL` seconds at most. A poll failure keeps the current cadence and does not restore the base interval. When at least one action is comment-triggered (`trigger: comments`), the idle backoff is capped at the base `TASK_POLLING_INTERVAL`: the polls never slow past the base interval, so a user comment on a conversational task is answered within one base interval. The agent's own Planner user and the visible project catalog are cached for 60 seconds: a failed fetch is never cached and is retried on the next call, concurrent callers share a single request, and a project added or renamed becomes visible within at most 60 seconds (the next poll).

### Project-scoped task fetch

When every action of the agent is bound to a project pattern, the poll fetches only the tasks of the matching projects (`/api/tasks?projectIds=...`) instead of the full task list across all projects, which cuts the payload of every poll. The fetch falls back to the unscoped list when no project matches the patterns. Note that the local task-folder cleanup uses the same (scoped) list: folders of tasks outside the agent's project scope are treated as no longer assigned and are cleaned up.

### New comment check

A task run can last a long time, and comments posted on the task while the CLI agent works are missed by the brief built at poll time. After the CLI run of a step completes and before the task is finalized (summary comment, end status), the agent re-fetches the task from Planner and compares the comment ids with the ones the brief was built from: comments authored by the agent itself (its start comment, for example) are ignored. When new human comments exist, the task brief is refreshed with them and the CLI agent runs once more with a directive listing the new messages, so it can take them into account, adjust the delivered work if needed and update its summary — which becomes the final one. At most `TASK_ADJUSTMENT_MAX_ROUNDS` adjustment passes run per step (default `2`); comments arriving after the budget is exhausted are logged and the task finalizes with the last summary, and `0` only detects and logs the new comments. A failing Planner read never discards the completed run: the task then finalizes as-is. A failing adjustment pass is best-effort too: it is logged and a short note is appended to the summary saying the comments posted during the run were not taken into account, while the task finalizes normally with the summary of the last successful run. Only a failure of the initial run takes the failure path (failure comment and error status); a user abort still aborts whichever run it interrupts. In the comments mode the two mechanisms compose: the bounded adjustment passes take the comments that arrive during a run into account, and the summary comment of a comments action carries an invisible trailing marker `<!-- agent:processed-comments=<id> -->` recording the id of the newest comment the run actually consumed (`none` when the brief had no comment). The stateless pickup rule compares that watermark with the human comments, so a comment the summary did not cover — arriving between the last new-comment check and the summary POST, after the adjustment budget is exhausted, or during a finalization retry backoff — re-triggers the task on a later poll without the user posting another message. The watermark lives in the Planner comment, so the guarantee survives an agent restart; the agent's own summary never re-triggers a run, and each human comment batch re-triggers the task at most once because the next summary advances the watermark past it.

### Working directory and instances

Each task runs in its own working directory `DATA_DIR/tasks/<taskId>/` (stated in the task prompt), so parallel tasks never share one and cannot collide on the filesystem. Only canonical hyphenated UUIDs (8-4-4-4-12, case-insensitive) are accepted as task ids: a task returned by Planner with any other id is skipped and logged, so an id can never escape the tasks directory. The scheduling state (running tasks, weights, locks, evaluation cache) is kept in memory: one agent process per agent identity is assumed and cross-instance scheduling is not supported — run a single replica per agent identity.

### Observability and kill switch

Every poll with picks or deferrals logs one `Scheduling round:` line (`picked:` with the weights, `deferred:` with the reasons) and the running tasks are reported on every poll while tasks run (title, project, weight, elapsed time, model). When instrumentation is enabled, the scheduling queue is exported as the single `tasks.queue` gauge (observable gauges are exported as-is, without the service-name prefix): one data point per value, distinguished by the `type` attribute — `tasks_queued` (tasks ready and waiting to be admitted), `tasks_in_progress` (tasks currently being processed) and `weight_in_progress` (total scheduling weight of the tasks being processed).

Every task execution (an agent session) records the `session.duration` histogram (exported as `session.duration`, in seconds), labeled with `agent` (CLI name, e.g. `qoder`), `model` (the resolved model, `auto` when the CLI default is used) and `status` (`success`, or `error` for the failed executions: timeouts and CLI errors are recorded too).

Setting `TASK_SMART_SCHEDULING=false` restores the historical behavior exactly: `TASK_MAX_PARALLEL` is a plain task count, weights, conflict keys and the utility model are ignored (no LLM call). A positive fractional budget (e.g. `0.5`) still admits at least one task per round instead of stalling the queue.

## Task labels

The agent marks the tasks it works on with Planner labels, so the execution state is visible and filterable on the task board instead of being buried in the comment thread:

- **`agent:running`** (transient, `TASK_RUNNING_LABEL`): set when the agent starts processing a task and removed when the run ends — on success, CLI failure, timeout, user abort and a failed Planner finalization alike (the `processTask` finally is the single path every exit goes through). The exact label set at the start is the one removed at the end, even if `TASK_RUNNING_LABEL` or `TASK_LABELS` is hot-reloaded during the run; a run that added no running label performs no removal. Because a crash can leave it behind, the agent lists its assigned tasks carrying the label shortly after startup (after a one-minute grace period that protects the tasks a previous pod may still be finishing during a rolling update) and clears the stale ones. An empty value disables the label.
- **`model:<model>`** (accumulated, `TASK_MODEL_LABEL_PREFIX`): the normalized model used by each run (lowercase kebab-case, e.g. `model:deepseek-flash`, `model:qwen3.8-flash`). Different stages can use different models, so the labels accumulate over the task lifecycle and are never removed on their own. Empty disables the prefix.
- **`<cli-prefix><cli>`** (optional, accumulated, `TASK_CLI_LABEL_PREFIX`): the CLI agent used by each run (e.g. `agent:qoder`), off by default because a single configured CLI would add a constant label to every task.

The running and provenance labels are added together in one atomic mutation before the CLI starts, and the exact running label that was added is removed in one when the run ends (`PATCH /api/tasks/:id/labels` with `add`/`remove`, Planner ≥ 0.82.0): the server applies the difference itself, so concurrent writers cannot clobber each other, no read-merge-write is needed and an unchanged mutation is a no-op. The writes are quiet (the server skips the "Labels updated" feed entry and the assignee notification) but still bump the task `dateUpdated`. Against an older Planner without the PATCH endpoint (`404`/`405`) the agent falls back automatically to the legacy whole-list replacement: it re-reads the task immediately before the write and merges the labels (a label set by a human is never lost). Label handling is best-effort, so a failure is logged and never fails the task. `TASK_LABELS=false` disables every label write.

The legacy one-line start comment is disabled by default; `AGENT_START_COMMENT=true` restores it. The summary, failure and abort comments are unaffected: they carry the result of the run, not the start signal.

## Agent actions

The actions of the agent are defined in a YAML file (path `AGENT_ACTIONS_FILE`, default `/etc/planner/llm-agent.yaml`). Each action binds a Planner project pattern and a start status to an optional model, an optional instruction, an optional timeout and an end status:

```yaml
instructions:
  plan: Analyze the task and post an implementation plan as the task summary. Do not modify any code.
  deliver: Implement the task, keep the "Agent Notes" section updated and open a PR when the work is ready for review.
default:
  agent: qoder
  model: DeepSeek-Flash
  fallback_agent: qoder
  fallback_model: GLM-5.3-Flash
  timeout: 3600
  status_error: Review
  status_in_progress: In Progress
  status_abort: Aborted
actions:
  - project: Web
    status_start: To Do
    status_end: In Review
    status_error: Blocked
    status_in_progress: In Progress
    status_abort: Cancelled
    agent: copilot-cli
    model: gpt-6-luna
    instruction: deliver
    timeout: 1800
    weight: 0.75
  - project: Project*
    status_start: Blocked
    status_end: Done
    status_abort: Aborted
    priority: low
  - project: Projects/Ideation
    status_start: Plan
    trigger: comments          # conversational mode: no status move, re-runs on new user comments
    instruction: plan
  - status_start: In Progress
    status_end: Done
    instruction: plan
```

For every poll, the agent checks if an assigned task matches the project pattern and the start status of an action. Matching tasks are processed with the action model and instruction (on top of the task information) and moved to the action end status once processed; a processing failure moves the task to the resolved `status_error` instead (see below).

- `trigger` selects the mode of the action: `status` (the default, and the value when the field is omitted) is the status pipeline described on this page, and `comments` switches the action to the conversational mode: the agent posts its result as a task comment and never changes the task status, so the task stays in `status_start` and every batch of new user comments re-triggers a run. A task with zero comments is processed too — the description is the initial prompt. The pickup rule of the comments mode is stateless and restart-safe (no durable state, no cursors): a task is picked up when its project, start status and assignee match the action, all its dependencies are in the configured satisfied status (`TASK_DEPENDENCY_SATISFIED_STATUS`, default `Done`), and it has zero comments, or its last comment was **not** authored by the agent, or its last comment is an agent summary whose trailing `<!-- agent:processed-comments=… -->` watermark is behind a newer human comment — a conversation waiting for the user is not queued and is picked up again as soon as they reply. An agent comment without a watermark (a summary posted by an older agent version, a progress or abort comment) falls back to the historical rule and does not re-trigger a run.
- In the comments mode the status-move fields are constrained (strictly validated at startup): `status_end` is omitted and rejected when set (a set end status contradicts the mode); `status_error` and `status_in_progress` are rejected (the agent never moves the task, and the config-wide `default.status_error` / `default.status_in_progress` are ignored for these actions); `status_abort` stays honored — user-initiated cancellation works exactly as in the pipeline mode, and the user moves the task back to `status_start` and comments again to resume. A processing failure posts the failure comment (with the salvaged partial summary and CLI output) and leaves the status unchanged, so commenting again triggers a new run; the failure comment carries the same watermark as the summary, so a comment posted during the failed run is retried automatically on the next poll. The local task folder and its documentation file are kept across runs (the task never reaches the cleanup status by itself), so the conversational context accumulates. A comments action sharing its `status_start` and overlapping project patterns with a pipeline action follows the first-matching-action rule like the overlapping pipeline patterns, but only when it is listed **before** that pipeline action with its own pattern: it then explicitly claims the start status for its project while the broader pipeline action keeps its other projects. The validation rejects the two orderings that cannot express an intent: a pipeline action listed before the overlapping comments action (it silently shadows the conversation) and a comments action sharing the exact project pattern of the pipeline action (the second one is unreachable). Two overlapping comments actions follow the same first-matching-action rule.
- `status_start` is required; `status_end` is required too unless the action is comment-triggered (`trigger: comments`). `project`, `agent`, `fallback_agent`, `fallback_model`, `model`, `instruction`, `timeout`, `weight`, `status_error`, `status_in_progress`, `status_abort` and `priority` are optional. `project` matches any project when missing, null or empty; otherwise it is a case-sensitive glob pattern where `*` matches any sequence of characters (e.g. `Project*` matches `Projects` and `Projects - Planner`). Overlapping patterns are allowed: the first matching action in the list owns the task and processes it, and a task whose project cannot be resolved never matches a project-bound action. The ownership is claimed on the match itself, before the comments pickup rule and the dependency gate: when the first matching action leaves the task alone for now (a conversation waiting for the user, a blocked dependency), a later overlapping action never picks it up.
- `default.agent` selects the CLI agent used by default; when omitted, `AGENT_CLI` is used (Qoder by default). An action-level `agent` overrides it. Supported values are `qoder`, `claude-code`, `copilot-cli`, `codex` and `gemini-cli`. Every distinct configured agent is validated and its authentication is checked at startup when `AGENT_AUTH_CHECK` is enabled (the fallback agents included). `default.model` applies to the default agent; set `model` on an action that uses another agent when it needs a specific model.
- The optional `fallback_agent` and `fallback_model` (per action, with `default.fallback_agent` / `default.fallback_model` as the global fallback) define a fallback run: when the primary run of a task fails (a CLI error or a task timeout — a user abort never triggers it), the task is re-run once with the fallback agent and model before the failure is reported. Each field is resolved independently with the action value first, then the `default.` value, then the primary agent/model (no change for that field). The fallback run is skipped when the resolved pair cannot differ from the primary pair (nothing configured, or configured identical): re-running the pair that just failed is a retry, not a fallback. The fallback run reuses the same working directory, instruction and task timeout (the full timeout applies again), the model/CLI provenance labels then record both the primary and the fallback pairs, and the still-working reporting follows the agent actually in flight. When the fallback run also fails, the normal failure handling applies with both errors in the explanation. An `agent-model:` line in the task description still overrides the fallback model, like every configured model.
- `weight` is the scheduling weight of the tasks handled by the action (a number greater than 0 and at most 1, e.g. `0.5` for a batch of small routine tasks); an `agent-weight:` line in the task description still takes precedence (see [Parallel scheduling](#parallel-scheduling)).
- `priority` overrides the queue priority of the tasks handled by the action: `high`, `medium` or `low` (case-insensitive; validated at startup like the other fields). When unset, the task's own Planner priority applies. It only changes the order in which ready tasks are picked (see [Parallel scheduling](#parallel-scheduling)); a task is still processed by the first matching action.
- `default.model` is the fallback model for actions without their own model, and `default.timeout` is the fallback timeout for actions without their own timeout. A model id must be accepted by the selected CLI (`gpt-6-luna` and not the display name `GPT-6 Luna`, for example): a bad id fails the task immediately with the CLI error.
- The task timeout is resolved per task with the following priority: the `timeout` of the matching action, then `default.timeout`, then the global `TASK_TIMEOUT` configuration (default `3600` = 1 hour). It must be a positive integer in seconds, at most `2147483` (the largest delay Node.js timers accept); a larger value is rejected when the actions file is loaded.
- `status_error` is the status a failed task is moved to (a CLI error, a task timeout, a preparation failure): it is resolved per task with the following priority: the `status_error` of the matching action, then `default.status_error`, then the action `status_end` (the historical behavior). A successfully processed task is always moved to the `status_end`. The resolved status must be one of the statuses of the target project on Planner.
- The configured statuses are validated against the project status catalogs at startup (on the first poll, when the catalogs can first be read): `status_start`, `status_end`, the resolved `status_error`, `status_in_progress` and `status_abort` of every action, plus `TASK_DEPENDENCY_SATISFIED_STATUS` (dependencies can point into any project). A status missing from a project the action applies to logs an actionable warning naming the setting, the project and its status catalog; a catalog fetch failure logs one warning. The agent keeps running either way, and a hot-reloaded actions file is not revalidated until the next restart.
- `status_in_progress` is the status a task is moved to while the agent works on it, so its processing state is visible on Planner. Resolved like `status_error` (action, then `default.status_in_progress`); when neither is set, no transition happens (the historical behavior). The transition is best-effort: when the project status catalog is known and does not contain the status, or when the transition fails, a warning is logged and the task keeps its current status while the processing continues.
- `status_abort` enables per-task cancellation (see [Cancelling a running task](#cancelling-a-running-task)). Resolved like `status_error` (action, then `default.status_abort`); when neither is set, no task of the action can be cancelled.
- The optional top-level `instructions` mapping defines named instruction templates: an action `instruction` value that exactly matches a template name resolves to the template content, so several actions can share one long instruction without repeating it. Any other value is used verbatim as an inline instruction, so existing configurations keep working. Template contents are validated at startup (a non-string or empty template fails fast).
- When the task timeout expires, the whole CLI process group is killed (SIGTERM, then SIGKILL after a 10 seconds grace period), so processes spawned by the coding-agent CLI (shells, `git`, `npm test`, dev servers) cannot survive the timeout. The task then fails and is moved to the resolved `status_error` with an explanation.
- When the agent starts working on a task, it marks the task with the transient `TASK_RUNNING_LABEL` label and records the model used (and optionally the CLI agent) as provenance labels; the provenance labels stay after the run (see [Task labels](#task-labels)). The legacy one-line start comment (`Agent '<AGENT_NAME>' started working on this task (model <model>).` — the model part only when a model is configured for the task) is disabled by default and re-enabled with `AGENT_START_COMMENT=true`; when enabled, a comment-triggered action posts it on the first run of a task only (stateless: no agent-authored comment exists yet), so a fast comment back-and-forth does not flood the task. The label writes and the comment are best-effort: a failure does not fail the task. While a task runs, a periodic "still working" comment with the elapsed time can be posted on it when `TASK_PROGRESS_COMMENT_INTERVAL` is set (disabled by default): one comment per interval instead of total silence between the start and the summary.
- The format is checked at startup: when the file exists but is invalid (bad YAML, missing or empty required fields, non-string projects, invalid timeouts, weights or priorities, unknown fields, duplicate project pattern and start status, an invalid `trigger` value, status-move fields set on a comment-triggered action, or a comments action shadowed by a pipeline action on the same start status and overlapping project patterns), the agent exits immediately with the list of problems.
- When the file does not exist, the agent starts with no action and processes no task (a warning is logged at startup).
- `TASK_STATUS_CLEANUP` still governs the deletion of the local task folder, whatever end status the task reached.
- The file is watched while the agent runs: a change is applied without restarting the agent (a few seconds at most after the file changes, plus the Kubernetes ConfigMap propagation delay of about one minute on a volume mount). A file created or fixed after a missing or invalid start is picked up too.
- A change applies to the tasks picked after it: a running task keeps the agent, model, instruction and timeout resolved when it started. The CLI authentication check and the model validation still run only at startup.
- A change is a no-op when the file content did not change. When the new content is invalid or the file disappears at runtime (e.g. a transient volume state), the error is logged and the last valid configuration is kept: the agent keeps processing tasks with it and applies the fix as soon as the file is valid again.
- The file must be mounted as a directory when Kubernetes provides it through a ConfigMap (e.g. `mountPath: /etc/planner`, without `subPath`): Kubernetes only propagates a ConfigMap update to a directory-mounted volume, while a `subPath` single-file mount keeps the content frozen until the pod is recreated (see [Deploying with Kubernetes](docs/deployments/kubernetes/README.md)).
- The path is resolved at startup: changing `AGENT_ACTIONS_FILE` at runtime (through `config.json`) does not move the watcher; restart the agent to change the path.

The model resolution order combining the actions with the environment configuration is described in [Model selection](#model-selection).

Example for a local test with a temporary actions file:

```sh
AGENT_ACTIONS_FILE=/tmp/llm-agent.yaml npm run dev
```

### Cancelling a running task

When an action (or `default.status_abort`) defines a `status_abort` status, the user can cancel a task while the agent works on it by moving the task to that status on Planner. On the next poll (the polls keep the base `TASK_POLLING_INTERVAL` cadence while tasks run, so the detection latency is bounded by the polling interval — about one minute with the default), the agent kills the whole CLI process group of the task (SIGTERM, then SIGKILL after a 10 seconds grace period, so processes spawned by the CLI cannot survive the cancellation), posts a short comment explaining that the task was aborted at user request and no summary was produced, and lets the task keep the status the user set: no end status, no error status, no finalization. The local task folder is cleaned up when the abort status is the `TASK_STATUS_CLEANUP` status, otherwise on a later poll once the task reaches it.

The abort also wins when the CLI already finished: if the task is moved to the abort status after the run but before the finalization (or before a finalization retry) applies the end status, the summary comment is still posted — aborted work is still reported — but the end status is not applied and the folder is not cleaned: the task keeps the status the user set. When that finalization status re-fetch fails, the decision is deferred to the next retry (no status update is attempted meanwhile).

A completed run is never re-executed because of a finalization failure or a restart: once the CLI work of a task is done, the pending finalization (summary comment and end status) is persisted under `DATA_DIR/finalization/<taskId>.json` with an atomic write and deleted only after a successful delivery. Pending records are reloaded at startup and delivered immediately, so a crash or rolling restart between the CLI completion and the Planner updates resumes the delivery instead of re-running the CLI. The delivery is idempotent: on a retry or after a restart the task is fetched and an identical summary comment already authored by the agent after the run start is detected and not posted again, so a lost comment-creation response never duplicates the summary (a task that is no longer visible is dropped instead of retried for a day). Idempotent Planner reads (GETs) retry up to 3 times with a jittered exponential backoff on a network error, a timeout and a 429/5xx response (the overall retry budget is bounded); plain 4xx responses and writes are never retried at the HTTP level — the writes are retried idempotently by the finalization loop. A failed request reports the truncated response body in its error message so the logs explain the failure.

### Validating the configuration

The actions file is validated at startup (an invalid file stops the agent), and it can also be checked without running the agent:

```sh
npm run check-config                     # from a source checkout
node dist/checkConfig.js                 # inside the container (compiled)
```

The command loads the actions file (`AGENT_ACTIONS_FILE`, default `/etc/planner/llm-agent.yaml`), prints the parsed configuration (the defaults, the instruction templates and every action with its resolved model, timeout, statuses and instruction) and exits `0` when the configuration is valid, `1` with the list of problems otherwise. A missing file is reported as valid (the agent then runs without any action).

## Core skills

The agent image ships a set of core skills that are always available to tasks, with no agent config repository required. They live in the image at `/opt/app/planner-llm-agent/skills` (one directory per skill, each with its `SKILL.md`) and cover the domains every deployment needs:

- `planner-tasks` — Planner tasks through the Planner API: read, search, create, update, comments, labels, dependencies, attachments, and the follow-up task recipe.
- `planner-notes` — Planner notes: list, read, create, update, comments, labels, attachments.
- `planner-projects` — Planner reference data: resolve projects, their statuses and human assignee ids.
- `planner-templates` — Planner task templates: CRUD, automation schedules, instance creation.
- `github-pull-request` — basic Git/GitHub workflow: branch, commit, push, open and update a pull request, merge conventions.
- `github-checks` — GitHub Actions checks: watch, diagnose failures, rerun policies.

Every task prompt lists the available skills (core and synced, with a one-line description each) and states where the core skills live, so the LLM can read the relevant `SKILL.md` before starting. A skill synced from the agent config repository with the same name **overrides** the core skill of that name — a deployment can customize a core skill without rebuilding the image. The directory can be relocated with `CORE_SKILLS_PATH` (useful in development setups where the skills folder does not sit next to the compiled code). The skills listing is built once per process and reused for every task prompt: it is rebuilt after each agent config repository sync and whenever `CORE_SKILLS_PATH`, `AGENT_CONFIG_REPOSITORY` or `AGENT_CONFIG_FOLDER` changes, so a synced skill change is visible on the first prompt after the next sync (at most `AGENT_CONFIG_SYNC_INTERVAL`, 300 seconds by default).

## Agent config repository

Skills, configuration files and other resources the agent should use are defined in a dedicated Git repository (the _agent config repository_). The agent clones it at startup, keeps a local copy under `/data/agent-config` (`/data/agent-config/<folder>` when `AGENT_CONFIG_FOLDER` is set) and refreshes it every `AGENT_CONFIG_SYNC_INTERVAL` seconds. The interval is hot-applied (a changed value re-arms the refresh without a restart, `0` disables the periodic refresh) while enabling the repository from empty remains a startup-only change (it needs the initial clone). The core skills shipped with the image (see [Core skills](#core-skills)) are available on top of it.

- The startup clone fails fast: the agent does not start when the repository cannot be cloned.
- A failed periodic refresh keeps the last synced copy and only logs an error.
- The working tree is forced to match the remote branch on every refresh, so the local copy is always a faithful mirror of the repository.
- Authentication uses the Git and GitHub settings above (GitHub token or SSH key); public repositories need no authentication.
- `AGENT_CONFIG_FOLDER` must be a relative path inside the repository: an absolute path, a backslash, a `..` segment or an empty segment is rejected at startup (a trailing slash is accepted and trimmed), so the sparse checkout can never escape the synced copy.
- Every task prompt tells the agent where the configuration is synced, so skills and resources are directly usable during task execution.
- Every task prompt also lists the available skills — the core skills shipped with the image plus the `skills/<name>/SKILL.md` entries of the repository (a synced skill with the same name wins), with a one-line description each — so the LLM knows which skill to read before starting. The Copilot CLI does not discover the image skills or the synced repository on its own: at startup the agent registers both skills directories with `copilot skill add`, which makes the CLI expose the skills to the model in every run (best-effort, see [CLI agent](#cli-agent)).

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

When `AGENT_NOTE_PROJECT` is set, the agent maintains a single Planner note in that project, titled `Planner LLM Agent: <AGENT_NAME>`. The note is created when missing and updated in place afterwards — it is never duplicated. An existing note titled with the plain agent name (previous format) is adopted and retitled on the next update.

The note content is generated by the LLM from facts collected by the agent:

- Agent identity: name, version, current date and session uptime
- Mission: the agent actions configuration (projects, statuses, models and instructions) and the effective default model
- Capabilities: the skills available to tasks (the core skills shipped with the image plus the agent config repository content)
- Git and GitHub integration: authentication and commit signing setup, including the organizations with dedicated tokens
- Activity: the number of tasks executed and the titles of the most recent ones
- Live scheduling state: the tasks currently being processed (title, elapsed time, model) and the queue behind the capacity budget (count and titles)
- Account status: the usage metric reported by the CLI (Qoder credits used by the last run, cost of the last Claude Code run, ...)

The note is updated when the agent starts (so a configuration change is picked up on every restart) and then every `AGENT_NOTE_INTERVAL` seconds (86400 = daily by default, set `3600` for hourly updates). The project and interval are hot-applied: changing `AGENT_NOTE_INTERVAL` re-arms the timer without a restart, setting `AGENT_NOTE_PROJECT` on a running agent enables and immediately updates the note, and `0` disables the scheduled updates. A failed update is logged and retried on the next interval; it never stops the agent.

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
npm run lint    # oxlint
npm test        # jest
npm run check-config   # validate the agent actions file and print the resolved actions
npm run dev     # run locally against a Planner instance
```

## License

[MIT](LICENSE)
