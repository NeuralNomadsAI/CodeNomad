import assert from "node:assert/strict"
import test from "node:test"
import { NativeParent, NATIVE_REQUEST_PREFIX, NATIVE_RESPONSE_PREFIX } from "./native-parent"

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
  await assert.rejects(parent.request("browser.probe", {}), /Native control is unavailable/)
})

test("matches native responses to requests and rejects pending work on shutdown", async () => {
  const lines: string[] = []
  const parent = new NativeParent({ write: (line: string | Uint8Array) => { lines.push(String(line)); return true } }, true)

  const request = parent.request<{ available: boolean }>("developer.status", {})
  const envelope = JSON.parse(lines[0].slice(NATIVE_REQUEST_PREFIX.length)) as { id: string; deadline: number }
  assert.ok(envelope.deadline > Date.now())
  assert.equal(parent.handleLine(`${NATIVE_RESPONSE_PREFIX}${JSON.stringify({ v: 1, id: envelope.id, ok: true, result: { available: true } })}`), true)
  assert.deepEqual(await request, { available: true })

  const pending = parent.request("developer.status", {})
  parent.close()
  await assert.rejects(pending, /shutting down/)
})

test("late native replies cannot settle a subsequent request", async () => {
  const lines: string[] = []
  const parent = new NativeParent({ write: line => { lines.push(String(line)); return true } }, true)
  const first = parent.request("browser.probe", {}, 5)
  const old = JSON.parse(lines[0].slice(NATIVE_REQUEST_PREFIX.length))
  await assert.rejects(first, /timed out/)
  const second = parent.request("browser.probe", {}, 1000)
  const current = JSON.parse(lines[1].slice(NATIVE_REQUEST_PREFIX.length))
  parent.handleLine(`${NATIVE_RESPONSE_PREFIX}${JSON.stringify({ v: 1, id: old.id, ok: true, result: "stale" })}`)
  parent.handleLine(`${NATIVE_RESPONSE_PREFIX}${JSON.stringify({ v: 1, id: current.id, ok: true, result: "current" })}`)
  assert.equal(await second, "current")
  parent.close()
})
