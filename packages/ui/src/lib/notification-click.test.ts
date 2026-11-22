import assert from "node:assert/strict"
import test from "node:test"
import { createNotificationClicks } from "./notification-click"
import { sendOsNotification } from "./os-notifications"

test("native clicks run only their own live action once", async () => {
  const clicks = createNotificationClicks(2)
  const context = new AbortController()
  const calls: string[] = []
  const otherWindow = createNotificationClicks()
  const evicted = clicks.remember({ onClick: () => { calls.push("evicted") } })
  const revoked = clicks.remember({ signal: context.signal, onClick: () => { calls.push("revoked") } })
  const live = clicks.remember({ onClick: async () => { calls.push("live") } })
  context.abort()

  for (const value of [{ id: live }, evicted, revoked]) await clicks.run(value)
  await otherWindow.run(live)
  await Promise.all([clicks.run(live), clicks.run(live)])
  assert.deepEqual(calls, ["live"])
})

test("the desktop click listener receives only an opaque action ID", async () => {
  let deliver: ((value: unknown) => void) | undefined
  const sent: Array<{ actionId?: string }> = []
  const wnd = {
    __CODENOMAD_RUNTIME_HOST__: "electron",
    electronAPI: {
      onNotificationClick: (callback: (value: unknown) => void) => { deliver = callback },
      showNotification: async (payload: { actionId?: string }) => { sent.push(payload); return { ok: true } },
    },
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: wnd })
  try {
    let run = 0
    await sendOsNotification({ title: "Project", body: "Ready", onClick: () => { run++ } })
    await sendOsNotification({ title: "Plain", body: "Ready" })
    assert.match(sent[0].actionId ?? "", /^[a-f0-9-]{36}$/)
    assert.deepEqual(Object.keys(sent[0]), ["title", "body", "actionId"])
    assert.equal(sent[1].actionId, undefined)
    deliver?.(undefined)
    deliver?.(sent[0].actionId)
    deliver?.(sent[0].actionId)
    assert.equal(run, 1)
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous)
    else Reflect.deleteProperty(globalThis, "window")
  }
})
