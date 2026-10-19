---
name: github-pull-request
description: "Use when a task needs to deliver code changes through a Git branch and a GitHub pull request — branch, commit, push, open or update the PR, and merge it when the repository's conventions and checks allow it."
---

Deliver changes to a Git repository as a GitHub pull request: branch, commit, push, open the PR and follow it through to merge.

## Context

- Git and the GitHub CLI (`gh`) are pre-installed and authenticated: the `GH_TOKEN` environment variable carries the default token.
- When the deployment provides dedicated tokens per GitHub organization (announced in the task prompt as `GH_TOKEN_<ORG>` variables), prefix `gh` (and authenticated `git`) operations on those repositories with the matching variable, e.g. `GH_TOKEN="$GH_TOKEN_MY_ORG" gh pr create`.
- Read the repository's own guidance first when present (`README.md`, `CONTRIBUTING.md`, `AGENTS.md`): branch naming, commit style and merge conventions may be defined there.

## Workflow

### 1. Branch

Never commit to the default branch. Work in a clean checkout and create a feature branch:

```bash
git status && git log --oneline -3   # understand where you are
git checkout -b feature/<short-description>
```

### 2. Commit

Review the diff before staging — never commit secrets (`.env`, credentials, tokens) or unrelated files:

```bash
git status && git diff
git add <specific files>
git commit -m "<type>: <short description>"   # conventional commits: feat:, fix:, chore:, docs:, refactor:
```

### 3. Push and open the pull request

```bash
git push -u origin <branch>

gh pr create --base main \
  --title "<short title (under ~70 characters)>" \
  --body "$(cat <<'EOF'
## Summary
- <what changed and why>

## Test Plan
- [ ] <what to test and how>
EOF
)"
```

The pull request is often the only channel reviewers have to understand the change: keep the body self-contained, and describe in `## Test Plan` exactly what to test and how.

### 4. Update and discuss

```bash
gh pr edit <number> --title "..." --body "..."   # refine as the change evolves
gh pr comment <number> --body "..."              # answer review questions
gh pr view <number> --json reviewDecision,reviews,state
```

Push follow-up commits to the same branch to address reviews; add new commits rather than amending pushed ones.

### 5. Merge

Merge only when the repository's rules are satisfied: all checks green, required reviews approved, no conflicts (`gh pr view --json mergeable,mergeStateStatus`). Follow the repository's merge convention — squash merge is the common default for feature branches (one clean commit per change). After merging, delete the feature branch:

```bash
gh pr checks <number>          # must all pass
gh pr merge <number> --squash --delete-branch
```

Never merge a pull request with failing checks, and never force-push shared branches (`main`, branches others may use) — force-push only your own feature branch when rewriting not-yet-reviewed work, and say so in the PR.

## Gotchas

- **The default token may not cover every organization**: use the dedicated `GH_TOKEN_<ORG>` variables announced in the task prompt when operating on those repositories; a `gh` call failing with an authentication error on an organization repository is usually the wrong token, not a missing permission in the repository.
- **Clean state before branching**: uncommitted changes found on checkout belong to someone's work in progress — investigate before touching them, and never discard them silently.
- **Small, focused pull requests**: one logical change per PR; a mixed PR is hard to review and hard to revert.
- **Empty commits are noise**: when there is nothing to commit, there is no pull request to open.
