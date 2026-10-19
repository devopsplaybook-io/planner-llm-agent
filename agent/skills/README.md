# Core skills

Core skills are shipped with the agent image: they are always available to
tasks, with no agent config repository required. One directory per skill,
each with its `SKILL.md` file using this format:

```markdown
---
name: <skill-name>
description: "One line telling when to use the skill."
---

Skill content.
```

The task prompt lists every available skill (name and description) and tells
the agent to read the `SKILL.md` of the relevant one before starting.

## Core skill set

| Skill | Scope |
| --- | --- |
| `planner-tasks` | Planner tasks through the Planner API: read, search, create, update, comments, labels, dependencies, attachments; the follow-up task recipe. |
| `planner-notes` | Planner notes through the Planner API: list, read, create, update, comments, labels, attachments. |
| `planner-projects` | Planner projects, statuses and the user picker: resolve projects, statuses and human assignee ids. |
| `planner-templates` | Planner task templates through the Planner API: CRUD, automation schedules, instance creation, comments, attachments. |
| `github-pull-request` | Basic Git/GitHub workflow: branch, commit, push, open and update a pull request, merge conventions. |
| `github-checks` | GitHub Actions checks: watch, diagnose failures, rerun policies. |

## Overrides

A skill synced from the agent config repository with the same `name`
overrides the core skill of that name: this lets a deployment customize or
replace a core skill without rebuilding the image. The effective skill list
is the merge of both sets, sorted by name.
