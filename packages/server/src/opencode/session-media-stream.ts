import { Readable } from "node:stream"
import { deferToolMedia } from "./session-media"

/** Matches session-media-fetch.ts and server-rs/src/sessions/media.rs per-message cap. */
export const MAX_STREAMED_MESSAGE_BYTES = 16 * 1024 * 1024

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}

/**
 * Streams a native `GET /api/session/:id/message` JSON envelope (`{"data":[...]}`)
 * while projecting each individual message object through `deferToolMedia` as soon
 * as it closes. Peak server memory stays bounded by one message (`maxElementBytes`)
 * instead of buffering the entire page.
 */
export function deferToolMediaStream(
  source: ReadableStream<Uint8Array>,
  scope: { workspaceId: string; sessionId: string },
  maxElementBytes = MAX_STREAMED_MESSAGE_BYTES,
): Readable {
  return Readable.from((async function* () {
    const reader = source.getReader()
    let finished = false
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
    let elemChunks: Buffer[] = []
    let elemBytes = 0
    let elemOverflowed = false

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          finished = true
          break
        }
        if (value.byteLength === 0) continue
        if (passthrough) {
          yield value
          continue
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
                  const tail = Buffer.from(value.subarray(elemStart, i + 1))
                  if (elemBytes + tail.byteLength <= maxElementBytes) {
                    elemChunks.push(tail)
                    elemBytes += tail.byteLength
                    const raw = Buffer.concat(elemChunks, elemBytes)
                    elemChunks = []
                    elemBytes = 0
                    let projected: Buffer = raw
                    try {
                      const parsed: unknown = JSON.parse(raw.toString("utf8"))
                      deferToolMedia([parsed], scope)
                      projected = Buffer.from(JSON.stringify(parsed), "utf8")
                    } catch {
                      projected = raw
                    }
                    yield projected
                  } else {
                    for (const chunk of elemChunks) yield chunk
                    elemChunks = []
                    elemBytes = 0
                    yield tail
                  }
                } else {
                  yield value.subarray(rawStart, i + 1)
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
              if (i > rawStart) yield value.subarray(rawStart, i)
              capturing = true
              elemOverflowed = false
              elemChunks = []
              elemBytes = 0
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
          const part = Buffer.from(value.subarray(elemStart))
          if (elemBytes + part.byteLength > maxElementBytes) {
            for (const chunk of elemChunks) yield chunk
            elemChunks = []
            elemBytes = 0
            yield part
            elemOverflowed = true
          } else if (part.byteLength > 0) {
            elemChunks.push(part)
            elemBytes += part.byteLength
          }
        } else if (rawStart < value.byteLength) {
          yield value.subarray(rawStart)
        }
      }

      if (capturing && !elemOverflowed && elemChunks.length > 0) {
        for (const chunk of elemChunks) yield chunk
      }
    } finally {
      if (!finished) await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  })())
}
