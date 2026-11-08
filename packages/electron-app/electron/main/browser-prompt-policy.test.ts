import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import { createBrowserPromptHandler, validPromptRequest } from "./browser-prompt-policy"
import type { BrowserWindow, IpcMainEvent, WebContents } from "electron"

test("preview preload exposes only standard prompt and can send only its dedicated channel", () => {
  const page: Record<string, unknown> = { prompt: () => { throw Error("unsupported") } }
  const calls: unknown[][] = []
  const source = readFileSync(new URL("../preload/browser-prompt.cjs", import.meta.url), "utf8")
  vm.runInNewContext(source, { require: (name: string) => {
    assert.equal(name, "electron")
    return { contextBridge: {
      executeInMainWorld: ({ func }: { func: Function }) => vm.runInNewContext(`(${func.toString()})()`, { window: page }),
      exposeInMainWorld: (key: string, value: unknown) => { assert.equal(key, "prompt"); page[key] = value },
    }, ipcRenderer: { sendSync: (...args: unknown[]) => { calls.push(args); return "answer" } } }
  } })
  assert.deepEqual(Object.keys(page), ["prompt"])
  assert.equal((page.prompt as Function)("message", "default"), "answer")
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["codenomad:browser-prompt", { message: "message", value: "default" }]])
  for (const key of ["require", "ipcRenderer", "electronAPI", "contextBridge", "send", "invoke"]) assert.equal(page[key], undefined)
})

test("main rejects non-preview and foreign frames, accepts only bounded prompt values", async () => {
  const frame = { origin: "https://frame.example", detached: false }
  const sender = { isDestroyed: () => false, mainFrame: { framesInSubtree: [frame] } } as unknown as WebContents
  const owner = { isDestroyed: () => false } as BrowserWindow
  let shown = 0
  const handler = createBrowserPromptHandler(contents => contents === sender ? owner : undefined,
    async (_owner, origin, message, value) => { shown++; assert.equal(origin, frame.origin); assert.equal(message, "m"); return value })
  const event = (contents: WebContents = sender, source = frame) => ({ sender: contents, senderFrame: source } as unknown as IpcMainEvent)
  const foreign = event({} as WebContents); handler(foreign, { message: "m", value: "s" }); assert.equal(foreign.returnValue, null)
  const forged = event(sender, { ...frame }); handler(forged, { message: "m", value: "s" }); assert.equal(forged.returnValue, null)
  const valid = event(); handler(valid, { message: "m", value: "s" }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(valid.returnValue, "s"); assert.equal(shown, 1)
  const next = event()
  const immediate = event()
  Object.defineProperty(immediate, "returnValue", { set: () => handler(next, { message: "m", value: "next" }) })
  handler(immediate, { message: "m", value: "first" })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(next.returnValue, "next")
  assert.equal(shown, 3)
  for (const args of [null, [], { message: "m", value: "s", channel: "other" }, { message: "m", value: "x".repeat(65_537) }]) assert.equal(validPromptRequest(args), false)
})

test("late prompt replies are cancelled after document replacement or owner retirement", async () => {
  for (const cause of ["document", "owner", "frame"] as const) {
    const frame = { origin: "https://frame.example", detached: false }
    const sender = { isDestroyed: () => false, mainFrame: { framesInSubtree: [frame] } } as unknown as WebContents
    const owner = { isDestroyed: () => false } as BrowserWindow
    let live = true, revision = Symbol()
    let resolve!: (value: string) => void
    let current!: () => boolean
    const handler = createBrowserPromptHandler(() => live ? owner : undefined,
      (_owner, _origin, _message, _value, source, guard) => {
        assert.equal(source, sender); current = guard
        return new Promise<string>(answer => { resolve = answer })
      }, () => revision)
    const event = { sender, senderFrame: frame } as unknown as IpcMainEvent
    handler(event, { message: "m", value: "s" })
    if (cause === "document") revision = Symbol()
    if (cause === "owner") live = false
    if (cause === "frame") frame.detached = true
    assert.equal(current(), false)
    resolve("stale-answer")
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(event.returnValue, null)
  }
})
