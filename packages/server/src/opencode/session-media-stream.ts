import { Readable } from "node:stream"
import { INLINE_MEDIA_LIMIT, deferToolMedia } from "./session-media"

/** Matches session-media-fetch.ts and server-rs/src/sessions/media.rs per-message cap. */
export const MAX_STREAMED_MESSAGE_BYTES = 16 * 1024 * 1024
const SLAB_BYTES = 64 * 1024
const utf8Fatal = new TextDecoder("utf-8", { fatal: true })

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}

/** Fixed-slab element buffer: at most `ceil(limit / 64 KiB)` Buffers even for 1-byte chunks. */
class SlabBuffer {
  private slabs: Buffer[] = []
  private current: Buffer | null = null
  private used = 0
  bytes = 0

  constructor(private readonly limit: number) {}

  tryAppend(chunk: Uint8Array, start: number, end: number): boolean {
    const len = end - start
    if (len <= 0) return true
    if (this.bytes + len > this.limit) return false
    let offset = start
    while (offset < end) {
      if (!this.current || this.used === this.current.byteLength) {
        if (this.current) this.slabs.push(this.current)
        const remaining = this.limit - this.bytes
        this.current = Buffer.allocUnsafe(Math.min(SLAB_BYTES, remaining))
        this.used = 0
      }
      const copyLen = Math.min(end - offset, this.current.byteLength - this.used)
      this.current.set(chunk.subarray(offset, offset + copyLen), this.used)
      this.used += copyLen
      this.bytes += copyLen
      offset += copyLen
    }
    return true
  }

  drainTo(emit: (chunk: Buffer) => void): void {
    for (const slab of this.slabs) emit(slab)
    if (this.current && this.used > 0) emit(this.current.subarray(0, this.used))
    this.reset()
  }

  takeBuffer(): Buffer {
    if (this.slabs.length === 0) {
      const out = this.current ? this.current.subarray(0, this.used) : Buffer.alloc(0)
      this.reset()
      return out
    }
    const parts = this.current && this.used > 0
      ? [...this.slabs, this.current.subarray(0, this.used)]
      : this.slabs
    const out = Buffer.concat(parts, this.bytes)
    this.reset()
    return out
  }

  reset(): void {
    this.slabs = []
    this.current = null
    this.used = 0
    this.bytes = 0
  }
}

function projectElement(raw: Buffer, scope: { workspaceId: string; sessionId: string }): Buffer {
  if (raw.byteLength <= INLINE_MEDIA_LIMIT) return raw
  try {
    const parsed: unknown = JSON.parse(utf8Fatal.decode(raw))
    if (deferToolMedia([parsed], scope)) {
      return Buffer.from(JSON.stringify(parsed), "utf8")
    }
  } catch {
    // Preserve invalid UTF-8 or malformed JSON verbatim.
  }
  return raw
}

/**
 * Streams a native `GET /api/session/:id/message` JSON envelope (`{"data":[...]}`)
 * while projecting each individual message object through `deferToolMedia` as soon
 * as it closes. Peak server memory stays bounded by one message (`maxElementBytes`)
 * packed into 64 KiB slabs, and `destroy()` immediately cancels a stalled upstream read.
 */
