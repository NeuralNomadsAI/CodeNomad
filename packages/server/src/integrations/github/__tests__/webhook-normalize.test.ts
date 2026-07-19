import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { normalizeGitHubWebhookContext } from "../webhook-normalize"

describe("normalizeGitHubWebhookContext", () => {
  it("normalizes issue_comment", () => {
    const ctx = normalizeGitHubWebhookContext({
      event: "issue_comment",
      payload: {
        installation: { id: 1 },
        repository: { owner: { login: "my-org" }, name: "repo-a", default_branch: "main", clone_url: "https://github.com/my-org/repo-a.git" },
        issue: { number: 12, pull_request: { url: "x" } },
        comment: { id: 99, body: "hi @codenomad", user: { login: "alice" }, author_association: "OWNER" },
      },
    })

    assert.ok(ctx)
    assert.equal(ctx.repoFullName, "my-org/repo-a")
    assert.equal(ctx.installationId, 1)
    assert.equal(ctx.isPullRequest, true)
    assert.equal(ctx.number, 12)
    assert.equal(ctx.bodyText, "hi @codenomad")
    assert.equal(ctx.actorLogin, "alice")
    assert.equal(ctx.actorAssociation, "OWNER")
    assert.equal(ctx.issueCommentId, 99)
  })

  it("normalizes pull_request_review_comment", () => {
    const ctx = normalizeGitHubWebhookContext({
      event: "pull_request_review_comment",
      payload: {
        installation: { id: 2 },
        repository: { owner: { login: "my-org" }, name: "repo-b" },
        pull_request: { number: 7 },
        comment: { id: 123, body: "@codenomad please fix", user: { login: "bob" }, author_association: "COLLABORATOR" },
      },
    })

    assert.ok(ctx)
    assert.equal(ctx.repoFullName, "my-org/repo-b")
    assert.equal(ctx.isPullRequest, true)
    assert.equal(ctx.number, 7)
    assert.equal(ctx.reviewCommentId, 123)
    assert.equal(ctx.bodyText, "@codenomad please fix")
  })

  it("normalizes issues", () => {
    const ctx = normalizeGitHubWebhookContext({
      event: "issues",
      payload: {
        installation: { id: 3 },
        repository: { owner: { login: "my-org" }, name: "repo-c" },
        issue: { number: 4, body: "Issue body", user: { login: "carol" }, author_association: "MEMBER" },
      },
    })

    assert.ok(ctx)
    assert.equal(ctx.repoFullName, "my-org/repo-c")
    assert.equal(ctx.isPullRequest, false)
    assert.equal(ctx.number, 4)
    assert.equal(ctx.bodyText, "Issue body")
    assert.equal(ctx.actorLogin, "carol")
    assert.equal(ctx.actorAssociation, "MEMBER")
  })

  it("normalizes pull_request", () => {
    const ctx = normalizeGitHubWebhookContext({
      event: "pull_request",
      payload: {
        installation: { id: 4 },
        repository: { owner: { login: "my-org" }, name: "repo-d" },
        pull_request: { number: 42, body: "PR body", user: { login: "dana" }, author_association: "OWNER" },
      },
    })

    assert.ok(ctx)
    assert.equal(ctx.repoFullName, "my-org/repo-d")
    assert.equal(ctx.isPullRequest, true)
    assert.equal(ctx.number, 42)
    assert.equal(ctx.bodyText, "PR body")
    assert.equal(ctx.actorLogin, "dana")
    assert.equal(ctx.actorAssociation, "OWNER")
    assert.equal(ctx.prAuthorLogin, "dana")
  })

  it("uses sender as actor for pull_request synchronize", () => {
    const ctx = normalizeGitHubWebhookContext({
      event: "pull_request",
      payload: {
        action: "synchronize",
        installation: { id: 5 },
        repository: { owner: { login: "my-org" }, name: "repo-e" },
        sender: { login: "alice", type: "User" },
        pull_request: { number: 100, body: "PR updated", user: { login: "dana", type: "User" }, author_association: "OWNER" },
      },
    })

    assert.ok(ctx)
    assert.equal(ctx.repoFullName, "my-org/repo-e")
    assert.equal(ctx.isPullRequest, true)
    assert.equal(ctx.number, 100)
    assert.equal(ctx.bodyText, "PR updated")
    assert.equal(ctx.actorLogin, "alice")
    assert.equal(ctx.actorType, "User")
    assert.equal(ctx.actorAssociation, undefined)
    assert.equal(ctx.prAuthorLogin, "dana")
  })

  it("returns null when required fields are missing", () => {
    assert.equal(normalizeGitHubWebhookContext({ event: "issue_comment", payload: { repository: { name: "x" } } }), null)
  })
})
