import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { PromptDisplayMetadata } from "../lib/prompt-display-metadata"
import {
  clearPromptDisplayOverride,
  clearPromptDisplayOverridesForSession,
  clearPromptDisplayOverridesForInstance,
  getPromptDisplayOverride,
  movePromptDisplayOverride,
  resetPromptDisplayOverrideStateForTests,
  setPromptDisplayOverride,
} from "./message-prompt-display"

class MemoryStorage {
  private entries = new Map<string, string>()

  getItem(key: string): string | null {
    return this.entries.has(key) ? this.entries.get(key)! : null
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value)
  }

  removeItem(key: string): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }
}

type WindowWithMemoryStorage = {
  localStorage: {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
    clear(): void
  }
}

describe("message prompt display overrides", () => {
  it("persists and moves prompt display metadata by message id", () => {
    const instanceId = `instance-${Date.now()}`
    const sessionId = "session-1"
    const oldMessageId = "temp-msg"
    const newMessageId = "real-msg"
    const storage = new MemoryStorage()
    ;(globalThis as unknown as { window?: WindowWithMemoryStorage }).window = { localStorage: storage }
    resetPromptDisplayOverrideStateForTests()

    clearPromptDisplayOverridesForInstance(instanceId)

    const metadata: PromptDisplayMetadata = { segments: [{ kind: "inline", length: 7 }, { kind: "pasted", length: 6 }] }

    setPromptDisplayOverride(instanceId, sessionId, oldMessageId, metadata)
    assert.deepEqual(
      getPromptDisplayOverride(instanceId, sessionId, oldMessageId),
      metadata,
    )

    movePromptDisplayOverride(instanceId, sessionId, oldMessageId, newMessageId)
    assert.equal(getPromptDisplayOverride(instanceId, sessionId, oldMessageId), undefined)
    assert.deepEqual(
      getPromptDisplayOverride(instanceId, sessionId, newMessageId),
      metadata,
    )

    clearPromptDisplayOverride(instanceId, sessionId, newMessageId)
    assert.equal(getPromptDisplayOverride(instanceId, sessionId, newMessageId), undefined)

    delete (globalThis as unknown as { window?: unknown }).window
  })

  it("finds persisted metadata after reopening with a different instance id", () => {
    const firstInstanceId = `instance-a-${Date.now()}`
    const reopenedInstanceId = `instance-b-${Date.now()}`
    const sessionId = "session-stable"
    const messageId = "msg-1"
    const storage = new MemoryStorage()
    ;(globalThis as unknown as { window?: WindowWithMemoryStorage }).window = { localStorage: storage }
    resetPromptDisplayOverrideStateForTests()

    clearPromptDisplayOverridesForSession(firstInstanceId, sessionId)

    const metadata: PromptDisplayMetadata = { segments: [{ kind: "inline", length: 5 }, { kind: "pasted", length: 12 }] }
    setPromptDisplayOverride(firstInstanceId, sessionId, messageId, metadata)

    assert.deepEqual(getPromptDisplayOverride(reopenedInstanceId, sessionId, messageId), metadata)

    clearPromptDisplayOverride(reopenedInstanceId, sessionId, messageId)
    assert.equal(getPromptDisplayOverride(firstInstanceId, sessionId, messageId), undefined)

    delete (globalThis as unknown as { window?: unknown }).window
  })

  it("migrates legacy instance-scoped storage keys to stable reopen keys", () => {
    const storage = new MemoryStorage()
    const legacyInstanceId = "legacy-instance"
    const reopenedInstanceId = "reopened-instance"
    const sessionId = "session-legacy"
    const messageId = "msg-legacy"
    const metadata: PromptDisplayMetadata = { segments: [{ kind: "inline", length: 4 }, { kind: "pasted", length: 9 }] }

    storage.setItem(
      "codenomad:prompt-display:v2",
      JSON.stringify({ [`${legacyInstanceId}:${sessionId}:${messageId}`]: metadata }),
    )
    ;(globalThis as unknown as { window?: WindowWithMemoryStorage }).window = { localStorage: storage }
    resetPromptDisplayOverrideStateForTests()

    assert.deepEqual(getPromptDisplayOverride(reopenedInstanceId, sessionId, messageId), metadata)
    assert.equal(storage.getItem("codenomad:prompt-display:v3")?.includes(`${sessionId}:${messageId}`), true)
    assert.equal(storage.getItem("codenomad:prompt-display:v2"), null)

    clearPromptDisplayOverride(reopenedInstanceId, sessionId, messageId)
    resetPromptDisplayOverrideStateForTests()
    assert.equal(getPromptDisplayOverride(reopenedInstanceId, sessionId, messageId), undefined)

    delete (globalThis as unknown as { window?: unknown }).window
  })

  it("migrates legacy keys without rewriting stored stable v3 keys", () => {
    const storage = new MemoryStorage()
    const legacyInstanceId = "legacy-instance"
    const reopenedInstanceId = "reopened-instance"
    const sessionId = "session:with-colon"
    const messageId = "msg-with-colon"
    const stableSessionId = "stable-session"
    const stableMessageId = "msg:with:colons"
    const metadata: PromptDisplayMetadata = { segments: [{ kind: "inline", length: 4 }, { kind: "pasted", length: 9 }] }

    storage.setItem(
      "codenomad:prompt-display:v2",
      JSON.stringify({ [`${legacyInstanceId}:${sessionId}:${messageId}`]: metadata }),
    )
    storage.setItem(
      "codenomad:prompt-display:v3",
      JSON.stringify({ [`${stableSessionId}:${stableMessageId}`]: metadata }),
    )
    ;(globalThis as unknown as { window?: WindowWithMemoryStorage }).window = { localStorage: storage }
    resetPromptDisplayOverrideStateForTests()

    assert.deepEqual(getPromptDisplayOverride(reopenedInstanceId, sessionId, messageId), metadata)
    assert.deepEqual(getPromptDisplayOverride(reopenedInstanceId, stableSessionId, stableMessageId), metadata)
    assert.equal(storage.getItem("codenomad:prompt-display:v2"), null)

    delete (globalThis as unknown as { window?: unknown }).window
  })

  it("clears stable v3 entries for a session", () => {
    const instanceId = `instance-${Date.now()}`
    const storage = new MemoryStorage()
    ;(globalThis as unknown as { window?: WindowWithMemoryStorage }).window = { localStorage: storage }
    resetPromptDisplayOverrideStateForTests()

    const metadata: PromptDisplayMetadata = { segments: [{ kind: "inline", length: 3 }, { kind: "pasted", length: 8 }] }
    setPromptDisplayOverride(instanceId, "session-a", "msg-1", metadata)
    setPromptDisplayOverride(instanceId, "session-b", "msg-2", metadata)

    clearPromptDisplayOverridesForSession(instanceId, "session-a")

    assert.equal(getPromptDisplayOverride("other-instance", "session-a", "msg-1"), undefined)
    assert.deepEqual(getPromptDisplayOverride("other-instance", "session-b", "msg-2"), metadata)
    assert.deepEqual(
      JSON.parse(storage.getItem("codenomad:prompt-display:v3") ?? "{}"),
      { "session-b:msg-2": metadata },
    )

    resetPromptDisplayOverrideStateForTests()
    assert.equal(getPromptDisplayOverride("other-instance", "session-a", "msg-1"), undefined)
    assert.deepEqual(getPromptDisplayOverride("other-instance", "session-b", "msg-2"), metadata)

    delete (globalThis as unknown as { window?: unknown }).window
  })

  it("clears stable v3 entries for all known instance sessions", () => {
    const instanceId = `instance-${Date.now()}`
    const storage = new MemoryStorage()
    ;(globalThis as unknown as { window?: WindowWithMemoryStorage }).window = { localStorage: storage }
    resetPromptDisplayOverrideStateForTests()

    const metadata: PromptDisplayMetadata = { segments: [{ kind: "inline", length: 2 }, { kind: "pasted", length: 5 }] }
    setPromptDisplayOverride(instanceId, "session-a", "msg-1", metadata)
    setPromptDisplayOverride(instanceId, "session-b", "msg-2", metadata)
    setPromptDisplayOverride(instanceId, "session-c", "msg-3", metadata)

    clearPromptDisplayOverridesForInstance(instanceId, ["session-a", "session-b"])

    assert.equal(getPromptDisplayOverride("reopened", "session-a", "msg-1"), undefined)
    assert.equal(getPromptDisplayOverride("reopened", "session-b", "msg-2"), undefined)
    assert.deepEqual(getPromptDisplayOverride("reopened", "session-c", "msg-3"), metadata)

    delete (globalThis as unknown as { window?: unknown }).window
  })
})
