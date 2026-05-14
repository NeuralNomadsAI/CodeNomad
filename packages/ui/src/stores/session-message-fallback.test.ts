import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { OpencodeApiError } from "../lib/opencode-api.js"
import { getExportedSessionMessages, isLegacyMissingAgentValidationError } from "./session-message-fallback.js"

describe("isLegacyMissingAgentValidationError", () => {
  it("matches the legacy missing-agent validation error", () => {
    const error = new OpencodeApiError("session.messages failed", {
      cause: {
        name: "BadRequest",
        data: {
          kind: "Body",
          message: 'Missing key\n  at [1]["info"]["agent"]',
        },
      },
    })

    assert.equal(isLegacyMissingAgentValidationError(error), true)
  })

  it("ignores unrelated missing-key validation failures", () => {
    const error = new OpencodeApiError("session.messages failed", {
      cause: {
        name: "BadRequest",
        data: {
          kind: "Body",
          message: 'Missing key\n  at [1]["info"]["model"]',
        },
      },
    })

    assert.equal(isLegacyMissingAgentValidationError(error), false)
  })

  it("throws when the export response does not contain a messages array", () => {
    assert.throws(() => getExportedSessionMessages({ info: {}, messages: null as any }), /messages array/)
  })
})
