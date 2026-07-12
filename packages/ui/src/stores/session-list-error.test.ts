import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import { getOpencodeErrorMessage } from "../lib/opencode-api.ts"
import { getSessionListError, setSessionListError } from "./session-state.ts"

const instanceId = "session-list-error-test"

afterEach(() => setSessionListError(instanceId, null))

describe("session list errors", () => {
  it("stores and clears errors per instance", () => {
    setSessionListError(instanceId, "Invalid session data")
    assert.equal(getSessionListError(instanceId), "Invalid session data")

    setSessionListError(instanceId, null)
    assert.equal(getSessionListError(instanceId), undefined)
  })
})

describe("OpenCode error messages", () => {
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
