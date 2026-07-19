# CodeNomadBot GitHub Automation

CodeNomadBot is a GitHub App integration built into the CodeNomad server. It accepts GitHub webhooks, validates them with the GitHub webhook secret, applies explicit policy rules, runs OpenCode in a managed local worktree, and lets the assistant report back through a scoped `github` tool.

## Flow

1. GitHub sends a webhook to `/integrations/github/webhook`.
2. CodeNomad validates `x-hub-signature-256` against `integrations.github.webhookSecret`.
3. The webhook is normalized into a repository/thread context.
4. `integrations.github.policy.rules` decides whether the event is allowed. Missing rules means implicit deny.
5. If required, the body must mention the configured bot handle.
6. CodeNomad clones or updates the repository under `workspaceRoot`.
7. CodeNomad prepares a stable managed worktree for the issue or PR.
8. A GitHub-mode OpenCode workspace is started with `CODENOMAD_MODE=github`.
9. CodeNomad runs the selected `codenomad-github-*` command in a reusable session for that thread.
10. The assistant uses the `github` tool to list comments, post comments, add reactions, and publish PRs.

## Configuration

Add configuration under the `integrations` owner in `config.yaml`:

```yaml
integrations:
  github:
    enabled: true
    appId: "123456"
    privateKeyPath: "~/.config/codenomad/github-app.pem"
    webhookSecret: "change-me"
    workspaceRoot: "~/.config/codenomad/github-workspace"
    mentionHandle: "codenomadbot"
    botLogin: "codenomadbot[bot]"
    commands:
      default: "codenomad-github-default"
      issue_comment.created: "codenomad-github-issue-comment"
      pull_request_review_comment.created: "codenomad-github-review-comment"
      issues.opened: "codenomad-github-issue-opened"
      pull_request.opened: "codenomad-github-pr-opened"
    policy:
      rules:
        - name: "Allow maintainer issue comments"
          match:
            repo: "my-org/*"
            event: "issue_comment.created"
          allow:
            requireMention: true
            allowedAuthorAssociations: ["OWNER", "COLLABORATOR"]
```

Policy rule match fields support `repo`, `repoRegex`, `event`, and `eventRegex`. Glob matching treats `/` and `.` as separators.

Policy rule allow fields support `requireMention`, `allowedUsers`, `allowedAuthorAssociations`, `allowPrAuthor`, `allowAllActors`, `denyBots`, and per-rule `command`, `agent`, `model`, and `variant` overrides.

## GitHub Tool Operations

The OpenCode plugin exposes the `github` tool only when `CODENOMAD_MODE=github`.

Supported operations:

- `list_issue_comments`
- `post_issue_comment`
- `add_reaction`
- `list_pr_review_comments`
- `add_pr_review_comment_reaction`
- `publish_pr`

`post_issue_comment` and `publish_pr` append the CodeNomadBot signature. `publish_pr` requires a clean git working tree and pushes the current branch with a GitHub App installation token.

## Worktrees

Issue events use `codenomad/issue-<number>`. PR events use `codenomad/pr-<number>` unless the PR is already bot-owned, in which case the bot works directly on the PR head branch.

Each run resets the worktree to a clean remote baseline before OpenCode starts, so uncommitted local changes are not durable between webhook runs.

## Operational Notes

- Webhook admission and job state are in memory.
- Only one run is active per repository thread. A newer webhook for the same issue/PR supersedes and aborts the active run.
- Repositories are cloned under `workspaceRoot`, defaulting to `~/.config/codenomad/github-workspace`.
- Failure comments are posted only for non-superseded runs.
