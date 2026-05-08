import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  clearPromptDisplayOverride,
  clearPromptDisplayOverridesForInstance,
  getPromptDisplayOverride,
  movePromptDisplayOverride,
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
  it("persists and moves hidden prompt display text by message id", () => {
    const instanceId = `instance-${Date.now()}`
    const sessionId = "session-1"
    const oldMessageId = "temp-msg"
    const newMessageId = "real-msg"
    const storage = new MemoryStorage()
    ;(globalThis as unknown as { window?: WindowWithMemoryStorage }).window = { localStorage: storage }

    clearPromptDisplayOverridesForInstance(instanceId)

    setPromptDisplayOverride(instanceId, sessionId, oldMessageId, "Visible<codenomad:hide>Hidden</codenomad:hide>")
    assert.equal(
      getPromptDisplayOverride(instanceId, sessionId, oldMessageId),
      "Visible<codenomad:hide>Hidden</codenomad:hide>",
    )

    movePromptDisplayOverride(instanceId, sessionId, oldMessageId, newMessageId)
    assert.equal(getPromptDisplayOverride(instanceId, sessionId, oldMessageId), undefined)
    assert.equal(
      getPromptDisplayOverride(instanceId, sessionId, newMessageId),
      "Visible<codenomad:hide>Hidden</codenomad:hide>",
    )

    clearPromptDisplayOverride(instanceId, sessionId, newMessageId)
    assert.equal(getPromptDisplayOverride(instanceId, sessionId, newMessageId), undefined)

    delete (globalThis as unknown as { window?: unknown }).window
  })
})
