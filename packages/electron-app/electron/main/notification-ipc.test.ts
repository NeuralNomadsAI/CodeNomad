import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import { validateMainFrame } from "./ipc-security"
import { setupNotificationIPC } from "./notification-ipc"

const actionId = "6d12e2b8-6c88-4dbd-ae52-f78ed81cf2df"
const payload = { title: "Project", body: "Ready", actionId }

function fixture(windows = false) {
  const calls: unknown[] = []
  const frame = { url: "https://app.test/", send: (...args: unknown[]) => calls.push(args) }
  const sender = Object.assign(new EventEmitter(), { mainFrame: frame, getURL: (): string => sender.mainFrame.url })
  let destroyed = false
  const window = {
    webContents: sender, isDestroyed: () => destroyed, isMinimized: () => true,
    restore: () => calls.push("restore"), show: () => calls.push("show"), focus: () => calls.push("focus"),
  } as unknown as BrowserWindow
  const notices: EventEmitter[] = []
  let show!: (event: IpcMainInvokeEvent, payload: unknown) => unknown
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
  setupNotificationIPC({ handle(channel, fn) {
    assert.equal(channel, "notifications:show")
    show = fn
  } }, incoming => {
    validateMainFrame(incoming, window, ["https://app.test"])
    return window
  }, options => {
    const notice = Object.assign(new EventEmitter(), { show: () => calls.push(options) })
    notices.push(notice)
    return notice
  }, windows)
  return { calls, notices, sender, event, show, destroy: () => { destroyed = true } }
}

test("the IPC validates the sender and opaque action before creating a notification", () => {
  const { calls, event, show } = fixture()
  for (const bad of [null, { ...payload, body: 1 }, ...[null, {}, "", "https://app.test/"].map(value => ({ ...payload, actionId: value }))]) {
    assert.throws(() => show(event, bad), /Invalid notification/)
  }
  assert.throws(() => show({ ...event, senderFrame: null }, payload), /registered main frame/)
  assert.deepEqual(calls, [])
})

test("click restores the sender before forwarding its action, once; actionless clicks focus too", () => {
  const { calls, notices, event, show } = fixture()
  const text = { title: payload.title, body: payload.body }
  assert.deepEqual(show(event, payload), { ok: true })
  notices[0].emit("click")
  notices[0].emit("click")
  show(event, text)
  notices[1].emit("click")
  assert.deepEqual(calls, [text, "restore", "show", "focus", ["notifications:click", actionId], text, "restore", "show", "focus"])
})

test("a retired frame or closed window cannot receive its click", () => {
  const { calls, notices, event, sender, show, destroy } = fixture()
  show(event, payload)
  const original = sender.mainFrame
  sender.mainFrame = { ...original }
  notices[0].emit("click")
  sender.mainFrame = original
  show(event, payload)
  sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
  notices[1].emit("click")
  show(event, payload)
  destroy()
  notices[2].emit("click")
  assert.equal(calls.length, 3) // Only the native shows.
})

test("dismissal retires the callback, but a timed-out Windows banner can remain clickable", () => {
  const { calls, notices, event, show } = fixture()
  show(event, payload)
  notices[0].emit("close", { reason: "userCanceled" })
  notices[0].emit("click")
  show(event, payload)
  notices[1].emit("close", { reason: "timedOut" })
  notices[1].emit("click")
  assert.equal(calls.filter(call => call === "focus").length, 1)
})

test("Windows Notification Center can return the OS tag to the same notification", () => {
  const { calls, event, show } = fixture(true)
  show(event, { ...payload, title: "<A> & B" })
  const native = calls[0] as { id: string; toastXml: string }
  assert.notEqual(native.id, actionId)
  assert.ok(native.toastXml.includes(`launch="type=click&amp;tag=${native.id}"`))
  assert.ok(native.toastXml.includes("<text>&lt;A&gt; &amp; B</text>"))
})
