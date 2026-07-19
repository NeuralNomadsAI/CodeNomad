import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { selectGitHubWebhookCommand } from "../webhook-command"

describe("GitHub webhook command selection", () => {
  it("uses server mapping when provided", () => {
    const selected = selectGitHubWebhookCommand({
      eventKey: "issue_comment.created",
      serverCommands: {
        "issue_comment.created": "codenomad-github-issue-comment",
        default: "codenomad-github-default",
      },
    })
    assert.equal(selected.command, "codenomad-github-issue-comment")
    assert.equal(selected.source, "server")
  })

  it("falls back to built-in mapping when server mapping missing", () => {
    const selected = selectGitHubWebhookCommand({ eventKey: "pull_request_review_comment.created", serverCommands: {} })
    assert.equal(selected.command, "codenomad-github-review-comment")
    assert.equal(selected.source, "builtin")
  })

  it("falls back to built-in default for unknown events", () => {
    const selected = selectGitHubWebhookCommand({ eventKey: "unknown.event", serverCommands: {} })
    assert.equal(selected.command, "codenomad-github-default")
    assert.equal(selected.source, "builtin")
  })
})
