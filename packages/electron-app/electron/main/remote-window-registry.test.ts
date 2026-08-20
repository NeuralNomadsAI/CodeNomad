import assert from "node:assert/strict"
import test from "node:test"
import { RemoteWindowRegistry } from "./remote-window-registry"

function window() {
  const events = new Map<string, () => void>()
  const calls: string[] = []
  return {
    calls,
    events,
    value: {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: () => calls.push("restore"),
      show: () => calls.push("show"),
      focus: () => calls.push("focus"),
      close: () => calls.push("close"),
      on: (name: string, callback: () => void) => events.set(name, callback),
    } as never,
  }
}

test("remote profiles reuse one window and preserve direct profile sessions", () => {
  const cleaned: string[] = []
  const registry = new RemoteWindowRegistry((id) => cleaned.push(id))
  const direct = window()
  registry.register("profile", direct.value)
  assert.equal(registry.reuse("profile"), direct.value)
  assert.deepEqual(direct.calls, ["show", "focus"])
  direct.events.get("closed")?.()
  assert.deepEqual(cleaned, [])
})

test("proxy replacement and close clean exactly their corresponding sessions", () => {
  const cleaned: string[] = []
  const registry = new RemoteWindowRegistry((id) => cleaned.push(id))
  const first = window()
  registry.register("profile", first.value, "proxy-one")
  assert.equal(registry.reuse("profile", "proxy-two"), undefined)
  assert.deepEqual(first.calls, ["close"])
  assert.deepEqual(cleaned, ["proxy-one"])
  const second = window()
  registry.register("profile", second.value, "proxy-two")
  first.events.get("closed")?.()
  second.events.get("closed")?.()
  assert.deepEqual(cleaned, ["proxy-one", "proxy-two"])
})