export function deferToolMediaStream(
  source: ReadableStream<Uint8Array>,
  scope: { workspaceId: string; sessionId: string },
  maxElementBytes = MAX_STREAMED_MESSAGE_BYTES,
): Readable {
  const reader = source.getReader()
  const elem = new SlabBuffer(maxElementBytes)
  let finished = false
  let destroyed = false
  let pumping = false
  let passthrough = false
  let started = false
  let depth = 0
  let inString = false
  let escape = false

  // Top-level object (`depth === 1`) state to recognize `"data": [`.
  let topExpect: "key" | "colon" | "value" | "comma" = "key"
  let readingTopKey = false
  let topKeyBytes: number[] = []
  let topKeyOverflow = false
  let matchedDataKey = false
  let inDataArray = false

  // Single message object capture inside `"data": [...]` (`depth >= 3`).
  let capturing = false
  let elemOverflowed = false

  const releaseReader = () => {
    try { reader.releaseLock() } catch { /* already released */ }
  }

  const processChunk = (value: Uint8Array, emit: (chunk: Uint8Array) => void) => {
    if (value.byteLength === 0) return
    if (passthrough) {
      emit(value)
      return
    }

    let rawStart = 0
    let elemStart = 0

    for (let i = 0; i < value.byteLength; i++) {
      const byte = value[i]!

      if (!started) {
        if (isWhitespace(byte)) continue
        started = true
        if (byte !== 0x7b) {
          passthrough = true
          break
        }
        depth = 1
        topExpect = "key"
        continue
      }

      if (inString) {
        if (escape) {
          escape = false
          if (readingTopKey && !topKeyOverflow) {
            if (topKeyBytes.length < 32) topKeyBytes.push(0x5c, byte)
            else topKeyOverflow = true
          }
          continue
        }
        if (byte === 0x5c) {
          escape = true
          continue
        }
        if (byte === 0x22) {
          inString = false
          if (readingTopKey) {
            readingTopKey = false
            matchedDataKey = false
            if (!topKeyOverflow) {
              try {
                const key = JSON.parse(`"${Buffer.from(topKeyBytes).toString("utf8")}"`)
                matchedDataKey = key === "data"
              } catch {
                matchedDataKey = false
              }
            }
            topKeyBytes = []
            topKeyOverflow = false
            topExpect = "colon"
          }
          continue
        }
        if (readingTopKey && !topKeyOverflow) {
          if (topKeyBytes.length < 32) topKeyBytes.push(byte)
          else topKeyOverflow = true
        }
        continue
      }

      if (byte === 0x22) {
        inString = true
        if (depth === 1 && topExpect === "key") {
          readingTopKey = true
          topKeyBytes = []
          topKeyOverflow = false
        } else if (depth === 1 && topExpect === "value") {
          matchedDataKey = false
          topExpect = "comma"
        }
        continue
      }

      if (capturing) {
        if (byte === 0x7b || byte === 0x5b) {
          depth++
        } else if (byte === 0x7d || byte === 0x5d) {
          depth--
          if (depth === 2) {
            if (!elemOverflowed) {
              if (elem.tryAppend(value, elemStart, i + 1)) {
                emit(projectElement(elem.takeBuffer(), scope))
              } else {
                elem.drainTo(emit)
                emit(value.subarray(elemStart, i + 1))
              }
            } else {
              emit(value.subarray(rawStart, i + 1))
            }
            capturing = false
            elemOverflowed = false
            rawStart = i + 1
          }
        }
        continue
      }

      if (inDataArray && depth === 2) {
        if (byte === 0x7b) {
          if (i > rawStart) emit(value.subarray(rawStart, i))
          capturing = true
          elemOverflowed = false
          elem.reset()
          elemStart = i
          depth = 3
        } else if (byte === 0x5d) {
          inDataArray = false
          depth = 1
          topExpect = "comma"
        } else if (byte === 0x5b) {
          depth = 3
        }
        continue
      }

      if (depth === 1) {
        if (isWhitespace(byte)) continue
        if (byte === 0x3a && topExpect === "colon") {
          topExpect = "value"
        } else if (byte === 0x2c) {
          matchedDataKey = false
          topExpect = "key"
        } else if (byte === 0x5b) {
          depth = 2
          if (topExpect === "value" && matchedDataKey) {
            inDataArray = true
            matchedDataKey = false
          }
          topExpect = "comma"
        } else if (byte === 0x7b) {
          depth = 2
          matchedDataKey = false
          topExpect = "comma"
        } else if (byte === 0x7d) {
          depth = 0
          passthrough = true
          break
        } else if (topExpect === "value") {
          matchedDataKey = false
          topExpect = "comma"
        }
        continue
      }

      if (byte === 0x7b || byte === 0x5b) {
        depth++
      } else if (byte === 0x7d || byte === 0x5d) {
        depth = Math.max(0, depth - 1)
      }
    }

    if (capturing && !elemOverflowed) {
      if (!elem.tryAppend(value, elemStart, value.byteLength)) {
        elem.drainTo(emit)
        emit(value.subarray(elemStart))
        elemOverflowed = true
      }
    } else if (rawStart < value.byteLength) {
      emit(value.subarray(rawStart))
    }
  }

  const out = new Readable({
    read() {
      if (pumping || destroyed || finished) return
      pumping = true
      void (async () => {
        try {
          let wantMore = true
          while (wantMore && !destroyed && !finished) {
            const { done, value } = await reader.read()
            if (destroyed) return
            if (done) {
              finished = true
              if (capturing && !elemOverflowed && elem.bytes > 0) {
                elem.drainTo(chunk => { out.push(chunk) })
              }
              releaseReader()
              out.push(null)
              return
            }
            processChunk(value, chunk => {
              if (!destroyed && chunk.byteLength > 0 && !out.push(chunk)) {
                wantMore = false
              }
            })
          }
        } catch (error) {
          if (!destroyed) {
            elem.reset()
            releaseReader()
            out.destroy(error instanceof Error ? error : new Error("Stream read failed"))
          }
        } finally {
          pumping = false
        }
      })()
    },
    destroy(error, callback) {
      destroyed = true
      elem.reset()
      if (finished) {
        releaseReader()
        callback(error)
        return
      }
      void reader.cancel(error ?? undefined).catch(() => {}).finally(() => {
        releaseReader()
        callback(error)
      })
    },
  })

  return out
}
