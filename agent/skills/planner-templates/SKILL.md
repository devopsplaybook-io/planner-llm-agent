---
name: planner-templates
description: "Use when a task needs to manage recurring work through Planner task templates — create, update or inspect a template, configure its automation schedule, or create a task instance from it."
---

Manage Planner task templates through its authenticated JSON API. A task template is a reusable task definition; the Planner scheduler creates task instances from templates with an automation schedule, and instances can also be created on demand.

## Context

- Server: the `$PLANNER_URL` environment variable (in-cluster service URL)
- Server implementation: the Planner server repository (linked from the agent README) — authoritative endpoint reference: its `planner-server/src/tasktemplates/TaskTemplatesRoutes.ts`
- API key: the value of the `PLANNER_API_KEY` environment variable, sent as header `x-api-key: $PLANNER_API_KEY`; it identifies the agent's Planner user (role `user`)

## Prerequisites

```bash
[ -n "$PLANNER_URL" ] && [ -n "$PLANNER_API_KEY" ] && echo "planner access configured" || echo "MISSING $PLANNER_URL / $PLANNER_API_KEY"
```

If either variable is unset, report the missing prerequisite instead of continuing.

## Endpoint reference

All endpoints are relative to `$PLANNER_URL/api/task-templates` and require the `x-api-key` header.

| Method | Endpoint | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/` | query: `projectId` (exact match), `projectIds` (comma-separated), `q` (case-insensitive substring over title and description) | array of template objects |
| `GET` | `/:id` | — | template object; `404` when missing or invisible |
| `POST` | `/` | `{projectId, title, description?, priority?, checklist?: [{text, done}], automation?, assignees?: [userId], labels?: [name]}` | `201` with the created template; `400` when `projectId`/`title` is missing, the project is archived or `automation` is invalid; `403` without `update` permission on the project |
| `PUT` | `/:id` | same fields as `POST` (all optional, `projectId` movable) | updated template |
| `DELETE` | `/:id` | — | `{}` — requires the `all` permission on the project |
| `POST` | `/:id/create-instance` | — | `201` with the created task |
| `POST` | `/:id/comments` | `{text}` | created comment |
| `PUT` | `/:id/comments/:commentId` | `{text}` | updated comment (own comments only) |
| `DELETE` | `/:id/comments/:commentId` | — | `{}` (own comments only) |
| `POST` | `/:id/attachments` | multipart, one file | created attachment object (requires `update` permission) |
| `GET` | `/:id/attachments/:attachmentId` | query: `inline=true` streams images inline | the file stream |
| `DELETE` | `/:id/attachments/:attachmentId` | — | `{}` |

The `automation` object (validated server-side):

```json
{
  "scheduleCron": "0 9 * * 1",
  "skipIfPreviousNotDone": false,
  "addDateToTitle": false,
  "instanceStatus": "To Do"
}
```

- `scheduleCron`: a valid 5-field cron string (or `null` to remove the schedule); the server scheduler creates an instance at each matching time.
- `skipIfPreviousNotDone`: skip a scheduled instance when the previous one is not `Done` yet.
- `addDateToTitle`: suffix the instance title with the creation date (`<title> YYYY.MN.DD`).
- `instanceStatus`: initial status of created instances; must exist in the project's `statuses` list (checked at create/update time).

Permissions: creating, updating, deleting attachments and creating an instance require project `update`; template comments require project `comment`; deleting a template requires the `all` permission.

## Workflow

### Find templates of a project

```bash
PLANNER_AUTH="x-api-key: $PLANNER_API_KEY"
PROJECT_ID=$(curl -s -H "$PLANNER_AUTH" "$PLANNER_URL/api/projects" | jq -r '.[] | select(.name=="<project>") | .id')

curl -s -H "$PLANNER_AUTH" --get "$PLANNER_URL/api/task-templates" \
  --data-urlencode "projectId=$PROJECT_ID" | jq '.[] | {id, title, scheduleCron}'
```

### Create a template

```bash
curl -s -X POST -H "$PLANNER_AUTH" -H "Content-Type: application/json" \
  -d "{\"projectId\":\"$PROJECT_ID\",\"title\":\"<title>\",\"description\":\"<what each instance should do>\",\"assignees\":[\"$AGENT_ID\"],\"automation\":{\"scheduleCron\":\"0 9 * * 1\",\"skipIfPreviousNotDone\":true}}" \
  "$PLANNER_URL/api/task-templates" | jq '{id, title, scheduleCron}'
```

Resolve human assignee ids with `GET /api/users/picker` first (see the planner-projects skill); the agent's own id comes from `POST /api/users/session`.

### Create an instance on demand

```bash
curl -s -X POST -H "$PLANNER_AUTH" "$PLANNER_URL/api/task-templates/$TEMPLATE_ID/create-instance" | jq '{id, title, status}'
```

## Gotchas

- **404 hides restricted templates**: a template in a project the agent cannot see answers `404`, indistinguishable from a missing template.
- **instanceStatus must exist in the project statuses**: a status outside the project's list is rejected at create/update time; a status removed from the project later is silently cleared from the template and instances fall back to the project's first status.
- **The server scheduler creates instances automatically** from `scheduleCron` — do not create a duplicate instance by hand right after a scheduled one.
- **skipIfPreviousNotDone only applies to scheduled instances**: on-demand `create-instance` calls always create a task.
- **Instances are plain tasks**: the created task starts in `instanceStatus` (or the project's first status), carries the template's assignees, labels and checklist, and has no due date unless the automation adds one.
- **Archived projects reject templates**: creating a template or an instance in an archived project fails with `400`.
