import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { Readable, Writable } from "node:stream"
import { finished, pipeline } from "node:stream/promises"
import { it } from "node:test"
import { PreviewWebSocketResponse } from "./websocket-response"

const key = "dGhlIHNhbXBsZSBub25jZQ=="
const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
const header = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n`
const limits = { maxHeaderBytes: 16 * 1024, timeoutMs: 1000 }

async function collect(chunks: Buffer[], options = limits, requestKey: string | undefined = key) {
  const response = new PreviewWebSocketResponse(requestKey, options)
  const output: Buffer[] = []
  response.on("data", (chunk: Buffer) => output.push(chunk))
  const completion = finished(response)
  for (const chunk of chunks) response.write(chunk)
  response.end()
  await completion
  return Buffer.concat(output)
}

it("admits fragmented upgrade headers, strips every cookie copy and preserves negotiation headers and coalesced frames", async () => {
  const raw = `${header}Set-Cookie: codenomad_session=bad; HttpOnly; Path=/\r\nsEt-CoOkIe: another=bad\r\nSET-COOKIE2: legacy=bad\r\nSec-WebSocket-Protocol: fixture\r\nSec-WebSocket-Extensions: permessage-deflate\r\nX-Harmless: preserved\r\n\r\n`
  const frames = Buffer.from([0x81, 2, 0x68, 0x69, 0x88, 0])
  const chunks = [...Buffer.from(raw).subarray(0, -1)].map((byte) => Buffer.from([byte]))
  chunks.push(Buffer.concat([Buffer.from("\n"), frames]))
  const result = await collect(chunks)
  const split = result.indexOf("\r\n\r\n") + 4
  assert.doesNotMatch(result.subarray(0, split).toString(), /set-cookie/i)
  assert.match(result.toString(), /Sec-WebSocket-Protocol: fixture/)
  assert.match(result.toString(), /Sec-WebSocket-Extensions: permessage-deflate/)
  assert.match(result.toString(), /X-Harmless: preserved/)
  assert.deepEqual(result.subarray(split), frames)
})

it("rejects non-101, malformed, folded and invalid/duplicate acceptance headers before emitting anything", async () => {
  const invalid = [
    "HTTP/1.1 302 Found\r\nLocation: http://untrusted.invalid/\r\nSet-Cookie: auth=bad\r\n\r\n",
    "HTTP/1.1 200 OK\r\n\r\n",
    `${header} broken-fold: value\r\n\r\n`,
    `${header}Bad Name: value\r\n\r\n`,
    `${header}missing-colon\r\n\r\n`,
    `${header}X-Control: bad\u0000value\r\n\r\n`,
    `${header}X-LF: bad\nSet-Cookie: auth=bad\r\n\r\n`,
    `${header}Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    `${header.replace(accept, "wrong")}\r\n`,
    `${header.replace("Upgrade: websocket", "Upgrade: not-websocket")}\r\n`,
    `${header.replace("Connection: keep-alive, Upgrade", "Connection: close")}\r\n`,
    `${header.replace("HTTP/1.1", "HTTP/1.0")}\r\n`,
  ]
  for (const source of invalid) {
    const response = new PreviewWebSocketResponse(key, limits)
    let leaked = false
    response.on("data", () => { leaked = true })
    const completion = finished(response)
    response.end(Buffer.from(source))
    await assert.rejects(completion)
    assert.equal(leaked, false)
    assert.equal(response.admitted, false)
  }
})

it("bounds only the response header, not legitimate frames arriving in the same chunk", async () => {
  const valid = Buffer.from(`${header}\r\n`)
  const frames = Buffer.alloc(100_000, 0xab)
  const result = await collect([Buffer.concat([valid, frames])], { maxHeaderBytes: valid.length, timeoutMs: 1000 })
  assert.deepEqual(result.subarray(valid.length), frames)
  const fragmented = await collect([valid.subarray(0, -2), Buffer.concat([valid.subarray(-2), frames])], { maxHeaderBytes: valid.length, timeoutMs: 1000 })
  assert.deepEqual(fragmented, Buffer.concat([valid, frames]))
  await assert.rejects(collect([valid], { maxHeaderBytes: valid.length - 1, timeoutMs: 1000 }), /too large/)
  await assert.rejects(collect([Buffer.from(`${header}X-Large: ${"x".repeat(17_000)}`)]), /too large/)
})

it("fails closed on EOF, missing request identity, handshake deadline and cancellation", async () => {
  await assert.rejects(collect([Buffer.from(header)]), /Incomplete/)
  const missingKey = new PreviewWebSocketResponse(undefined, limits)
  const missingCompletion = finished(missingKey)
  missingKey.end(Buffer.from(`${header}\r\n`))
  await assert.rejects(missingCompletion, /Invalid/)
  const stalled = new PreviewWebSocketResponse(key, { maxHeaderBytes: 1000, timeoutMs: 25 })
  const stalledError = once(stalled, "error")
  // Keep the unit fixture alive while the production deadline is unreferenced.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    assert.match(String((await stalledError)[0]), /timed out/)
    assert.equal(stalled.destroyed, true)
  } finally { clearInterval(keepAlive) }
  const cancelled = new PreviewWebSocketResponse(key, { maxHeaderBytes: 1000, timeoutMs: 25 })
  let error = false
  cancelled.on("error", () => { error = true })
  const close = once(cancelled, "close")
  cancelled.destroy()
  await close
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(error, false, "cancellation must clear the handshake deadline")
})

it("retains streaming backpressure and drains every frame before a graceful EOF", async () => {
  const valid = Buffer.from(`${header}\r\n`)
  const frames = Array.from({ length: 64 }, (_, index) => Buffer.alloc(32_768, index))
  const response = new PreviewWebSocketResponse(key, limits)
  const source = Readable.from([valid, ...frames], { objectMode: false, highWaterMark: 16_384 })
  const output: Buffer[] = []
  let release!: () => void
  let markBlocked!: () => void
  const blocked = new Promise<void>((resolve) => { markBlocked = resolve })
  let first = true
  const sink = new Writable({ highWaterMark: 16_384, write(chunk: Buffer, _encoding, done) {
    output.push(chunk)
    if (first) {
      first = false
      release = done
      markBlocked()
    } else setImmediate(done)
  } })
  const completion = pipeline(source, response, sink)
  await blocked
  assert.equal(source.readableEnded, false, "a blocked recipient must stop upstream consumption")
  assert.ok(output.length < frames.length)
  release()
  await completion
  assert.deepEqual(Buffer.concat(output), Buffer.concat([valid, ...frames]))
})
