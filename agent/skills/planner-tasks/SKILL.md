---
name: planner-tasks
description: "Use when a task needs to read Planner data (tasks, comments, attachments) or create and update tasks through the Planner API — especially to create a follow-up implementation task that the Planner LLM Agent itself picks up and processes."
---

Read and create tasks in Planner through its authenticated JSON API. The core use case is the **follow-up implementation recipe**: creating a task that the Planner LLM Agent itself picks up on its next poll and processes through its pipeline.

## Context

- Server: the `$PLANNER_URL` environment variable (in-cluster service URL)
- Server implementation: the Planner server repository (linked from the agent README) — authoritative endpoint reference: its `planner-server/src/tasks/TasksRoutes.ts`
- API key: the value of the `PLANNER_API_KEY` environment variable, sent as header `x-api-key: $PLANNER_API_KEY`; it identifies the agent's Planner user (role `user`)
- Local per-task files: the task document `$DATA_DIR/tasks/<taskId>-Agent.md` (auto-refreshed at the start of each run; the `## Agent Notes` section it contains is preserved across runs) and its attachments under `$DATA_DIR/tasks/<taskId>/attachments/`. The summary file `$DATA_DIR/tasks/<taskId>-Agent-Summary.md` is posted as a comment on the task when the run completes.
- Agent processing configuration: `/etc/planner/llm-agent.yaml` (readable in-container) defines which project/status combinations the agent acts on

## Prerequisites

```bash
# Both variables must be present; never hard-code or guess their values
[ -n "$PLANNER_URL" ] && [ -n "$PLANNER_API_KEY" ] && echo "planner access configured" || echo "MISSING $PLANNER_URL / $PLANNER_API_KEY"
```

If either variable is unset, report the missing prerequisite instead of continuing.

## Endpoint reference

All endpoints are relative to `$PLANNER_URL` and require the `x-api-key` header.

| Method | Endpoint | Body | Response |
| --- | --- | --- | --- |
| `POST` | `/api/users/session` | — | `{success, token, user: {id, name, role}}` — the agent's identity; `token` is a JWT (not needed for further calls, `x-api-key` is enough) |
| `GET` | `/api/tasks` | query: `projectId`, `projectIds` (comma-separated), `q` (case-insensitive substring over title and description), `labels` (comma-separated, AND), `assigneeUserId`, `doneSince` (date, e.g. `2026-09-14`), `fields` (comma-separated sparse fieldsets), `limit`, `offset` | array of **full** task objects (same shape as below) |
| `GET` | `/api/tasks/:id` | — | full task object: `id, projectId, title, status, description, priority, dueDate, checklist, assignees: [{userId, userName}], comments: [{id, text, userId, userName, dateCreated, dateUpdated}], attachments, labels, dependencies: [{taskId, title?, status?}], dateCreated, dateUpdated` |
| `POST` | `/api/tasks` | `{projectId, title, description?, status?, priority?, dueDate?, assignees?: [userId], labels?, checklist?, dependencies?: [taskId]}` | `201` with the created task |
| `PUT` | `/api/tasks/:id` | `{title?, description?, status?, priority?, dueDate?, checklist?}` | updated task |
| `POST` | `/api/tasks/:id/comments` | `{text}` | created comment |
| `POST` | `/api/tasks/:id/assignees` | `{userId}` | `{}` — adds one assignee |
| `DELETE` | `/api/tasks/:id/assignees/:userId` | — | `{}` — removes the assignee |
| `POST` | `/api/tasks/:id/labels` | `{labels: [<name>]}` | `{}` — **replaces** the whole label list (clears, then adds) |
| `POST` | `/api/tasks/:id/dependencies` | `{dependencies: [taskId]}` | `{}` — **replaces** the whole dependency list (like labels) |
| `POST` | `/api/tasks/:id/attachments` | multipart, one file | `{id, fileName, filePath, dateCreated}` |
| `GET` | `/api/tasks/:id/attachments/:attachmentId` | query: `inline=true` streams images inline | the file stream |

Project create/update is admin-only; the agent user has role `user` — never attempt it.

## Workflow

### 1. Discover the agent identity and the agent pipeline

```bash
PLANNER_AUTH="x-api-key: $PLANNER_API_KEY"
curl -s -X POST -H "$PLANNER_AUTH" "$PLANNER_URL/api/users/session" | jq '.user'
cat /etc/planner/llm-agent.yaml
```

The actions file lists the project/statuses the agent processes (`status_start` → `status_end`; patterns are full-string globs matched against the project name). The default model is in `default.model`.

### 2. Read tasks and their data

```bash
# All tasks the agent can see; narrow with filters
curl -s -H "$PLANNER_AUTH" --get "$PLANNER_URL/api/tasks" \
  --data-urlencode "projectId=$PROJECT_ID" | jq .
curl -s -H "$PLANNER_AUTH" "$PLANNER_URL/api/tasks/$TASK_ID" | jq .
```

Beyond the API, each task also exists locally: read `$DATA_DIR/tasks/<taskId>-Agent.md` for the task document (including its `## Agent Notes` history) and look in `$DATA_DIR/tasks/<taskId>/attachments/` for files attached to it.

### 3. Create a task

