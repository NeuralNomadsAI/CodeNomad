import assert from "node:assert/strict"
import test from "node:test"
import { NativeParent, NativeRequestRefused, NATIVE_REQUEST_PREFIX, NATIVE_RESPONSE_PREFIX } from "./native-parent"

test("WebKit transport exposes browser automation and respects explicit missing capabilities", () => {
  const previous = process.env.CODENOMAD_TAURI_WEBKIT
  const previousCapability = process.env.CODENOMAD_NATIVE_BROWSER_AUTOMATION
  try {
    process.env.CODENOMAD_TAURI_WEBKIT = "1"
    delete process.env.CODENOMAD_NATIVE_BROWSER_AUTOMATION
    assert.equal(new NativeParent(undefined, true).browserAutomationUnavailable, false)
    assert.equal(new NativeParent(undefined, false).browserAutomationUnavailable, false)
    process.env.CODENOMAD_NATIVE_BROWSER_AUTOMATION = "1"
    assert.equal(new NativeParent(undefined, true).browserAutomationUnavailable, false)
    process.env.CODENOMAD_NATIVE_BROWSER_AUTOMATION = "0"
    assert.equal(new NativeParent(undefined, true).browserAutomationUnavailable, true)
    assert.equal(new NativeParent(undefined, false).browserAutomationUnavailable, true)
  } finally {
    if (previous === undefined) delete process.env.CODENOMAD_TAURI_WEBKIT
    else process.env.CODENOMAD_TAURI_WEBKIT = previous
    if (previousCapability === undefined) delete process.env.CODENOMAD_NATIVE_BROWSER_AUTOMATION
    else process.env.CODENOMAD_NATIVE_BROWSER_AUTOMATION = previousCapability
  }
})

test("a genuinely unavailable native transport rejects requests", async () => {
  const parent = new NativeParent({ write: () => { throw new Error("Unexpected native request") } }, false, true)
  assert.equal(parent.browserAutomationUnavailable, true)
  await assert.rejects(parent.request("browser.probe", {}), error =>
    error instanceof NativeRequestRefused && /Native control is unavailable/.test(error.message))
})

test("matches native responses to requests and rejects pending work on shutdown", async () => {
  const lines: string[] = []
  const parent = new NativeParent({ write: (line: string | Uint8Array) => { lines.push(String(line)); return true } }, true)

  const request = parent.request<{ available: boolean }>("developer.status", {})
  const envelope = JSON.parse(lines[0].slice(NATIVE_REQUEST_PREFIX.length)) as { id: string; deadline: number }
  assert.ok(envelope.deadline > Date.now())
  parent.handleLine(`${NATIVE_RESPONSE_PREFIX}${JSON.stringify({ v: 1, id: envelope.id })}`)
  assert.equal(parent.handleLine(`${NATIVE_RESPONSE_PREFIX}${JSON.stringify({ v: 1, id: envelope.id, ok: true, result: { available: true } })}`), true)
  assert.deepEqual(await request, { available: true })

  const pending = parent.request("developer.status", {})
  parent.close()
  await assert.rejects(pending, error =>
    error instanceof Error && !(error instanceof NativeRequestRefused) && /shutting down/.test(error.message))
  await assert.rejects(parent.request("developer.status", {}), error =>
    error instanceof NativeRequestRefused && /shutting down/.test(error.message))
})

test("late native replies cannot settle a subsequent request", async () => {
  const lines: string[] = []
  const parent = new NativeParent({ write: line => { lines.push(String(line)); return true } }, true)
  const first = parent.request("browser.probe", {}, 5)
  const old = JSON.parse(lines[0].slice(NATIVE_REQUEST_PREFIX.length))
  await assert.rejects(first, error =>
    error instanceof Error && !(error instanceof NativeRequestRefused) && /timed out/.test(error.message))
  const second = parent.request("browser.probe", {}, 1000)
  const current = JSON.parse(lines[1].slice(NATIVE_REQUEST_PREFIX.length))
  parent.handleLine(`${NATIVE_RESPONSE_PREFIX}${JSON.stringify({ v: 1, id: old.id, ok: true, result: "stale" })}`)
  parent.handleLine(`${NATIVE_RESPONSE_PREFIX}${JSON.stringify({ v: 1, id: current.id, ok: true, result: "current" })}`)
  assert.equal(await second, "current")
  parent.close()
})

test("absolute native deadlines fence replies at receipt before the timer runs", async t => {
  let now = 1_000
  t.mock.method(Date, "now", () => now)
  let requestLine = ""
  const parent = new NativeParent({ write: line => { requestLine = String(line); return true } }, true)
  t.after(() => parent.close())
  const send = (budget: number | { deadline: number }, receivedAt: number) => {
    const pending = parent.request("browser.probe", {}, budget)
    const { id } = JSON.parse(requestLine.slice(NATIVE_REQUEST_PREFIX.length))
    // Deliver synchronously after advancing the wall clock; no timer has had a turn.
    now = receivedAt
    assert.equal(parent.handleLine(`${NATIVE_RESPONSE_PREFIX}${JSON.stringify({ v: 1, id, ok: true, result: "received" })}`), true)
    return pending
  }
  assert.equal(await send({ deadline: 2_000 }, 1_999), "received")
  await assert.rejects(send({ deadline: 2_000 }, 2_000), /Native request timed out: browser\.probe/)
  assert.equal(await send(1_000, 3_001), "received", "relative budgets still rely on their timer")
})
