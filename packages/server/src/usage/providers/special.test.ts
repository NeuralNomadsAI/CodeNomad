import assert from "node:assert/strict"
import test from "node:test"

import { specialProviders } from "./special"

test("fails closed without requesting quota for an expired Cursor access token", async () => {
  const previousAccess = process.env.CURSOR_ACCESS_TOKEN
  const previousToken = process.env.CURSOR_TOKEN
  const previousFetch = globalThis.fetch
  const payload = Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")
  process.env.CURSOR_ACCESS_TOKEN = `header.${payload}.signature`
  delete process.env.CURSOR_TOKEN
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    throw new Error("expired token must not make requests")
  }

  try {
    const usage = await specialProviders.find((provider) => provider.id === "cursor")!.fetchQuota()
    assert.equal(usage.ok, false)
    assert.equal(usage.configured, true)
    assert.equal(usage.error, "Cursor access token expired. Provide a current CURSOR_ACCESS_TOKEN or CURSOR_TOKEN.")
    assert.equal(calls, 0)
    assert.equal(usage.error?.includes(process.env.CURSOR_ACCESS_TOKEN), false)
  } finally {
    globalThis.fetch = previousFetch
    if (previousAccess === undefined) delete process.env.CURSOR_ACCESS_TOKEN
    else process.env.CURSOR_ACCESS_TOKEN = previousAccess
    if (previousToken === undefined) delete process.env.CURSOR_TOKEN
    else process.env.CURSOR_TOKEN = previousToken
  }
})