```bash
# Resolve ids first (to assign a human instead of the agent, resolve their id with GET /api/users/picker)
PROJECT_ID=$(curl -s -H "$PLANNER_AUTH" "$PLANNER_URL/api/projects" | jq -r '.[] | select(.name=="<project>") | .id')
AGENT_ID=$(curl -s -X POST -H "$PLANNER_AUTH" "$PLANNER_URL/api/users/session" | jq -r '.user.id')

curl -s -X POST -H "$PLANNER_AUTH" -H "Content-Type: application/json" \
  -d "{\"projectId\":\"$PROJECT_ID\",\"title\":\"<title>\",\"description\":\"<description>\",\"status\":\"<status>\",\"assignees\":[\"$AGENT_ID\"]}" \
  "$PLANNER_URL/api/tasks" | jq '{id, status, assignees}'
```

Defaults when fields are omitted: status `To Do`, priority `medium`, and **assignee = the API-key user (the agent itself)** — override `assignees` explicitly to assign a human instead.

`dependencies` takes task ids: each must be an existing task visible to the API-key user (`404` otherwise), a task cannot depend on itself (`400`), duplicates are dropped, and dependencies may cross projects. Task responses embed each dependency's current `title` and `status`.

### 4. Follow-up implementation recipe (agent-picked-up task)

To hand work to a future agent run (e.g. a `Plan` run creating the `Doing` follow-up):

1. Read `/etc/planner/llm-agent.yaml` and pick the action whose `status_start` matches the work to trigger (e.g. `Doing`).
2. Resolve the project id (`GET /api/projects`, match by `name`) and the agent's own userId (`POST /api/users/session`).
3. Create the task in that project with `status` = the action's `status_start`, `dependencies: [<id of the task triggering the creation>]` and the **assignees of the task triggering the creation** (unless the task or a comment states otherwise). The agent picks a task up on its next poll only when **project + start status + assignee** all match one of its actions — for agent pickup the triggering task must therefore list the agent's userId. For an action with `trigger: comments` (conversational mode), the agent additionally picks the task up only when it has zero comments or its last comment was not authored by the agent: the agent answers by posting a summary comment and never changes the task status, so a new user comment re-triggers a run while a conversation waiting for the user stays untouched (retry after a failure = comment again; resume after an abort = move the task back to the start status and comment again).
4. **Sequence multiple follow-ups with dependencies**: chain them — the first follow-up depends on the task triggering the creation, the next one on the previous follow-up — instead of queuing them in parallel. The agent only implements a task whose dependencies are all `Done`; a blocked task is deferred (reason `dependency:<taskId>`, no status change, no error comment) and picked up automatically once the dependencies complete.
5. Write a **self-contained description** — the next run has no memory of this conversation. Include: the goal, the repository (and local clone path if one exists), the plan (or a reference to the plan comment on the current task), constraints, and acceptance criteria. An optional `agent-model: <model>` line overrides the model for that run.
6. Cross-link: comment on the current task with the follow-up task id and title (`POST /api/tasks/:id/comments`); re-upload any required files as attachments on the follow-up task (multipart `POST /api/tasks/:id/attachments`) or reference durable URLs.
7. Report the created task id in the task summary so it can be traced back.

### 5. Update a task

```bash
curl -s -X PUT -H "$PLANNER_AUTH" -H "Content-Type: application/json" \
  -d '{"status":"<status>"}' "$PLANNER_URL/api/tasks/$TASK_ID" | jq .status

curl -s -X POST -H "$PLANNER_AUTH" -H "Content-Type: application/json" \
  -d '{"text":"<comment>"}' "$PLANNER_URL/api/tasks/$TASK_ID/comments" | jq .
```

Use `PUT` for `title`, `description`, `status`, `priority`, `dueDate` and `checklist`; use the dedicated endpoints for comments, assignees, labels (whole-list replace) and attachments.

## Gotchas

- **Default assignee is the agent itself**: a `POST /api/tasks` without `assignees` creates a task assigned to the API-key user, not to a human.
- **Dependencies gate agent pickup**: a task with a dependency that is not `Done` is skipped by the agent (deferred with reason `dependency:<taskId>`) and retried on later polls — create follow-up tasks with dependencies to respect sequence. Validation: dependency ids must be visible tasks (`404`), self-reference is rejected (`400`), duplicates are dropped; `POST /api/tasks/:id/dependencies` replaces the whole list, like labels.
- **Status must exist in the target project**: each project carries its own `statuses` list; a status name outside it is invalid. Check `GET /api/projects` first.
- **Never move a task the agent is processing**: tasks matching an action's start status are auto-moved to the action's end status by the agent; moving an in-flight task manually breaks the pipeline bookkeeping.
- **Comment-triggered actions never change the status**: a task handled by a `trigger: comments` action stays in its start status forever (the agent posts its answer as a comment). To retry a failed conversational run, comment on the task again; to resume after an abort, move the task back to the start status and comment again — the pickup rule is stateless (zero comments, or the last comment not authored by the agent), so no other action is needed.
- **Done tasks disappear locally**: when a task reaches the `Done` cleanup status, its local folder under `$DATA_DIR/tasks/` is deleted — persist anything needed before then.
- **Project management is admin-only**: the agent user cannot create or update projects; never attempt it.
- **Never put secrets in task descriptions or comments**: they are visible in the Planner UI and stored in plaintext.
- **Restricted project visibility**: projects with `visibility: restricted` only appear in `GET /api/projects` for users in `userAccess` — an empty result may mean missing access, not that the project does not exist.
