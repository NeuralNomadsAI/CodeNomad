# CodeNomadBot GitHub Automation

CodeNomadBot is the GitHub App automation built into the CodeNomad server. It receives GitHub webhooks, validates them with the app webhook secret, policy-gates accepted events, prepares a local repository worktree, runs OpenCode headlessly, and lets the assistant report back through a scoped `github` tool.

## Goals

- Turn GitHub issue and PR activity into headless OpenCode runs.
- Keep GitHub credentials in the CodeNomad server process, not inside OpenCode.
- Validate webhooks and scope all GitHub API calls to the installed repository.
- Require explicit allow policies so public repositories do not accidentally run automation.
- Avoid run races with one active run per issue/PR thread and latest-event-wins cancellation.

## Architecture

The integration has four main components:

- GitHub App: signs webhooks and grants repository-scoped permissions.
- CodeNomad server: validates webhooks, manages policy, workspaces, worktrees, OpenCode sessions, and GitHub API calls.
- OpenCode instance: runs in `CODENOMAD_MODE=github` with GitHub-only command prompts and a restricted `github` tool.
- Local git clone/worktrees: provide deterministic working directories for issue and PR automation.

## Request Flow

1. GitHub sends a webhook to `/integrations/github/webhook`.
2. CodeNomad validates `x-hub-signature-256` with `integrations.github.webhookSecret`.
3. CodeNomad parses and normalizes the webhook into a repository/thread context.
4. `integrations.github.policy.rules` selects the first matching rule. Missing rules means implicit deny.
5. Actor admission checks `allowedUsers`, `allowedAuthorAssociations`, `allowAllActors`, `denyBots`, and PR synchronize-specific options.
6. If `requireMention` is true, the event text must mention the configured bot handle.
7. CodeNomad clones or updates the repository under `workspaceRoot`.
8. CodeNomad creates or reuses a stable managed worktree for the issue/PR thread.
9. CodeNomad starts or reuses an OpenCode workspace with `CODENOMAD_MODE=github`.
10. CodeNomad creates or reuses a deterministic OpenCode session for the GitHub thread.
11. CodeNomad calls `session.command` with a selected `codenomad-github-*` command and sanitized webhook JSON.
12. The assistant uses the `github` tool to list comments, add reactions, post comments, and publish PRs.
13. On success, the assistant is responsible for posting the final GitHub comment.
14. On non-cancelled failure, CodeNomad posts an automation failure comment.

## GitHub App Setup

Create a GitHub App in the account or organization that owns the repositories you want CodeNomad to automate.

Recommended repository permissions:

- Metadata: read-only.
- Contents: read and write. Required to push bot branches.
- Issues: read and write. Required to read/post issue and PR conversation comments and reactions.
- Pull requests: read and write. Required to read review comments and create/update pull requests.

Subscribe to these webhook events:

- Issue comment.
- Issues.
- Pull request.
- Pull request review comment.

Also configure a webhook secret and generate a private key PEM. Store the private key on the machine running CodeNomad.

## Webhook URL

Development with `smee`:

```bash
smee -u https://smee.io/<channel> -t http://127.0.0.1:<port>/integrations/github/webhook
```

Set the GitHub App webhook URL to the `smee.io` channel URL.

Production:

- Point the GitHub App webhook URL directly at your public CodeNomad server URL plus `/integrations/github/webhook`.
- Ensure the URL reaches the same CodeNomad server that has the GitHub App private key and config.

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

    webhook:
      agent: "build"
      model:
        providerId: "anthropic"
        modelId: "claude-sonnet-4-5"
      variant: "default"

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

Configuration notes:

- `enabled` must be `true`; disabled integrations ignore all webhooks.
- `appId`, `privateKeyPath`, and `webhookSecret` are required for accepted jobs.
- `workspaceRoot` defaults to `~/.config/codenomad/github-workspace`.
- `mentionHandle` controls which `@handle` triggers mention-gated rules.
- `botLogin` prevents the bot from responding to its own comments and expands mention matching to `@bot` and `@bot[bot]`.
- `commands` maps event keys to OpenCode command names. Missing mappings fall back to built-ins.
- `webhook.agent`, `webhook.model`, and `webhook.variant` set defaults for OpenCode runs.
- Policy rule `allow.command`, `allow.agent`, `allow.model`, and `allow.variant` override the defaults for that rule.

Event keys use `<x-github-event>.<action>`, for example:

- `issue_comment.created`
- `pull_request_review_comment.created`
- `issues.opened`
- `pull_request.opened`
- `pull_request.synchronize`

## Policy

Policy is implicit deny. If no rule matches, the webhook is ignored and no comment is posted.

Rule match fields:

- `repo`: glob against `owner/repo`.
- `repoRegex`: regular expression against `owner/repo`.
- `event`: glob against the event key.
- `eventRegex`: regular expression against the event key.

Glob matching treats `/` and `.` as separators. `*` does not cross separators; `**` does.

Rule allow fields:

