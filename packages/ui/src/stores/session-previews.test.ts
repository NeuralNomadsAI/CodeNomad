import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseStoredSessionPreviews } from "./session-previews"

describe("session preview persistence", () => {
  it("restores only valid HTTP preview records", () => {
    assert.deepEqual(parseStoredSessionPreviews(JSON.stringify({
      valid: { targetUrl: "http://localhost:3000/app", mode: "preview" },
      invalidScheme: { targetUrl: "javascript:alert(1)", mode: "preview" },
      invalidMode: { targetUrl: "https://example.com", mode: "hidden" },
    })), [["valid", { targetUrl: "http://localhost:3000/app", mode: "preview" }]])
    assert.deepEqual(parseStoredSessionPreviews("not json"), [])
  })
})
