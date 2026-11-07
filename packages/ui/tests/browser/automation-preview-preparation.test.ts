import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import vm from "node:vm"

// Runs the real Electron preview fixture's preparation against fake Electron objects and a fake clock.
const FIXTURE = readFileSync(new URL("fixtures/automation-preview-electron.cjs", import.meta.url), "utf8")
const GUEST_URL = "http://127.0.0.1:1/"
const PENDING = ["UnknownVizError", "VizSentEmptyBitmap", "Current display surface not available for capture"]

type Capture = { resolve(image: { isEmpty(): boolean }): void; reject(error: Error): void }

function prepare() {
  let now = 0, nextTimer = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const handlers = new Map<string, () => void>()
  const captures: Capture[] = []
  let inFlight = 0, maxInFlight = 0, focusedWindow: object | null = null
  const owner = { visible: false, focused: false }
  const guest = {
    id: 7, url: GUEST_URL, destroyed: false,
    on: (event: string, handler: () => void) => { handlers.set(event, handler) },
    getURL: () => guest.url, isLoading: () => false, isDestroyed: () => guest.destroyed,
    capturePage: (rect: unknown, options: unknown) => {
      assert.equal(JSON.stringify([rect, options]), JSON.stringify([{ x: 0, y: 0, width: 1, height: 1 }, { stayHidden: true }]))
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise((resolve, reject) => { captures.push({ resolve, reject }) }).finally(() => { inFlight-- })
    },
  }
  let attach: ((event: unknown, contents: unknown) => void) | undefined
  class BrowserWindow {
    static getFocusedWindow = () => focusedWindow
    webContents = { on: (_event: string, handler: typeof attach) => { attach = handler }, isFocused: () => false }
    isVisible = () => owner.visible
    isFocused = () => owner.focused
    isDestroyed = () => false
    loadURL = async () => {}
  }
  const electron = { app: { setPath() {}, whenReady: () => Promise.resolve(), on() {} }, BrowserWindow }
  const bundle = {
    BrowserController: class { observeGuest() {} register() {} },
    BrowserPage: class { execute() {} },
    handleNativeBrowserRequest() {},
  }
  const context = vm.createContext({
    require: (name: string) => name === "electron" ? electron : name === "bundle" ? bundle : assert.fail(`unexpected require ${name}`),
    process: { env: { CODENOMAD_TEST_AUTOMATION_BUNDLE: "bundle", CODENOMAD_TEST_GUEST_URL: GUEST_URL } },
    performance: { now: () => now },
    setTimeout: (run: () => void, ms: number) => { const id = ++nextTimer; timers.set(id, { at: now + ms, run }); return id },
    clearTimeout: (id: number) => { timers.delete(id) },
    globalThis: {} as Record<string, any>,
  })
  context.globalThis = context
  vm.runInContext(FIXTURE, context)
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const advance = async (ms: number) => {
    const target = now + ms
    for (;;) {
      await settle()
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0]); now = due[1].at; due[1].run()
    }
    now = target
    await settle()
  }
  return {
    owner, guest, captures, timers, advance, settle,
    setFocusedWindow: (value: object | null) => { focusedWindow = value },
    maxInFlight: () => maxInFlight,
    load: () => handlers.get("did-stop-loading")!(),
    async start(loaded = true) {
      await settle()
      attach!({}, guest)
      const outcome = { done: false, value: undefined as any, error: undefined as Error | undefined }
      ;(context.automationPreview.ready() as Promise<unknown>).then(value => { outcome.value = value }, error => { outcome.error = error })
        .finally(() => { outcome.done = true })
      if (loaded) handlers.get("did-stop-loading")!()
      await settle()
      return outcome
    },
  }
}

const hidden = { visible: false, focused: false, focusedWindow: false }

