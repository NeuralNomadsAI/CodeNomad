import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { getCredential, readOpenCodeAuth, toTimestamp, toUsageWindow } from "./shared"

test("reads the explicit OpenCode auth file without exposing credentials through the API", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-usage-"))
  const authFile = path.join(directory, "auth.json")
  const previous = process.env.OPENCODE_AUTH_FILE
  fs.writeFileSync(authFile, JSON.stringify({ openai: { type: "oauth", access: "secret-token" } }))
  process.env.OPENCODE_AUTH_FILE = authFile

  try {
    assert.equal((readOpenCodeAuth().openai as Record<string, unknown>).access, "secret-token")
    assert.equal(getCredential(["openai"], ["access"]), "secret-token")
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_AUTH_FILE
    else process.env.OPENCODE_AUTH_FILE = previous
    fs.rmSync(directory, { recursive: true, force: true })
  }
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
