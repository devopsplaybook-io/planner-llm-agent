---
name: github-checks
description: "Use when a task needs to check the GitHub Actions checks of a pull request or branch — watch them complete, diagnose a failure and get the build green again."
---

Watch the GitHub Actions checks of a pull request or branch, wait for their completion and fix failures at the root cause.

## Context

- The GitHub CLI (`gh`) is pre-installed and authenticated (`GH_TOKEN`); when dedicated organization tokens are announced in the task prompt (`GH_TOKEN_<ORG>` variables), prefix `gh` operations on those repositories with the matching variable.
- Nothing survives the current session: wait for checks in the foreground — never leave a watch running with a promise to look at it later.

## Workflow

### 1. Watch the checks to completion

```bash
gh pr checks <number> --watch     # or the full URL; blocks until every check finishes
```

Every check must report `pass` before the work is considered done. Without a pull request, list the runs of the branch instead:

```bash
gh run list --branch <branch> --limit 5
gh run watch <run-id>             # blocks until the run finishes
```

When a repository has no workflows configured, `gh pr checks` reports that there are no checks — state that explicitly instead of claiming success.

### 2. Diagnose a failure

```bash
gh pr checks <number>                                  # which checks failed
gh run view <run-id> --log-failed                      # the logs of the failed steps
gh run view <run-id> --json conclusion,jobs,name       # structured overview
```

Find the **first real error** in the failed log (the error that started the cascade, not its consequences), reproduce it locally when possible, and fix the root cause on the branch. Push the fix as a **new commit**, then watch the new checks.

### 3. Rerun with judgment

```bash
gh run rerun <run-id> --failed
```

Rerun only after pushing a fix or when the failure is clearly flaky infrastructure (network timeouts, runner hiccups) — and say which one it is. A rerun is not a fix: a failing check that passes on retry without a change must still be understood (repeat it, find the flake) before being trusted.

## Gotchas

- **Never bypass a failing check**: no skipped hooks, no `--no-verify`, no forced or premature merge. Always fix the root cause.
- **Never report work as done with failing checks**: either get them green or state plainly that they fail and why.
- **Read the log before guessing**: most failures are visible in the first failed step; re-running blind wastes a full CI cycle.
- **Local verification is cheaper**: run the project's own checks (`npm test`, `npm run build`, ...) before pushing — the CI cycle is the slow way to learn a test fails.
