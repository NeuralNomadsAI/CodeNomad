import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getPatchPartFiles, partHasRenderableText, type ClientPart } from "./message.ts"

describe("message parts", () => {
  it("treats patch parts with files as renderable content", () => {
    const part = {
      id: "patch-1",
      type: "patch",
      sessionID: "session-1",
      messageID: "message-1",
      hash: "abc",
      files: ["src/app.ts"],
    } as ClientPart

    assert.deepEqual(getPatchPartFiles(part), ["src/app.ts"])
    assert.equal(partHasRenderableText(part), true)
  })

  it("ignores empty patch file lists", () => {
    const part = {
      id: "patch-1",
      type: "patch",
      sessionID: "session-1",
      messageID: "message-1",
      hash: "abc",
      files: [],
    } as ClientPart

    assert.deepEqual(getPatchPartFiles(part), [])
    assert.equal(partHasRenderableText(part), false)
  })
})
