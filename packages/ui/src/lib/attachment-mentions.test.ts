import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createPromptMentionRegex, getAttachmentPromptMentionCandidates } from "./attachment-mentions.ts"

describe("attachment prompt mentions", () => {
  it("derives the relative directory token emitted by the runtime picker", () => {
    assert.deepEqual(
      getAttachmentPromptMentionCandidates({
        display: "@nested/",
        filename: "nested/",
        source: { type: "file", path: "./dir/nested", mime: "inode/directory" },
      }),
      ["nested/", "./dir/nested", "./dir/nested/", "dir/nested/"],
    )
  })

  it("matches literal spaced and regex-significant paths without consuming prefixes", () => {
    const candidate = "C:\\work\\my file [draft](1).ts"
    const prompt = `remove @${candidate} keep @${candidate}.bak and @other`

    assert.equal(
      prompt.replace(createPromptMentionRegex(candidate, { global: true }), ""),
      `remove  keep @${candidate}.bak and @other`,
    )
  })
})
