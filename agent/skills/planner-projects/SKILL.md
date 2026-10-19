---
name: planner-projects
description: "Use when a task needs to resolve Planner projects, their statuses or the Planner users — find a project id, check which statuses a project supports, or resolve a human assignee id."
---

Resolve the Planner reference data tasks and notes depend on: projects, their per-project statuses and the user list for assigning humans.

## Context

- Server: the `$PLANNER_URL` environment variable (in-cluster service URL)
- Server implementation: the Planner server repository (linked from the agent README) — authoritative endpoint references: its `planner-server/src/projects/ProjectsRoutes.ts`, `planner-server/src/statuses/StatusesRoutes.ts` and `planner-server/src/users/UsersRoutes.ts`
- API key: the value of the `PLANNER_API_KEY` environment variable, sent as header `x-api-key: $PLANNER_API_KEY`; it identifies the agent's Planner user (role `user`)

## Prerequisites

```bash
[ -n "$PLANNER_URL" ] && [ -n "$PLANNER_API_KEY" ] && echo "planner access configured" || echo "MISSING $PLANNER_URL / $PLANNER_API_KEY"
```

If either variable is unset, report the missing prerequisite instead of continuing.

## Endpoint reference

All endpoints are relative to `$PLANNER_URL` and require the `x-api-key` header.

| Method | Endpoint | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/api/projects` | — | array of `{id, name, description, isDefault, archived, visibility, userAccess, statuses: [<status name>]}` — restricted projects are hidden without access; `statuses` are plain strings and differ per project |
| `GET` | `/api/projects/:id` | — | project object; `404` when missing or invisible |
| `GET` | `/api/statuses` | — | `{statuses: [{name, color}]}` — the global status catalog |
| `GET` | `/api/users/picker` | — | `[{id, name}]` — use this to resolve human assignees (`GET /api/users` is admin-only) |

Project create/update/delete is admin-only; the agent user has role `user` — never attempt it. The status catalog (`PUT /api/statuses`) is admin-only as well.

## Workflow

### Resolve a project by name

```bash
PLANNER_AUTH="x-api-key: $PLANNER_API_KEY"
curl -s -H "$PLANNER_AUTH" "$PLANNER_URL/api/projects" \
  | jq '.[] | {id, name, statuses, visibility}'

PROJECT_ID=$(curl -s -H "$PLANNER_AUTH" "$PLANNER_URL/api/projects" \
  | jq -r '.[] | select(.name=="<project>") | .id')
```

### Check the statuses of a project

```bash
curl -s -H "$PLANNER_AUTH" "$PLANNER_URL/api/projects" \
  | jq -r '.[] | select(.name=="<project>") | .statuses[]'
```

### Resolve a human assignee

```bash
curl -s -H "$PLANNER_AUTH" "$PLANNER_URL/api/users/picker" | jq .
USER_ID=$(curl -s -H "$PLANNER_AUTH" "$PLANNER_URL/api/users/picker" \
  | jq -r '.[] | select(.name=="<user name>") | .id')
```

## Gotchas

- **Project management is admin-only**: the agent user cannot create, update or delete projects; never attempt it.
- **Restricted project visibility**: projects with `visibility: restricted` only appear in `GET /api/projects` for users in `userAccess` — an empty result may mean missing access, not that the project does not exist (`GET /api/projects/:id` answers the same `404` for missing and invisible projects).
- **Statuses must exist in the target project**: each project carries its own `statuses` list; a status name outside it is invalid when creating or updating a task. The global catalog (`GET /api/statuses`) lists every known status name, but only the project's own list is valid for its tasks.
- **Archived projects**: tasks and notes of archived projects still read fine, but creating or updating content in an archived project is rejected (`400`).
