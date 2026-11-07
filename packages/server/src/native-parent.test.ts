import assert from "node:assert/strict"
import test from "node:test"
import { NativeParent, NATIVE_REQUEST_PREFIX, NATIVE_RESPONSE_PREFIX } from "./native-parent"

test("WebKit browser refusal is independent of the native transport", async () => {
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
