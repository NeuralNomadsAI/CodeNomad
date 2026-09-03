import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { loadOrCreateRemoteControlIdentity } from "./identity"

test("Remote Control identity is random, persistent, and never stores malformed input", () => {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-remote-control-"))
  try {
    const first = loadOrCreateRemoteControlIdentity(directory)
    assert.match(first.hostId, /^[a-f0-9]{32}$/)
    assert.match(first.secret, /^[A-Za-z0-9_-]{40,}$/)
    assert.deepEqual(loadOrCreateRemoteControlIdentity(directory), first)

    const stored = JSON.parse(readFileSync(join(directory, "remote-control.json"), "utf8"))
    assert.deepEqual(stored, first)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("malformed existing identities are replaced atomically", () => {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-remote-control-"))
  try {
    writeFileSync(join(directory, "remote-control.json"), JSON.stringify({ hostId: "predictable", secret: "short" }))
    const identity = loadOrCreateRemoteControlIdentity(directory)
    assert.notEqual(identity.hostId, "predictable")
    assert.notEqual(identity.secret, "short")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
