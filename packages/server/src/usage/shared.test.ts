import assert from "node:assert/strict"
import test from "node:test"

import { getCredential, getOAuthEntry, oauthTokenNeedsRefresh, toTimestamp, toUsageWindow } from "./shared"

test("reads a projected credential field by alias", () => {
  const auth = { openai: { type: "oauth", access: "secret-token" } }
  assert.equal(getCredential(auth, ["openai"], ["access"]), "secret-token")
  assert.equal(getCredential({}, ["openai"], ["access"]), null)
})

test("skips malformed aliases when reading credentials", () => {
  const auth = {
    first: { type: "api", key: "api-key" },
    second: { type: "oauth", refresh: "refresh-only" },
    third: { type: "oauth", access: "oauth-access" },
  }
  assert.equal(getOAuthEntry(auth, ["first", "second", "third"])?.access, "oauth-access")
  assert.equal(getCredential(auth, ["missing", "first"], ["key"]), "api-key")
})

test("normalizes percentages and timestamps", () => {
  assert.deepEqual(toUsageWindow({ usedPercent: 120, resetAt: null }), {
    usedPercent: 100,
    remainingPercent: 0,
    windowSeconds: null,
    resetAt: null,
  })
  assert.equal(toTimestamp(1_700_000_000), 1_700_000_000_000)
})

test("applies OAuth expiry rules to token-only entries", () => {
  const future = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")
  const expired = Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")
  assert.equal(oauthTokenNeedsRefresh({ type: "oauth", token: `header.${future}.signature` }), false)
  assert.equal(oauthTokenNeedsRefresh({ type: "oauth", token: `header.${expired}.signature` }), true)
  assert.equal(oauthTokenNeedsRefresh({ type: "oauth", token: "opaque", expires: 1 }), true)
})
