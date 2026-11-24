import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { notificationBadgeBitmap, setupNotificationBadgeIPC } from "./notification-badge"

function harness() {
  let handler: Function
  const owned = new Set<any>()
  const output: Array<{ count: number; windows: unknown[] }> = []
  const bind = setupNotificationBadgeIPC({ handle: (_channel, fn) => { handler = fn } },
    sender => [...owned].find(window => window.webContents === sender),
    () => ["http://127.0.0.1:3000", "https://remote.example"],
    (count, windows) => output.push({ count, windows }))
  const make = (url = "http://127.0.0.1:3000/app", registered = true) => {
    let destroyed = false
    const contents = Object.assign(new EventEmitter(), { mainFrame: { url }, getURL: () => url })
    const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => destroyed })
    if (registered) { owned.add(window); bind(window as never) }
    return {
      window, contents,
      event: () => ({ sender: contents, senderFrame: contents.mainFrame }),
      close: () => { destroyed = true; owned.delete(window); window.emit("closed") },
    }
  }
  return { make, output, set: (event: unknown, count: unknown) => handler!(event, count) }
}

test("badge counts aggregate local/remote windows, reset one on reload/crash/close, and preserve peers", () => {
  const h = harness()
  const local = h.make()
  const remote = h.make("https://remote.example/app")
  h.set(local.event(), 50)
  h.set(remote.event(), 12)
  assert.equal(h.output.at(-1)!.count, 62)
  local.contents.emit("did-start-navigation", {}, "/next", true, true)
  assert.equal(h.output.at(-1)!.count, 62, "in-page navigation preserves the document")
  local.contents.emit("did-start-navigation", {}, "/next", false, false)
  assert.equal(h.output.at(-1)!.count, 62, "subframes cannot reset the main contribution")
  const oldFrame = local.event()
  local.contents.emit("did-start-navigation", {}, "/next", false, true)
  assert.equal(h.output.at(-1)!.count, 12)
  assert.throws(() => h.set(oldFrame, 5), /navigating/)
  local.contents.mainFrame = { url: oldFrame.senderFrame.url }
  local.contents.emit("did-navigate")
  assert.throws(() => h.set(oldFrame, 5), /main frame/)
  h.set(local.event(), 4)
  assert.equal(h.output.at(-1)!.count, 16)
  local.contents.emit("render-process-gone")
  assert.equal(h.output.at(-1)!.count, 12)
  remote.close()
  assert.equal(h.output.at(-1)!.count, 0)
  assert.throws(() => h.set(remote.event(), 10), /owned main window/)
  local.close()
  assert.deepEqual(h.output.at(-1), { count: 0, windows: [] })
  const published = h.output.length
  local.contents.emit("render-process-gone")
  local.contents.emit("did-start-navigation", {}, "/late", false, true)
  assert.equal(h.output.length, published, "late events cannot re-add a closed window")
})

test("badges reject malformed counts, preferences/guests, child frames, and wrong origins", () => {
  const h = harness()
  const local = h.make()
  h.set(local.event(), 3)
  for (const invalid of [NaN, Infinity, -1, 51, 1.5, "2", null, undefined, {}, true]) {
    assert.throws(() => h.set(local.event(), invalid), /integer/)
    assert.equal(h.output.at(-1)!.count, 3)
  }
  const preferences = h.make(undefined, false)
  assert.throws(() => h.set(preferences.event(), 3), /owned main window/)
  assert.throws(() => h.set({ sender: new EventEmitter(), senderFrame: local.contents.mainFrame }, 3), /owned main window/)
  assert.throws(() => h.set({ sender: local.contents, senderFrame: { url: local.contents.mainFrame.url } }, 3), /main frame/)
  const untrusted = h.make("https://evil.example")
  assert.throws(() => h.set(untrusted.event(), 3), /allowed renderer origin/)
  h.set(local.event(), 0)
  assert.equal(h.output.at(-1)!.count, 0)
})

test("Windows counters use bounded native-generated red BGRA pixels with white digits", () => {
  for (const count of [1, 12, 50, 99, 100, 800]) {
    const pixels = notificationBadgeBitmap(count)
    assert.equal(pixels.length, 32 * 32 * 4)
    assert.equal(pixels[3], 0)
    assert.ok(pixels.includes(Buffer.from([48, 48, 220, 255])))
    assert.ok(pixels.includes(Buffer.from([255, 255, 255, 255])))
  }
  assert.deepEqual(notificationBadgeBitmap(100), notificationBadgeBitmap(800))
})
