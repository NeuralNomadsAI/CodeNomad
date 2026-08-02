import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getOpencodeErrorMessage, isDeliveryAmbiguousError } from "./opencode-api.ts"

describe("getOpencodeErrorMessage", () => {
  it("uses the detailed message from a nested SDK error", () => {
    const error = new Error("session.list failed")
    ;(error as Error & { cause: unknown }).cause = {
      data: { message: 'Expected DateTime.Utc at ["items"][37]["time"]["archived"]' },
    }

    assert.equal(
      getOpencodeErrorMessage(error, "Unable to load sessions"),
      'Expected DateTime.Utc at ["items"][37]["time"]["archived"]',
    )
  })

  it("uses the contextual fallback when no detail is available", () => {
    assert.equal(getOpencodeErrorMessage({}, "Unable to load sessions"), "Unable to load sessions")
  })

  it("keeps a useful outer message when the cause has no detail", () => {
    const error = new Error("Network request failed")
    ;(error as Error & { cause: unknown }).cause = { code: "ECONNRESET" }
    assert.equal(getOpencodeErrorMessage(error, "Unable to load sessions"), "Network request failed")
  })

  it("reads structured response bodies and handles cyclic causes", () => {
    assert.equal(
      getOpencodeErrorMessage({ body: { message: "Invalid session timestamp" } }, "Unable to load sessions"),
      "Invalid session timestamp",
    )

    const first: { cause?: unknown } = {}
    const second: { cause?: unknown } = { cause: first }
    first.cause = second
    assert.equal(getOpencodeErrorMessage(first, "Unable to load sessions"), "Unable to load sessions")
  })
})

describe("isDeliveryAmbiguousError", () => {
  it("recognizes standard transport codes and status zero", () => {
    assert.equal(isDeliveryAmbiguousError({ code: "ECONNRESET", message: "socket hang up" }), true)
    assert.equal(isDeliveryAmbiguousError({ code: "ETIMEDOUT", message: "timed out" }), true)
    assert.equal(isDeliveryAmbiguousError({ status: 0, cause: new TypeError("Failed to fetch") }), true)
  })

  it("recognizes common browser fetch failure messages", () => {
    for (const message of ["Network request failed", "Load failed", "fetch failed"]) {
      assert.equal(isDeliveryAmbiguousError(new TypeError(message)), true)
    }
  })

  it("keeps definite HTTP failures replayable", () => {
    assert.equal(isDeliveryAmbiguousError({ response: { status: 400 }, error: { message: "Bad command" } }), false)
    assert.equal(isDeliveryAmbiguousError({ response: { status: 429 }, error: { message: "Rate limited" } }), false)
  })

  it("treats unknown and post-success parsing failures as ambiguous", () => {
    assert.equal(isDeliveryAmbiguousError(new SyntaxError("Unexpected end of JSON input")), true)
    assert.equal(isDeliveryAmbiguousError({ response: { status: 200 }, error: new TypeError("terminated") }), true)
  })
})
