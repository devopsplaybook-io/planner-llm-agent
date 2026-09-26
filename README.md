# planner-llm-agent

LLM agent that connects to a [Planner](https://github.com/devopsplaybook-io/planner) instance and can be assigned tasks to execute.

The agent polls the Planner API for tasks assigned to its user and executes the tasks selected by its _actions_ configuration (a YAML file, see [Agent actions](#agent-actions)). It runs the tasks with a coding-agent CLI (Qoder by default; Claude Code, Copilot CLI, Codex and Gemini CLI are also supported, see [CLI agent](#cli-agent)), notifies the user with a one-line comment when it starts working on a task, posts the result as a task comment and moves the task to the end status of the matching action. For each task it maintains a documentation file at `/data/tasks/[id]-Agent.md` that keeps the context of the task across runs and includes the name and description of the task project. Task attachments are downloaded to `/data/tasks/[id]/attachments/` and listed in the documentation file so the LLM can use them. When a task reaches the cleanup status (default `Done`) the agent deletes its local task folder, and periodically removes folders for tasks that are no longer assigned or have reached the cleanup status.

Polling stays quiet: log entries are only emitted when a task is ready to be processed and during its processing (plus errors), not on every poll cycle.

Tasks are processed with a bounded parallelism driven by a weighted capacity budget (`TASK_MAX_PARALLEL`, default `1`): every task consumes a scheduling weight between 0.25 and 1, and tasks are admitted while their total weight fits the budget, so several small tasks can share what a single large task would consume. Tasks that would exceed the budget or work on a resource already claimed by a running task are deferred to a later poll (with the reason logged) instead of blocking the queue, and a task already being processed is never picked again by a subsequent poll. Ready tasks are picked by priority first (high, then medium, then low; an unknown or missing priority ranks as medium) and, within the same priority, the task whose last update is the oldest is picked first, so the tasks waiting the longest without any update go first. A task that fails to process is not retried forever: it is moved to the end status with a comment explaining the error (kept concise in the comment; see the agent logs for full details), so it does not block the queue. The whole scheduling model is described in [Parallel scheduling](#parallel-scheduling) and can be reverted to the historical count-based behavior with `TASK_SMART_SCHEDULING=false`.

The container ships all the toolchains needed to perform the tasks (Node.js, Python, Go, Rust, Java, shellcheck, jq, yq, kubectl, helm), every supported coding-agent CLI (see [CLI agent](#cli-agent)) as well as a complete Git and GitHub tooling set (`git`, `gh`, `gnupg`, `openssh-client`).

## Configuration

Configuration values are resolved with the following priority:

1. Environment variables (highest)
2. `config.json` file
3. Defaults (lowest)

### Agent

| Variable                | Default                       | Description                                                               |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `AGENT_NAME`            | `planner-llm-agent`           | Planner user name the agent acts as (also used in the agent note title)   |
| `AGENT_ACTIONS_FILE`    | `/etc/planner/llm-agent.yaml` | Path of the agent actions YAML file, watched for changes at runtime (see [Agent actions](#agent-actions)) |
| `PLANNER_URL`           | `http://localhost:8080`       | Planner instance base URL                                                 |
| `PLANNER_API_KEY`       | (empty)                       | Planner API key (required)                                                |
| `TASK_POLLING_INTERVAL` | `60`                          | Seconds between polls of assigned tasks                                   |
| `TASK_STATUS_CLEANUP`   | `Done`                        | Local task folder is deleted when a task reaches this status              |
| `TASK_MAX_PARALLEL`     | `1`                           | Weighted capacity budget of the parallel scheduling (decimals allowed, e.g. `1.9`; at most ceil(budget) CLI processes run concurrently; see [Parallel scheduling](#parallel-scheduling)) |
| `TASK_SMART_SCHEDULING` | `true`                        | Weighted, conflict-aware scheduling when `true`; `false` restores the historical count-based parallelism |
| `TASK_CONFLICT_MODE`    | `repo`                        | Automatic conflict keys derived from the task content: `repo`, `project` or `none` (see [Parallel scheduling](#parallel-scheduling)) |
| `AGENT_UTILITY_MODEL`   | (empty)                       | Fast/cheap model (on the configured CLI) pre-evaluating the weight and repositories of hint-less tasks; empty disables it (zero LLM calls) |
| `TASK_TIMEOUT`          | `3600`                        | Maximum duration of a task execution in seconds (fallback when the actions configuration defines no timeout) |
| `DATA_DIR`              | `/data`                       | Persistent data directory (task documentation files)                      |
| `TMP_DIR`               | `/tmp`                        | Temporary directory                                                       |
| `DEV_MODE`              | `false`                       | Development mode flag                                                     |

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

Only Qoder supports a model listing; for the other CLIs the model validation is skipped. Some CLIs do not report a usage metric (credits or cost): the task report footer then only displays the model, without warning.

### Model selection

The model used for a task is resolved with the following priority:

1. An `agent-model: <model>` line in the task description (per-task override; the legacy `qoder-model:` line is still accepted)
2. The `model` of the matching action (see [Agent actions](#agent-actions))
3. The `default.model` of the actions configuration
4. The CLI default model (when none of the above is set)

When a task starts and the selected CLI supports a model listing (Qoder), the resolved model is checked against the models available to the account (`qoder --list-models`, fetched once and cached). A model outside of that list is logged as a warning (with the available models) but the task still runs — the CLI remains the authority on what it can execute. For the other CLIs the validation is skipped.

Example task description requesting a specific model:

```
Fix the failing unit tests in the payment module and update the documentation.
agent-model: claude-sonnet-4-5
```

When the actions configuration sets a `default.model`, the startup authentication probe also runs with that model, so a misconfigured model fails fast at startup instead of on the first task.

### Task execution report

Every task comment posted to Planner ends with a footer that displays the model used and the usage metric reported by the CLI for the task execution:

```
---
Model: claude-sonnet-4-5 · Qoder credits used: 3.81
```

The usage metric depends on the selected CLI: the Qoder credits consumed by the run (`total_credits`, persisted in `<DATA_DIR>/qoder-credits.json`) or the cost of the Claude Code run (`total_cost_usd`). Both are per-run values, not account balances. CLIs that report no metric (Copilot CLI, Codex, Gemini CLI) only display the model in the footer. The model is displayed as `auto` when no model is configured for the task.

### Git and GitHub

All Git and GitHub settings are optional: the agent automatically prepares the environment based on what is configured, and skips the setup entirely when none of `GITHUB_TOKEN`, `GIT_SSH_PRIVATE_KEY` or `GIT_GPG_PRIVATE_KEY` is provided. The environment is prepared at startup, before the first task runs, and any invalid value makes the agent fail fast with a clear message.

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
| `AGENT_CONFIG_FOLDER`        | (empty) | Only sync this folder of the repository (sparse checkout)           |
| `AGENT_CONFIG_SYNC_INTERVAL` | `300`   | Seconds between refreshes of the local copy                         |

### Agent note

| Variable              | Default | Description                                                                                |
| --------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `AGENT_NOTE_PROJECT`  | (empty) | Planner project where the agent note is published (id or name; empty disables the feature) |
| `AGENT_NOTE_INTERVAL` | `86400` | Seconds between agent note updates (default: daily); `0` disables the updates              |

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
- Evaluations are cached per task content version (a task is evaluated once per update, not per poll), only the tasks that could still be admitted this round are evaluated, at most 3 evaluations run concurrently and never more than the process cap of the scheduler (every evaluation is one CLI process), and each is bounded by a 60 seconds timeout. A failing or slow utility model never blocks the scheduling: the task falls back to the default weight and the deterministic conflict keys, and the failure is logged once per content version.
- When `AGENT_UTILITY_MODEL` is empty (the default) the evaluator makes zero LLM calls.

### Working directory and instances

Each task runs in its own working directory `DATA_DIR/tasks/<taskId>/` (stated in the task prompt), so parallel tasks never share one and cannot collide on the filesystem. The scheduling state (running tasks, weights, locks, evaluation cache) is kept in memory: one agent process per agent identity is assumed and cross-instance scheduling is not supported — run a single replica per agent identity.

### Observability and kill switch

Every poll with picks or deferrals logs one `Scheduling round:` line (`picked:` with the weights, `deferred:` with the reasons) and the running tasks are reported on every poll while tasks run (title, project, weight, elapsed time, model). The following OpenTelemetry metrics are exported when instrumentation is enabled: the gauges `scheduler.running-weight` and `scheduler.queue-depth` and the counters `scheduler.tasks.picked` and `scheduler.tasks.deferred` (grouped by reason).

Setting `TASK_SMART_SCHEDULING=false` restores the historical behavior exactly: `TASK_MAX_PARALLEL` is a plain task count, weights, conflict keys and the utility model are ignored (no LLM call).

## Agent actions

The actions of the agent are defined in a YAML file (path `AGENT_ACTIONS_FILE`, default `/etc/planner/llm-agent.yaml`). Each action binds a Planner project pattern and a start status to an optional model, an optional instruction, an optional timeout and an end status:

```yaml
default:
  agent: qoder
  model: DeepSeek-Flash
  timeout: 3600
actions:
  - project: Web
    status_start: To Do
    status_end: In Review
    agent: copilot-cli
    model: DeepSeek-Flash
    instruction: Follow the repository coding guidelines and open a PR when the task is done.
    timeout: 1800
    weight: 0.75
  - project: Project*
    status_start: Blocked
    status_end: Done
  - status_start: In Progress
    status_end: Done
```

For every poll, the agent checks if an assigned task matches the project pattern and the start status of an action. Matching tasks are processed with the action model and instruction (on top of the task information) and moved to the action end status once processed (including after a processing failure, same as the default behavior).

- `status_start` and `status_end` are required; `project`, `agent`, `model`, `instruction`, `timeout` and `weight` are optional. `project` matches any project when missing, null or empty; otherwise it is a case-sensitive glob pattern where `*` matches any sequence of characters (e.g. `Project*` matches `Projects` and `Projects - Planner`). Overlapping patterns are allowed: the first matching action in the list processes the task, and a task whose project cannot be resolved never matches a project-bound action.
- `default.agent` selects the CLI agent used by default; when omitted, `AGENT_CLI` is used (Qoder by default). An action-level `agent` overrides it. Supported values are `qoder`, `claude-code`, `copilot-cli`, `codex` and `gemini-cli`. Every distinct configured agent is validated and its authentication is checked at startup when `AGENT_AUTH_CHECK` is enabled. `default.model` applies to the default agent; set `model` on an action that uses another agent when it needs a specific model.
- `weight` is the scheduling weight of the tasks handled by the action (a number greater than 0 and at most 1, e.g. `0.5` for a batch of small routine tasks); an `agent-weight:` line in the task description still takes precedence (see [Parallel scheduling](#parallel-scheduling)).
- `default.model` is the fallback model for actions without their own model, and `default.timeout` is the fallback timeout for actions without their own timeout.
- The task timeout is resolved per task with the following priority: the `timeout` of the matching action, then `default.timeout`, then the global `TASK_TIMEOUT` configuration (default `3600` = 1 hour). It must be a positive integer in seconds.
- When the task timeout expires, the whole CLI process group is killed (SIGTERM, then SIGKILL after a 10 seconds grace period), so processes spawned by the coding-agent CLI (shells, `git`, `npm test`, dev servers) cannot survive the timeout. The task then fails and is moved to the end status with an explanation.
- When the agent starts working on a task, it posts a one-line comment on the task (`Agent '<AGENT_NAME>' started working on this task.`) to notify the user. This notification is best-effort: a failure to post it does not fail the task.
- The format is checked at startup: when the file exists but is invalid (bad YAML, missing or empty required fields, non-string projects, invalid timeouts or weights, unknown fields, duplicate project pattern and start status), the agent exits immediately with the list of problems.
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

## Agent config repository

Skills, configuration files and other resources the agent should use are defined in a dedicated Git repository (the _agent config repository_). The agent clones it at startup, keeps a local copy under `/data/agent-config` (`/data/agent-config/<folder>` when `AGENT_CONFIG_FOLDER` is set) and refreshes it every `AGENT_CONFIG_SYNC_INTERVAL` seconds.

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

When `AGENT_NOTE_PROJECT` is set, the agent maintains a single Planner note in that project, titled `Planner LLM Agent: <AGENT_NAME>`. The note is created when missing and updated in place afterwards — it is never duplicated. An existing note titled with the plain agent name (previous format) is adopted and retitled on the next update.

The note content is generated by the LLM from facts collected by the agent:

- Agent identity: name, version, current date and session uptime
- Mission: the agent actions configuration (projects, statuses, models and instructions) and the effective default model
- Capabilities: the skills available from the agent config repository
- Git and GitHub integration: authentication and commit signing setup, including the organizations with dedicated tokens
- Activity: the number of tasks executed and the titles of the most recent ones
- Account status: the usage metric reported by the CLI (Qoder credits used by the last run, cost of the last Claude Code run, ...)

The note is updated when the agent starts (so a configuration change is picked up on every restart) and then every `AGENT_NOTE_INTERVAL` seconds (86400 = daily by default, set `3600` for hourly updates). A failed update is logged and retried on the next interval; it never stops the agent.

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
npm run dev     # run locally against a Planner instance
```
