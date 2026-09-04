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
    assert.equal(first.encryptionPublicKey.crv, "P-256")
    assert.equal(first.encryptionPrivateKey.crv, "P-256")
    assert.equal(typeof first.encryptionPrivateKey.d, "string")
    assert.deepEqual(loadOrCreateRemoteControlIdentity(directory), first)

    const stored = JSON.parse(readFileSync(join(directory, "remote-control.json"), "utf8"))
    assert.deepEqual(stored, first)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("legacy relay identities gain encryption keys without changing their address or secret", () => {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-remote-control-"))
  const legacy = { hostId: "a".repeat(32), secret: "b".repeat(48) }
  try {
    writeFileSync(join(directory, "remote-control.json"), JSON.stringify(legacy))
    const identity = loadOrCreateRemoteControlIdentity(directory)
    assert.equal(identity.hostId, legacy.hostId)
    assert.equal(identity.secret, legacy.secret)
    assert.equal(identity.encryptionPublicKey.crv, "P-256")
    assert.equal(typeof identity.encryptionPrivateKey.d, "string")
    assert.deepEqual(loadOrCreateRemoteControlIdentity(directory), identity)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("mismatched encryption keys are replaced without changing the relay identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-remote-control-"))
  try {
    const first = loadOrCreateRemoteControlIdentity(directory)
    const otherDirectory = mkdtempSync(join(tmpdir(), "codenomad-remote-control-other-"))
    try {
      const other = loadOrCreateRemoteControlIdentity(otherDirectory)
      writeFileSync(join(directory, "remote-control.json"), JSON.stringify({
        ...first,
        encryptionPublicKey: other.encryptionPublicKey,
      }))
      const repaired = loadOrCreateRemoteControlIdentity(directory)
      assert.equal(repaired.hostId, first.hostId)
      assert.equal(repaired.secret, first.secret)
      assert.notDeepEqual(repaired.encryptionPrivateKey, first.encryptionPrivateKey)
      assert.notDeepEqual(repaired.encryptionPublicKey, other.encryptionPublicKey)
    } finally {
      rmSync(otherDirectory, { recursive: true, force: true })
    }
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