test("preparation retries only a pending surface, one capture at a time, until a non-empty capture", async () => {
  const fixture = prepare()
  const outcome = await fixture.start()
  for (const message of PENDING) { fixture.captures.at(-1)!.reject(new Error(message)); await fixture.advance(50) }
  fixture.captures.at(-1)!.resolve({ isEmpty: () => true }); await fixture.advance(50)
  fixture.captures.at(-1)!.resolve({ isEmpty: () => false }); await fixture.settle()
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.value)), { loaded: true, rendered: true, before: hidden, after: hidden, captures: 5 })
  assert.equal(fixture.maxInFlight(), 1)
  assert.equal(fixture.timers.size, 0, "no preparation timer outlives it")
})

test("any other capture error fails at once", async () => {
  for (const message of ["Frame Gone", "Timeout", "EmbeddingTokenChanged", "Unknown", "Not implemented"]) {
    const fixture = prepare()
    const outcome = await fixture.start()
    fixture.captures[0].reject(new Error(message)); await fixture.settle()
    assert.equal(outcome.error?.message, message)
    assert.equal(fixture.captures.length, 1)
    assert.equal(fixture.timers.size, 0)
  }
})

test("a capture that settles after the guest navigated, was destroyed or its window gained focus is refused", async () => {
  const changes: Array<[string, (fixture: ReturnType<typeof prepare>) => void, RegExp]> = [
    ["navigation", fixture => { fixture.guest.url = `${GUEST_URL}late` }, /guest left/],
    ["destruction", fixture => { fixture.guest.destroyed = true }, /guest was destroyed/],
    ["window focus", fixture => { fixture.owner.focused = true }, /visible or focused/],
    ["window shown", fixture => { fixture.owner.visible = true }, /visible or focused/],
    ["application focus", fixture => { fixture.setFocusedWindow({}) }, /visible or focused/],
  ]
  for (const [name, change, expected] of changes) {
    const fixture = prepare()
    const outcome = await fixture.start()
    change(fixture)
    fixture.captures[0].resolve({ isEmpty: () => false }); await fixture.settle()
    assert.match(String(outcome.error?.message), expected, name)
    assert.equal(outcome.value, undefined, name)
  }
})

test("one 10 s budget covers loading and capturing, including a load or capture that never settles", async () => {
  const unloaded = prepare()
  const waiting = await unloaded.start(false)
  await unloaded.advance(9_999)
  assert.equal(waiting.done, false)
  await unloaded.advance(1)
  assert.match(String(waiting.error?.message), /the guest did not load within 10000 ms/)
  assert.equal(unloaded.captures.length, 0)

  // A load at 9.9 s leaves its capture only the remaining 100 ms of the same budget.
  const late = prepare()
  const outcome = await late.start(false)
  await late.advance(9_900)
  late.load(); await late.settle()
  assert.equal(late.captures.length, 1)
  await late.advance(99)
  assert.equal(outcome.done, false)
  await late.advance(1)
  assert.match(String(outcome.error?.message), /a guest capture did not settle within 10000 ms/)
  assert.equal(late.timers.size, 0)

  const unhandled: unknown[] = []
  const record = (reason: unknown) => { unhandled.push(reason) }
  process.on("unhandledRejection", record)
  try {
    late.captures[0].reject(new Error("Frame Gone"))
    await late.settle(); await late.settle()
    assert.deepEqual(unhandled, [], "a capture failing after the budget is not an unhandled rejection")
  } finally {
    process.off("unhandledRejection", record)
  }
})

test("a surface that stays pending fails at the budget without a capture in flight beyond it", async () => {
  const fixture = prepare()
  const outcome = await fixture.start()
  while (!outcome.done) {
    fixture.captures.at(-1)!.reject(new Error("UnknownVizError"))
    await fixture.advance(50)
  }
  assert.match(String(outcome.error?.message), /no rendered guest surface within 10000 ms/)
  assert.equal(fixture.maxInFlight(), 1)
  assert.equal(fixture.timers.size, 0)
})
