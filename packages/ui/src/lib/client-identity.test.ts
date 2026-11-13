import assert from "node:assert/strict"
import { describe, it, test } from "node:test"
import { generateUUID, getClientIdentity } from "./client-identity.ts"

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

test("UUIDs retain native generation and use Web Crypto entropy when randomUUID is unavailable", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!
  try {
    const native = "00000000-0000-4000-8000-000000000001"
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: { randomUUID: () => native } })
    assert.equal(generateUUID(), native)
    let reads = 0
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {
      getRandomValues: (bytes: Uint8Array) => { reads++; return bytes.fill(255) },
    } })
    assert.equal(generateUUID(), "ffffffff-ffff-4fff-bfff-ffffffffffff")
    assert.equal(reads, 1)
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} })
    assert.throws(() => generateUUID(), TypeError, "missing Web Crypto must never downgrade to weak entropy")
  } finally { Object.defineProperty(globalThis, "crypto", descriptor) }
})
