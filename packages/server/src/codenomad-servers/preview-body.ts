import { isUtf8 } from "node:buffer"
import { addAbortSignal, pipeline, Readable } from "node:stream"
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib"

// JavaScript MIME type essences from the WHATWG MIME Sniffing standard.
const javascriptMimeTypes = new Set([
  "application/ecmascript", "application/javascript", "application/x-ecmascript", "application/x-javascript",
  "text/ecmascript", "text/javascript", "text/javascript1.0", "text/javascript1.1", "text/javascript1.2",
  "text/javascript1.3", "text/javascript1.4", "text/javascript1.5", "text/jscript", "text/livescript",
  "text/x-ecmascript", "text/x-javascript",
])

export function previewBodyKind(contentType: string) {
  const mime = contentType.split(";", 1)[0]!.trim().toLowerCase()
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html"
  if (mime === "text/css") return "css"
  if (javascriptMimeTypes.has(mime)) return "js"
  return null
}

function previewCharset(body: Buffer, type: string) {
  const value = /;\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(type)
  const charset = (value?.[1] ?? value?.[2])?.toLowerCase()
  // Reject UTF-32 before interpreting its little-endian marker as UTF-16.
  if (body.length >= 4 && [0x0000feff, 0xfffe0000].includes(body.readUInt32BE(0))) {
    throw new Error("Unsupported preview charset")
  }
  if (charset !== undefined && !/^(?:utf-?8|utf-16(?:le|be)?|windows-1252|iso-8859-1|latin1|us-ascii)$/.test(charset)) {
    throw new Error("Unsupported preview charset")
  }
  const bom = body.length >= 2 ? body.readUInt16BE(0) : 0
  if (bom === 0xfeff) return "utf-16be"
  if (bom === 0xfffe) return "utf-16le"
  if (body.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return "utf-8"
  if (charset === "utf-16be") return "utf-16be"
  if (charset === "utf-16le" || charset === "utf-16") return "utf-16le"
  if (charset === "utf8" || charset === "utf-8" || (charset === undefined && isUtf8(body))) return "utf-8"
  // Round-trip ASCII-compatible legacy data byte-for-byte without interpreting
  // its non-ASCII characters (including pages declaring their charset in-band).
  return "latin1"
}

function encodePreviewText(value: string, charset: ReturnType<typeof previewCharset>) {
  const bytes = Buffer.from(value, charset === "utf-8" ? "utf8" : charset === "latin1" ? "latin1" : "utf16le")
  return charset === "utf-16be" ? bytes.swap16() : bytes
}

export function rewritePreviewText(body: Buffer, type: string, rewrite: (text: string, maxUnits: number) => string, maxBytes: number) {
  const charset = previewCharset(body, type)
  const wide = charset.startsWith("utf-16")
  const text = charset === "latin1" ? body.toString("latin1")
    : new TextDecoder(charset, { fatal: true, ignoreBOM: true }).decode(body)
  const rewritten = rewrite(text, wide ? Math.floor(maxBytes / 2) : maxBytes)
  if (charset === "latin1" && /[^\u0000-\u00ff]/.test(rewritten)) throw new Error("Unrepresentable preview text")
  const size = Buffer.byteLength(rewritten, wide ? "utf16le" : charset === "latin1" ? "latin1" : "utf8")
  if (size > maxBytes) throw new Error("Preview document too large")
  return encodePreviewText(rewritten, charset)
}

export function previewDocumentStream(upstream: Readable, contentEncoding: string) {
  switch (contentEncoding.trim().toLowerCase()) {
    case "":
    case "identity": return upstream
    case "gzip":
    case "x-gzip": return pipeline(upstream, createGunzip(), () => {})
    case "deflate": return pipeline(upstream, createInflate(), () => {})
    case "br": return pipeline(upstream, createBrotliDecompress(), () => {})
    default: throw new Error("Unsupported preview content encoding")
  }
}

/** Equal-size UUID prefixes let us edit only the matching bytes, including in legacy text. */
export function replacePreviewPrefix(body: Buffer, from: string, to: string, type: string) {
  const charset = previewCharset(body, type)
  const wide = charset.startsWith("utf-16")
  const encode = (value: string) => encodePreviewText(value, charset)
  const oldBytes = encode(from), newBytes = encode(to)
  if (oldBytes.length !== newBytes.length || oldBytes.length === 0) throw new Error("Invalid preview prefixes")
  for (let start = 0; ; ) {
    const match = body.indexOf(oldBytes, start)
    if (match === -1) break
    if (wide && match % 2) { start = match + 1; continue }
    newBytes.copy(body, match)
    start = match + oldBytes.length
  }
  return body
}

/** Queue paused inputs without rewrite buffers; reserve through downstream completion. */
export class PreviewBodyBudget {
  #active = 0
  #waiting = new Set<() => void>()

  constructor(private readonly slots = 4, readonly bytes = 16 * 1024 * 1024,
    private readonly durationMs = 15_000, private readonly maxWaiting = 32) {}

  async #acquire(signal: AbortSignal) {
    signal.throwIfAborted()
    if (this.#active < this.slots) {
      this.#active++
      return
    }
    if (this.#waiting.size >= this.maxWaiting) throw new Error("Preview rewrite capacity reached")
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        this.#waiting.delete(grant)
        signal.removeEventListener("abort", cancel)
        resolve()
      }
      const cancel = () => {
        this.#waiting.delete(grant)
        reject(signal.reason)
      }
      this.#waiting.add(grant)
      signal.addEventListener("abort", cancel, { once: true })
    })
  }

  #release() {
    const next = this.#waiting.values().next().value
    if (next) next()
    else this.#active--
  }

  async run(body: (() => Readable) | NonNullable<Response["body"]>, parent: AbortSignal,
    send: (body: Buffer, signal: AbortSignal) => Promise<void>): Promise<void> {
    parent.throwIfAborted()
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), this.durationMs)
    timer.unref()
    const signal = AbortSignal.any([parent, deadline.signal])
    let acquired = false
    try {
      await this.#acquire(signal)
      acquired = true
      signal.throwIfAborted()
      const buffer = Buffer.allocUnsafe(this.bytes)
      let size = 0
      for await (const chunk of addAbortSignal(signal, typeof body === "function" ? body() : Readable.fromWeb(body as never))) {
        if (size + chunk.length > buffer.length) throw new Error("Preview document too large")
        size += chunk.copy(buffer, size)
      }
      signal.throwIfAborted()
      await send(buffer.subarray(0, size), signal)
    } finally {
      clearTimeout(timer)
      if (acquired) this.#release()
    }
  }
}
