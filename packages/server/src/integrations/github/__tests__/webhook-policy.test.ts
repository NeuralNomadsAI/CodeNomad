import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { selectGitHubWebhookPolicyDecision } from "../webhook-policy"

describe("GitHub webhook policy selection", () => {
  it("implicitly denies when no rules are configured", () => {
    assert.equal(selectGitHubWebhookPolicyDecision(undefined, { repoFullName: "my-org/repo-a", eventKey: "issue_comment.created" }), null)
  })

  it("matches by repo glob and event exact", () => {
    const decision = selectGitHubWebhookPolicyDecision([
      { name: "org issue comments", match: { repo: "my-org/*", event: "issue_comment.created" }, allow: { enabled: true, requireMention: true, allowedAuthorAssociations: ["OWNER"] } },
    ], { repoFullName: "my-org/repo-a", eventKey: "issue_comment.created" })
    assert.ok(decision)
    assert.equal(decision.enabled, true)
    assert.equal(decision.requireMention, true)
    assert.equal(decision.ruleName, "org issue comments")
    assert.deepEqual(decision.allowedAuthorAssociations, ["OWNER"])
  })

  it("passes through allow overrides", () => {
    const decision = selectGitHubWebhookPolicyDecision([
      {
        name: "overrides",
        match: { repo: "my-org/*", event: "issue_comment.created" },
        allow: { enabled: true, command: "codenomad-github-issue-comment", agent: "build", model: { providerId: "cli-proxy-api-openai", modelId: "gpt-5.2" }, variant: "default" },
      },
    ], { repoFullName: "my-org/repo-a", eventKey: "issue_comment.created" })

    assert.ok(decision)
    assert.equal(decision.command, "codenomad-github-issue-comment")
    assert.equal(decision.agent, "build")
    assert.deepEqual(decision.model, { providerId: "cli-proxy-api-openai", modelId: "gpt-5.2" })
    assert.equal(decision.variant, "default")
  })

  it("passes through allowPrAuthor", () => {
    const decision = selectGitHubWebhookPolicyDecision([
      { name: "no pr author", match: { repo: "my-org/*", event: "pull_request.synchronize" }, allow: { enabled: true, allowPrAuthor: false } },
    ], { repoFullName: "my-org/repo-a", eventKey: "pull_request.synchronize" })
    assert.ok(decision)
    assert.equal(decision.allowPrAuthor, false)
  })

  it("supports event globs", () => {
    const decision = selectGitHubWebhookPolicyDecision([
      { match: { repo: "my-org/*", event: "issue_comment.*" }, allow: { enabled: true } },
    ], { repoFullName: "my-org/repo-a", eventKey: "issue_comment.created" })
    assert.ok(decision)
    assert.equal(decision.enabled, true)
  })

  it("treats '*' as not crossing separators", () => {
    const decision = selectGitHubWebhookPolicyDecision([
      { match: { repo: "my-org/*", event: "issue_comment.*" }, allow: { enabled: true } },
    ], { repoFullName: "my-org/repo-a", eventKey: "issue_comment.created.extra" })
    assert.equal(decision, null)
  })

  it("supports '**' crossing separators", () => {
    const decision = selectGitHubWebhookPolicyDecision([
      { match: { repo: "my-org/**", event: "**" }, allow: { enabled: true } },
    ], { repoFullName: "my-org/repo-a", eventKey: "issue_comment.created.extra" })
    assert.ok(decision)
  })

  it("supports repo/event regex", () => {
    const decision = selectGitHubWebhookPolicyDecision([
      { name: "regex", match: { repoRegex: "^my-org/repo-[ab]$", eventRegex: "^issue_comment\\.created$" }, allow: { enabled: true, allowedUsers: [" Alice "] } },
    ], { repoFullName: "my-org/repo-b", eventKey: "issue_comment.created" })
    assert.ok(decision)
    assert.equal(decision.ruleName, "regex")
    assert.deepEqual(decision.allowedUsers, ["Alice"])
  })

  it("ignores invalid regex and checks later rules", () => {
    const decision = selectGitHubWebhookPolicyDecision([
      { match: { repoRegex: "([" }, allow: { enabled: true } },
      { match: { repo: "my-org/*", event: "issue_comment.created" }, allow: { enabled: true } },
    ], { repoFullName: "my-org/repo-a", eventKey: "issue_comment.created" })
    assert.ok(decision)
  })

  it("respects explicit deny", () => {
    const decision = selectGitHubWebhookPolicyDecision([
      { name: "deny", match: { repo: "my-org/*", event: "issue_comment.created" }, allow: { enabled: false } },
    ], { repoFullName: "my-org/repo-a", eventKey: "issue_comment.created" })
    assert.ok(decision)
    assert.equal(decision.enabled, false)
    assert.equal(decision.ruleName, "deny")
  })
})
