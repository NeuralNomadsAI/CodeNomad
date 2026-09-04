import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { getCredential, getOAuthEntry, oauthTokenNeedsRefresh, readOpenCodeAuth, toTimestamp, toUsageWindow } from "./shared"

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

test("does not fall through when the explicit OpenCode auth file is missing", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-usage-explicit-"))
  const previousAuthFile = process.env.OPENCODE_AUTH_FILE
  const previousDataDir = process.env.OPENCODE_DATA_DIR
  fs.writeFileSync(path.join(directory, "auth.json"), JSON.stringify({ openai: { access: "wrong-store" } }))
  process.env.OPENCODE_AUTH_FILE = path.join(directory, "missing.json")
  process.env.OPENCODE_DATA_DIR = directory

  try {
    assert.deepEqual(readOpenCodeAuth(), {})
    assert.equal(getCredential(["openai"], ["access"]), null)
  } finally {
    if (previousAuthFile === undefined) delete process.env.OPENCODE_AUTH_FILE
    else process.env.OPENCODE_AUTH_FILE = previousAuthFile
    if (previousDataDir === undefined) delete process.env.OPENCODE_DATA_DIR
    else process.env.OPENCODE_DATA_DIR = previousDataDir
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("skips malformed aliases when reading credentials", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-usage-alias-"))
  const authFile = path.join(directory, "auth.json")
  const previous = process.env.OPENCODE_AUTH_FILE
  fs.writeFileSync(authFile, JSON.stringify({
    first: { type: "api", key: "api-key" },
    second: { type: "oauth", refresh: "refresh-only" },
    third: { type: "oauth", access: "oauth-access" },
  }))
  process.env.OPENCODE_AUTH_FILE = authFile

  try {
    assert.equal(getOAuthEntry(["first", "second", "third"])?.access, "oauth-access")
    assert.equal(getCredential(["missing", "first"], ["key"]), "api-key")
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

test("applies OAuth expiry rules to token-only entries", () => {
  const future = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")
  const expired = Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")
  assert.equal(oauthTokenNeedsRefresh({ type: "oauth", token: `header.${future}.signature` }), false)
  assert.equal(oauthTokenNeedsRefresh({ type: "oauth", token: `header.${expired}.signature` }), true)
  assert.equal(oauthTokenNeedsRefresh({ type: "oauth", token: "opaque", expires: 1 }), true)
})
