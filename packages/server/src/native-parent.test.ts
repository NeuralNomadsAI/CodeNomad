import assert from "node:assert/strict"
import test from "node:test"
import { NativeParent, NATIVE_REQUEST_PREFIX, NATIVE_RESPONSE_PREFIX } from "./native-parent"

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

test("monotonic settlement deadline survives wall-clock jumps and delayed timer callbacks", async t => {
  let now = 10
  const lines: string[] = []
  const parent = new NativeParent({ write(line) { lines.push(String(line)); return true } }, true)
  t.after(() => parent.close())
  t.mock.method(performance, "now", () => now)
  const request = parent.request("projects.attachments.current", {}, 5_000)
  const rejected = assert.rejects(request, /timed out/)
  const envelope = JSON.parse(lines[0]!.slice(NATIVE_REQUEST_PREFIX.length))
  assert.ok(envelope.deadline >= Date.now())
  t.mock.method(Date, "now", () => 0)
  now += 5_000
  parent.handleLine(`${NATIVE_RESPONSE_PREFIX}${JSON.stringify({ v: 1, id: envelope.id, ok: true, result: true })}`)
  await rejected
  assert.equal((parent as any).pending.size, 0)
  const fresh = parent.request("projects.attachments.current", {}, 5_000)
  const next = JSON.parse(lines[1]!.slice(NATIVE_REQUEST_PREFIX.length))
  parent.handleLine(`${NATIVE_RESPONSE_PREFIX}${JSON.stringify({ v: 1, id: envelope.id, ok: true, result: true })}`)
  assert.equal((parent as any).pending.size, 1)
  parent.handleLine(`${NATIVE_RESPONSE_PREFIX}${JSON.stringify({ v: 1, id: next.id, ok: true, result: true })}`)
  assert.equal(await fresh, true)
})

test("direct private responses reject oversize before parsing and ignore expired/replayed IDs", async t => {
  const lines: string[] = []
  const parent = new NativeParent({ write(line) { lines.push(String(line)); return true } }, true)
  t.after(() => parent.close())
  const read = parent.request("projects.attachments.read", {}, 5_000)
  const rejected = assert.rejects(read, /unavailable/)
  const { id } = JSON.parse(lines[0]!.slice(NATIVE_REQUEST_PREFIX.length))
  const wire = `${NATIVE_RESPONSE_PREFIX}${JSON.stringify({ v: 1, id, ok: true, result: "x".repeat(9 * 1024 * 1024) })}`
  const parse = JSON.parse
  let largeParses = 0
  t.mock.method(JSON, "parse", (text: string) => { if (text.length > 8 * 1024 * 1024) largeParses++; return parse(text) })
  parent.handleLine(wire)
  await rejected
  parent.handleLine(wire); parent.handleLine(wire)
  assert.equal(largeParses, 0)
  assert.equal((parent as any).pending.size, 0)
  const fresh = parent.request("projects.attachments.current", {})
  const next = JSON.parse(lines[1]!.slice(NATIVE_REQUEST_PREFIX.length))
  parent.handleLine(`${NATIVE_RESPONSE_PREFIX}${JSON.stringify({ v: 1, id: next.id, ok: true, result: true })}`)
  assert.equal(await fresh, true)
})

test("response identity/protocol are checked again after parsing and parsing cannot cross the deadline", async t => {
  const lines: string[] = []
  const parent = new NativeParent({ write(line) { lines.push(String(line)); return true } }, true)
  t.after(() => parent.close())
  let now = 0
  t.mock.method(performance, "now", () => now)
  const request = parent.request("projects.attachments.current", {}, 5_000)
  const rejected = assert.rejects(request, /timed out/)
  const { id } = JSON.parse(lines[0]!.slice(NATIVE_REQUEST_PREFIX.length))
  for (const extra of ['"id":"forged"', '"v":2']) {
    parent.handleLine(`${NATIVE_RESPONSE_PREFIX}{"v":1,"id":"${id}","ok":true,"result":true,${extra}}`)
    assert.equal((parent as any).pending.size, 1)
  }
  const parse = JSON.parse
  const spy = t.mock.method(JSON, "parse", (text: string) => { const value = parse(text); now = 5_000; return value })
  parent.handleLine(`${NATIVE_RESPONSE_PREFIX}{"v":1,"id":"${id}","ok":true,"result":true}`)
  await rejected
  spy.mock.restore()
  assert.equal((parent as any).pending.size, 0)
  const fresh = parent.request("projects.attachments.current", {})
  const next = JSON.parse(lines[1]!.slice(NATIVE_REQUEST_PREFIX.length))
  parent.handleLine(`${NATIVE_RESPONSE_PREFIX}{"v":1,"id":"${next.id}","ok":true,"result":true}`)
  assert.equal(await fresh, true)
})

test("32 pending owners, ordinary errors and shutdown retain their existing contracts and release timers", async () => {
  const lines: string[] = []
  const parent = new NativeParent({ write(line) { lines.push(String(line)); return true } }, true)
  const ordinary = parent.request("opencode.service.start", {})
  const failure = assert.rejects(ordinary, /owned native failure/)
  const { id } = JSON.parse(lines[0]!.slice(NATIVE_REQUEST_PREFIX.length))
  parent.handleLine(`${NATIVE_RESPONSE_PREFIX}${JSON.stringify({ v: 1, id, ok: false, error: { code: "native_error", message: "owned native failure" } })}`)
  await failure
  assert.equal((parent as any).pending.size, 0)
  const requests = Array.from({ length: 32 }, () => parent.request("developer.status", {}).catch(error => error))
  await assert.rejects(parent.request("developer.status", {}), /Too many pending/)
  assert.equal((parent as any).pending.size, 32)
  parent.close()
  assert.equal((parent as any).pending.size, 0)
  for (const result of await Promise.all(requests)) {
    assert.ok(result instanceof Error)
    assert.match(result.message, /shutting down/)
  }
  await assert.rejects(parent.request("developer.status", {}), /shutting down/)
})
