import assert from "node:assert/strict"
import test from "node:test"
import { PassThrough } from "node:stream"
import { installShutdownStdinHandler, STDIN_SHUTDOWN_COMMAND } from "./shutdown"
import { NativeParent, NATIVE_REQUEST_PREFIX, NATIVE_RESPONSE_PREFIX } from "./native-parent"
import { MAX_ATTACHMENT_RESPONSE_BYTES, nativeResponseLimit, nativeStdinFramer } from "./native-response"

function fixture(t: test.TestContext) {
  const requests: Array<{ id: string; method: string; deadline: number }> = []
  const parent = new NativeParent({ write(line) { requests.push(JSON.parse(String(line).slice(NATIVE_REQUEST_PREFIX.length))); return true } }, true)
  const stdin = new PassThrough()
  const lines: number[] = [], shutdowns: string[] = []
  installShutdownStdinHandler(stdin, async trigger => { shutdowns.push(trigger) }, line => {
    lines.push(Buffer.byteLength(line))
    return parent.handleLine(line)
  }, id => parent.rejectResponse(id))
  t.after(() => { parent.close(); stdin.destroy() })
  const answer = (id: string, result: unknown) => `${NATIVE_RESPONSE_PREFIX}${JSON.stringify({ v: 1, id, ok: true, result })}`
  return { parent, stdin, requests, lines, shutdowns, answer }
}

test("private stdin refuses huge chunks before full retain/decode/parse, drains and handles fresh response plus shutdown", async t => {
  const f = fixture(t)
  const read = f.parent.request("projects.attachments.read", {}, 5_000)
  const rejected = assert.rejects(read, /unavailable/)
  const id = f.requests[0]!.id
  const wire = Buffer.from(f.answer(id, "x".repeat(9 * 1024 * 1024)))
  const parse = JSON.parse, concat = Buffer.concat, toString = Buffer.prototype.toString
  const parsed: number[] = [], concats: number[] = [], decoded: number[] = []
  t.mock.method(JSON, "parse", (text: string) => { parsed.push(Buffer.byteLength(text)); return parse(text) })
  t.mock.method(Buffer, "concat", (list: readonly Uint8Array[], length?: number) => {
    concats.push(length ?? list.reduce((n, b) => n + b.length, 0))
    return concat(list, length)
  })
  t.mock.method(Buffer.prototype, "toString", function (this: Buffer, ...args: Parameters<Buffer["toString"]>) {
    decoded.push(this.length)
    return toString.apply(this, args)
  })
  f.stdin.write(wire) // no delimiter: overflow releases the matching pending owner now
  await rejected
  assert.equal((f.parent as any).pending.size, 0)
  assert.deepEqual(f.lines, [])
  assert.deepEqual(parsed, [])
  assert.deepEqual(concats, [])
  assert.ok(decoded.every(size => size <= 256))
  const fresh = f.parent.request("projects.attachments.current", {}, 5_000)
  f.stdin.write(Buffer.from(`\n${f.answer(f.requests[1]!.id, true)}\r\n${STDIN_SHUTDOWN_COMMAND}\n`))
  assert.equal(await fresh, true)
  assert.deepEqual(f.shutdowns, ["stdin"])
  assert.equal((f.parent as any).pending.size, 0)
  assert.ok(concats.every(size => size <= nativeResponseLimit(id)))
})

test("chunked private wire keeps byte limits, UTF-8 and CRLF; expired and replayed oversized IDs stay unparsed", async t => {
  const f = fixture(t)
  const read = f.parent.request("projects.attachments.read", {})
  const wire = Buffer.from(f.answer(f.requests[0]!.id, "é🙂\r\nété") + "\r\n")
  for (let i = 0; i < wire.length; i++) f.stdin.write(wire.subarray(i, i + 1))
  assert.equal(await read, "é🙂\r\nété")
  const expired = f.parent.request("projects.attachments.current", {}, 5)
  const id = f.requests[1]!.id
  await assert.rejects(expired, /timed out/)
  const parse = JSON.parse
  let parses = 0
  t.mock.method(JSON, "parse", (text: string) => { parses++; return parse(text) })
  const huge = Buffer.from(f.answer(id, "x".repeat(9 * 1024 * 1024)) + "\n")
  for (let replay = 0; replay < 2; replay++) {
    f.stdin.write(huge.subarray(0, 180))
    f.stdin.write(huge.subarray(180, MAX_ATTACHMENT_RESPONSE_BYTES))
    f.stdin.write(huge.subarray(MAX_ATTACHMENT_RESPONSE_BYTES))
  }
  assert.equal(parses, 0)
  assert.equal((f.parent as any).pending.size, 0)
  const fresh = f.parent.request("projects.attachments.current", {})
  f.stdin.write(f.answer(f.requests[2]!.id, true) + "\n")
  assert.equal(await fresh, true)
})

