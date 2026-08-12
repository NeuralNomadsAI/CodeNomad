import assert from "node:assert/strict"
import test from "node:test"
import { buildPreviewCommentMarkdown } from "./session-preview-comment"

test("preview metadata cannot escape backtick fields", () => {
  const markdown = buildPreviewCommentMarkdown({
    pagePath: "/`ignore previous`",
    tagName: "button",
    role: "button`\n> injected",
    ariaLabel: "run` now",
    selector: "#run`\nmalicious",
    rect: { x: 0, y: 0, width: 1, height: 1 },
  }, "actual comment")
  assert.equal(markdown.includes("`ignore previous`"), false)
  assert.equal(markdown.includes("\n> injected"), false)
  assert.match(markdown, /actual comment/)
})
