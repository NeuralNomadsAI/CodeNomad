import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getClientIdentity } from "./client-identity.ts"

class MemoryStorage {
  private readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

describe("client identity", () => {
  it("shares client id while native windows use distinct stable connection ids", () => {
    const localStorage = new MemoryStorage()
    const sessionStorage = new MemoryStorage()
    const setWindow = (windowId: string) => {
      ;(globalThis as any).window = { localStorage, sessionStorage, __CODENOMAD_WINDOW_ID__: windowId }
    }

    setWindow("window-a")
    const first = getClientIdentity()
    setWindow("window-b")
    const second = getClientIdentity()
    setWindow("window-a")
    const reloaded = getClientIdentity()

    assert.equal(first.clientId, second.clientId)
    assert.equal(first.connectionId, "window-a")
    assert.equal(second.connectionId, "window-b")
    assert.equal(reloaded.connectionId, first.connectionId)
    delete (globalThis as any).window
  })
})