test("exact eight-MiB result plus canonical envelope is accepted; +1 is refused before parse and fresh next line works", async t => {
  const f = fixture(t)
  const exact = "x".repeat(MAX_ATTACHMENT_RESPONSE_BYTES - 2) // JSON quotes belong to result bytes
  const first = f.parent.request("projects.attachments.read", {})
  const wire = f.answer(f.requests[0]!.id, exact)
  assert.equal(Buffer.byteLength(wire), nativeResponseLimit(f.requests[0]!.id))
  // CR and LF may arrive separately, including at the exact allowance.
  f.stdin.write(Buffer.from(wire + "\r")); f.stdin.write(Buffer.from("\n"))
  assert.equal(await first, exact)
  const oversized = f.parent.request("projects.attachments.read", {})
  const rejected = assert.rejects(oversized, /unavailable/)
  const tooLarge = Buffer.from(f.answer(f.requests[1]!.id, exact + "x") + "\n")
  const parse = JSON.parse
  let largeParses = 0
  t.mock.method(JSON, "parse", (text: string) => { if (text.length > MAX_ATTACHMENT_RESPONSE_BYTES) largeParses++; return parse(text) })
  f.stdin.write(tooLarge)
  await rejected
  assert.equal(largeParses, 0)
  const fresh = f.parent.request("projects.attachments.current", {})
  f.stdin.write(f.answer(f.requests[2]!.id, true) + "\n")
  assert.equal(await fresh, true)
})

test("ordinary browser/service/auth/developer method responses retain their existing contract", async t => {
  const f = fixture(t)
  const large = "x".repeat(9 * 1024 * 1024)
  const screenshot = f.parent.request<{ image: { mime: string; data: string }; url: string }>("browser.execute", { sessionID: "owned", command: { action: "screenshot" } })
  assert.doesNotMatch(f.requests[0]!.id, /^attachments-/)
  f.stdin.write(f.answer(f.requests[0]!.id, { image: { mime: "image/png", data: large }, url: "https://fixture.invalid/" }) + "\n")
  assert.equal((await screenshot).image.data, large)
  for (const method of ["opencode.service.start", "developer.status", "browser.execute"]) {
    const request = f.parent.request(method, {})
    f.stdin.write(f.answer(f.requests.at(-1)!.id, { stdout: "ok", stderr: "" }) + "\n")
    assert.deepEqual(await request, { stdout: "ok", stderr: "" })
  }
})

test("multi-block tiny chunks retain bounded slab metadata; string adapters encode in bounded pieces", t => {
  const id = "attachments-00000000-0000-4000-8000-000000000000"
  const lines: string[] = [], overflows: string[] = []
  const frame = nativeStdinFramer(line => lines.push(line), value => overflows.push(value))
  const exact = `${NATIVE_RESPONSE_PREFIX}${JSON.stringify({ v: 1, id, ok: true, result: "é".repeat(70_000) })}`
  const wire = Buffer.from(exact + "\n")
  const alloc = Buffer.allocUnsafe
  const blocks: number[] = []
  const spy = t.mock.method(Buffer, "allocUnsafe", (size: number) => { blocks.push(size); return alloc(size) })
  const one = Buffer.alloc(1)
  for (const byte of wire) { one[0] = byte; frame(one) }
  assert.deepEqual(lines, [exact])
  assert.ok(blocks.length <= Math.ceil(wire.length / (64 * 1024)) + 1)
  assert.ok(blocks.every(size => size <= 64 * 1024 || size === wire.length - 1))
  spy.mock.restore()
  const huge = `${NATIVE_RESPONSE_PREFIX}${JSON.stringify({ v: 1, id, ok: true, result: "x".repeat(9 * 1024 * 1024) })}`
  const from = Buffer.from
  let maximumString = 0
  t.mock.method(Buffer, "from", (value: any, ...args: any[]) => {
    if (typeof value === "string") maximumString = Math.max(maximumString, value.length)
    return (from as any)(value, ...args)
  })
  frame(huge)
  assert.deepEqual(overflows, [id])
  assert.ok(maximumString <= 16 * 1024)
  frame("\n🙂".slice(0, 2)) // newline, then a high surrogate held for the next string
  frame("🙂\n".slice(1))
  assert.equal(lines.at(-1), "🙂")
})
