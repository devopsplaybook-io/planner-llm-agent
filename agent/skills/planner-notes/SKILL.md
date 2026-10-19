---
name: planner-notes
description: "Use when a task needs to read, create or update Planner notes through the Planner API — status notes, documentation pages and other long-lived content attached to a project."
---

Read and write notes in Planner through its authenticated JSON API. Notes are the long-lived content of a project (status notes, how-tos, reports), as opposed to tasks which are work items.

## Context

- Server: the `$PLANNER_URL` environment variable (in-cluster service URL)
- Server implementation: the Planner server repository (linked from the agent README) — authoritative endpoint reference: its `planner-server/src/notes/NotesRoutes.ts`
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
| `GET` | `/api/notes` | query: `projectId` (exact match), `projectIds` (comma-separated), `q` (case-insensitive substring over title and description) | array of note objects: `{id, projectId, title, description, comments, attachments, labels, dateCreated, dateUpdated}` |
| `GET` | `/api/notes/:id` | — | note object; `404` when missing or invisible (restricted notes are not distinguishable from missing ones) |
| `POST` | `/api/notes` | `{projectId, title, description?, labels?}` | `201` with the created note; `400` when `projectId` or `title` is missing or the project is archived; `403` without `update` permission on the project |
| `PUT` | `/api/notes/:id` | `{title?, description?, projectId?}` | updated note (moving to another project re-checks its visibility, archived state and `update` permission) |
| `DELETE` | `/api/notes/:id` | — | `{}` — requires the `all` permission on the project |
| `POST` | `/api/notes/:id/comments` | `{text}` | created comment |
| `PUT` | `/api/notes/:id/comments/:commentId` | `{text}` | updated comment (own comments only) |
| `DELETE` | `/api/notes/:id/comments/:commentId` | — | `{}` (own comments only) |
| `POST` | `/api/notes/:id/labels` | `{labels: [<name>]}` | `{}` — **replaces** the whole label list |
| `POST` | `/api/notes/:id/attachments` | multipart, one file | created attachment object |
| `GET` | `/api/notes/:id/attachments/:attachmentId` | query: `inline=true` streams images inline | the file stream |
| `DELETE` | `/api/notes/:id/attachments/:attachmentId` | — | `{}` |

## Workflow

### Find and read a note

```bash
PLANNER_AUTH="x-api-key: $PLANNER_API_KEY"
PROJECT_ID=$(curl -s -H "$PLANNER_AUTH" "$PLANNER_URL/api/projects" | jq -r '.[] | select(.name=="<project>") | .id')

# Notes of one project, then match by exact title
curl -s -H "$PLANNER_AUTH" --get "$PLANNER_URL/api/notes" \
  --data-urlencode "projectId=$PROJECT_ID" | jq '.[] | {id, title}'

# Full content of one note
curl -s -H "$PLANNER_AUTH" "$PLANNER_URL/api/notes/$NOTE_ID" | jq .
```

### Create or update a note

```bash
curl -s -X POST -H "$PLANNER_AUTH" -H "Content-Type: application/json" \
  -d "{\"projectId\":\"$PROJECT_ID\",\"title\":\"<title>\",\"description\":\"<markdown content>\"}" \
  "$PLANNER_URL/api/notes" | jq '{id, title}'

curl -s -X PUT -H "$PLANNER_AUTH" -H "Content-Type: application/json" \
  -d '{"description":"<updated markdown content>"}' \
  "$PLANNER_URL/api/notes/$NOTE_ID" | jq '{id, dateUpdated}'
```

The `description` carries the note content as markdown. Update in place instead of creating a duplicate: filter by `projectId` and match the existing note by exact title first.

## Gotchas

- **Notes belong to exactly one project** and inherit its visibility: a note is only readable by users who can see its project.
- **Creating or updating a note requires `update` permission** on the target project and a non-archived project (`403`/`400` otherwise); deleting requires the `all` permission.
- **Match by exact title**: `GET /api/notes?q=` is a substring search over title and description — prefer the `projectId` filter plus an exact-title comparison to find the single note to update.
- **Labels replace, not merge**: `POST /api/notes/:id/labels` clears the existing labels before adding the ones sent.
- **Never put secrets in notes**: their content is visible in the Planner UI and stored in plaintext.
