import assert from "node:assert/strict"
import test from "node:test"
import type { BrowserWindow } from "electron"
import { navigateReusedRemoteWindow, RemoteWindowRegistry } from "./remote-window-registry"

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
    } as unknown as BrowserWindow,
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

test("reused remote navigation trusts old and next redirect origins until success", async () => {
  const remote = window()
  const trusted = new Map([[1, new Set(["https://old.example"])]])
  const insecure = new Map([[2, new Set(["https://old.example"])]])
  Object.assign(remote.value, { id: 1, webContents: { id: 2 } })
  remote.value.loadURL = async () => {
    assert.deepEqual([...trusted.get(1)!], ["https://old.example", "https://new.example", "https://redirect.example"])
  }

  const next = new Set(["https://new.example", "https://redirect.example"])
  await navigateReusedRemoteWindow(remote.value, new URL("https://new.example/app"), next, trusted, insecure, false)
  assert.deepEqual([...trusted.get(1)!], [...next])
  assert.equal(insecure.has(2), false)
})

test("failed reused remote navigation restores trusted and insecure origins", async () => {
  const remote = window()
  const trusted = new Map([[1, new Set(["https://old.example"])]])
  const insecure = new Map([[2, new Set(["https://old.example"])]])
  Object.assign(remote.value, { id: 1, webContents: { id: 2 } })
  remote.value.loadURL = async () => {
    assert.deepEqual([...trusted.get(1)!], ["https://old.example", "https://new.example"])
    assert.deepEqual([...insecure.get(2)!], ["https://old.example", "https://new.example"])
    throw new Error("failed")
  }

  const next = new Set(["https://new.example"])
  await assert.rejects(navigateReusedRemoteWindow(remote.value, new URL("https://new.example/app"), next, trusted, insecure, true), /failed/)
  assert.deepEqual([...trusted.get(1)!], ["https://old.example"])
  assert.deepEqual([...insecure.get(2)!], ["https://old.example"])
})
