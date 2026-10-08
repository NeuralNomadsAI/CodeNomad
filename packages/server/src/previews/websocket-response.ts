import { createHash } from "node:crypto"
import { Transform, type TransformCallback } from "node:stream"

const MAX_HEADER_BYTES = 16 * 1024
const HANDSHAKE_TIMEOUT_MS = 10_000
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/

/** The HTTP response is untrusted even when its TLS certificate is valid.
 * Admit one bounded 101 response, then stream frames without interpreting them.
 * The accepted event opens the client-to-upstream half of the tunnel.
 */
export class PreviewWebSocketResponse extends Transform {
  private header = Buffer.alloc(0)
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly expectedAccept: string | undefined
  admitted = false

  constructor(requestKey: string | string[] | undefined, private readonly limits = {
    maxHeaderBytes: MAX_HEADER_BYTES,
    timeoutMs: HANDSHAKE_TIMEOUT_MS,
  }) {
    super()
    this.expectedAccept = typeof requestKey === "string"
      ? createHash("sha1").update(`${requestKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
      : undefined
    this.timer = setTimeout(() => this.destroy(new Error("Preview WebSocket handshake timed out")), limits.timeoutMs)
    this.timer.unref()
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    if (this.admitted) {
      callback(null, chunk)
      return
    }
    const previousLength = this.header.length
    const candidate = Buffer.concat([this.header, chunk.subarray(0, this.limits.maxHeaderBytes - previousLength)])
    const end = candidate.indexOf("\r\n\r\n")
    if (end < 0) {
      this.header = candidate
      callback(candidate.length >= this.limits.maxHeaderBytes ? new Error("Preview WebSocket response headers too large") : undefined)
      return
    }
    try {
      const safeHeaders = this.admit(candidate.subarray(0, end + 4))
      this.header = Buffer.alloc(0)
      this.admitted = true
      clearTimeout(this.timer)
      this.push(safeHeaders)
      // Do not lose frames coalesced with the final fragment of the headers.
      const remainder = chunk.subarray(end + 4 - previousLength)
      if (remainder.length) this.push(remainder)
      this.emit("accepted")
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  private admit(header: Buffer): Buffer {
    const [status, ...lines] = header.toString("latin1").slice(0, -4).split("\r\n")
    if (!/^HTTP\/1\.1 101(?: [\x20-\x7e]*)?$/.test(status)) throw new Error("Preview WebSocket upstream did not switch protocols")
    const fields = new Map<string, string[]>()
    const safe = [status]
    for (const line of lines) {
      const colon = line.indexOf(":")
      const name = line.slice(0, colon)
      const value = line.slice(colon + 1)
      if (colon <= 0 || !HEADER_NAME.test(name) || !HEADER_VALUE.test(value)) throw new Error("Malformed preview WebSocket response header")
      const lower = name.toLowerCase()
      const values = fields.get(lower) ?? []
      values.push(value.trim())
      fields.set(lower, values)
      if (lower !== "set-cookie" && lower !== "set-cookie2") safe.push(line)
    }
    const tokens = (name: string) => fields.get(name)?.join(",").toLowerCase().split(",").map((value) => value.trim()) ?? []
    const accept = fields.get("sec-websocket-accept")
    if (!tokens("upgrade").includes("websocket") || !tokens("connection").includes("upgrade")
      || !this.expectedAccept || accept?.length !== 1 || accept[0] !== this.expectedAccept) {
      throw new Error("Invalid preview WebSocket upgrade response")
    }
    return Buffer.from(`${safe.join("\r\n")}\r\n\r\n`, "latin1")
  }

  override _flush(callback: TransformCallback) {
    callback(this.admitted ? undefined : new Error("Incomplete preview WebSocket upgrade response"))
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    clearTimeout(this.timer)
    this.header = Buffer.alloc(0)
    callback(error)
  }
}