- `enabled`: set `false` for an explicit deny rule.
- `requireMention`: require a bot mention before running. Defaults to true.
- `allowedUsers`: explicit GitHub logins, case-insensitive.
- `allowedAuthorAssociations`: GitHub associations such as `OWNER`, `COLLABORATOR`, and `MEMBER`. Defaults to `OWNER` and `COLLABORATOR` when omitted.
- `allowPrAuthor`: for `pull_request.synchronize`, allow the PR author to trigger runs. Defaults to false.
- `allowAllActors`: bypass actor allow checks.
- `denyBots`: reject actors with type `Bot`.
- `command`, `agent`, `model`, `variant`: per-rule OpenCode overrides.

## Policy Cookbook

Allow maintainer mentions on issue comments:

```yaml
integrations:
  github:
    policy:
      rules:
        - name: "Maintainer issue comment mentions"
          match:
            repo: "my-org/*"
            event: "issue_comment.created"
          allow:
            requireMention: true
            allowedAuthorAssociations: ["OWNER", "COLLABORATOR"]
```

Allow only named users to trigger PR review comment responses:

```yaml
integrations:
  github:
    policy:
      rules:
        - name: "Named PR review responders"
          match:
            repo: "my-org/*"
            event: "pull_request_review_comment.created"
          allow:
            requireMention: true
            allowedUsers: ["alice", "bob"]
```

Run issue triage when an issue opens without requiring a mention:

```yaml
integrations:
  github:
    policy:
      rules:
        - name: "Issue triage"
          match:
            repo: "my-org/*"
            event: "issues.opened"
          allow:
            requireMention: false
            allowedAuthorAssociations: ["OWNER", "COLLABORATOR"]
```

Allow PR synchronize events from maintainers, but not the PR author by default:

```yaml
integrations:
  github:
    policy:
      rules:
        - name: "Maintainer PR updates"
          match:
            repo: "my-org/*"
            event: "pull_request.synchronize"
          allow:
            requireMention: false
            allowPrAuthor: false
            allowedAuthorAssociations: ["OWNER", "COLLABORATOR"]
```

Use a regex for one repository:

```yaml
integrations:
  github:
    policy:
      rules:
        - name: "Repo A only"
          match:
            repoRegex: "^my-org/repo-a$"
            event: "issue_comment.created"
          allow:
            requireMention: true
            allowedAuthorAssociations: ["OWNER", "COLLABORATOR"]
```

## Worktree Strategy

CodeNomad uses stable managed worktrees to avoid unbounded workspace growth.

Issue threads:

- Branch/worktree slug: `codenomad/issue-<issueNumber>`.
- Reset target: remote bot branch if it exists, otherwise the repository default branch.

PR threads:

- Branch/worktree slug: `codenomad/pr-<prNumber>`.
- Bot-owned PRs operate directly on the PR head branch.
- Reset target: remote bot branch if it exists, otherwise `pull/<prNumber>/head`.

Publishing defaults:

- Bot-owned PR: publish against the PR base branch.
- Same-repository contributor PR: publish against the contributor head branch, creating a stacked PR.
- Fork PR: publish against the base branch because the app may not be able to push to the fork.

Every run hard-resets and cleans the worktree before OpenCode starts. Uncommitted local changes and local-only commits are not durable between webhook runs.

## GitHub Tool Operations

The OpenCode plugin exposes the `github` tool only when `CODENOMAD_MODE=github`.

Supported operations:

- `list_issue_comments`: read issue/PR conversation comments.
- `post_issue_comment`: post a comment to an issue or PR. CodeNomad appends the bot signature.
- `add_reaction`: add a reaction to an issue comment.
- `list_pr_review_comments`: read PR review comments.
- `add_pr_review_comment_reaction`: add a reaction to a PR review comment.
- `publish_pr`: push the current branch and create or return a pull request. Requires a clean working tree.

The assistant must use this tool for GitHub operations. The `gh` CLI is not authenticated for bot jobs.

## Concurrency

Jobs are supervised by repository thread: `<owner>/<repo>#<issueOrPrNumber>`.

- Only one run is active for a thread.
- A newer accepted webhook for the same thread aborts the active OpenCode request and session.
- The newest pending webhook then runs.
- Superseded jobs do not post failure comments.

## Operational Limitations

- Job state and delivery dedupe are in memory. Restarting CodeNomad drops in-flight jobs and seen-delivery history.
- Webhook delivery returns `202` before automation finishes.
- Failure comments are best-effort and are skipped for superseded runs.
- Fork PR behavior depends on GitHub App installation permissions.
- Local repository state under `workspaceRoot` is managed by CodeNomad and can be hard-reset.

## Troubleshooting

No run starts:

- Check `integrations.github.enabled`.
- Check `webhookSecret` and GitHub delivery signature validation.
- Check that at least one policy rule matches the repository and event key.
- Check `requireMention` and the configured `mentionHandle`/`botLogin`.
- Check actor admission (`allowedUsers`, `allowedAuthorAssociations`, `denyBots`).

Git operations fail:

- Confirm the app has Contents read/write permission.
- Confirm the app is installed on the repository.
- Confirm the private key path is readable by the CodeNomad process.

Commenting or reactions fail:

- Confirm Issues read/write permission.
- Confirm Pull requests read/write permission for PR review comments.

`publish_pr` fails:

- Commit all file changes before calling `github(op=publish_pr, ...)`.
- Confirm the current branch is valid and the app can push branches.
- For fork PRs, expect publishing to target the base repository branch rather than the fork branch.
