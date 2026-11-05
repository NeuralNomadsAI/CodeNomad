export const NATIVE_RESPONSE_PREFIX = "CODENOMAD_NATIVE_RESPONSE:"
export const ATTACHMENT_REQUEST_ID_PREFIX = "attachments-"
export const MAX_ATTACHMENT_RESPONSE_BYTES = 8 * 1024 * 1024
const HEADER_BYTES = 256

// Both native serializers put v/id first. IDs are opaque and echoed unchanged.
export function nativeResponseId(line: string): string | undefined {
  const header = line.slice(0, HEADER_BYTES)
  if (!header.startsWith(NATIVE_RESPONSE_PREFIX)) return undefined
  return /^\{"v":1,"id":"([A-Za-z0-9_-]{1,128})",/.exec(header.slice(NATIVE_RESPONSE_PREFIX.length))?.[1]
}

export function nativeResponseLimit(id: string): number {
  if (!id.startsWith(ATTACHMENT_REQUEST_ID_PREFIX)) return Infinity
  // Eight MiB of serialized result plus the exact v1 success envelope and prefix.
  return MAX_ATTACHMENT_RESPONSE_BYTES + Buffer.byteLength(`${NATIVE_RESPONSE_PREFIX}${JSON.stringify({ v: 1, id, ok: true, result: null })}`) - 4
}

// Classify the small header before copying body bytes, including a single huge chunk.
// A discarded line drains to LF; subsequent lines in the same chunk remain usable.
export function nativeStdinFramer(onLine: (line: string) => void, onOverflow?: (id: string) => void): (chunk: Buffer | string) => void {
  const header = Buffer.alloc(HEADER_BYTES)
  let headSize = 0, size = 0, limit = Infinity
  let classified = false, discarded = false
  let id: string | undefined
  let pieces: Buffer[] = []
  let tail: Buffer | undefined
  let tailSize = 0, lastByte = -1
  const reset = () => {
    headSize = size = 0; limit = Infinity
    classified = discarded = false; id = undefined; pieces = []
    tail = undefined; tailSize = 0; lastByte = -1
  }
  const discard = () => {
    discarded = true; pieces = []; tail = undefined
    if (id) onOverflow?.(id)
  }
  const classify = () => {
    const text = header.toString("utf8", 0, headSize)
    id = nativeResponseId(text)
    if (id) { limit = nativeResponseLimit(id); classified = true }
    else if (headSize === HEADER_BYTES) {
      classified = true
      // Only native responses have a body; other stdin commands fit in the header.
      discard()
    }
  }
  const consume = (bytes: Buffer) => {
    let offset = 0
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset)
      const end = newline < 0 ? bytes.length : newline
      if (!discarded) {
        if (!classified) {
          const count = Math.min(HEADER_BYTES - headSize, end - offset)
          bytes.copy(header, headSize, offset, offset + count)
          headSize += count
          classify()
        }
        // One optional CR is framing, outside the result/envelope byte allowance.
        if (!discarded) {
          const nextSize = size + end - offset
          const finalByte = end > offset ? bytes[end - 1] : lastByte
          if (nextSize > limit && !(nextSize === limit + 1 && finalByte === 13)) discard()
          else {
            let position = offset
            while (position < end) {
              if (!tail || tailSize === tail.length) {
                tail = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - size))
                tailSize = 0; pieces.push(tail)
              }
              const count = Math.min(tail.length - tailSize, end - position)
              bytes.copy(tail, tailSize, position, position + count)
              tailSize += count; size += count; position += count
            }
            if (end > offset) lastByte = bytes[end - 1]!
          }
        }
      }
      if (newline < 0) break
      if (!discarded) {
        const trailingCR = lastByte === 13
        if (size - (trailingCR ? 1 : 0) > limit) discard()
        else {
          const line = Buffer.concat(pieces, size).toString("utf8")
          onLine(trailingCR ? line.slice(0, -1) : line)
        }
      }
      reset()
      offset = end + 1
    }
  }
  let highSurrogate = ""
  return chunk => {
    if (typeof chunk !== "string") {
      if (highSurrogate) { consume(Buffer.from(highSurrogate)); highSurrogate = "" }
      consume(chunk)
      return
    }
    let offset = 0
    if (highSurrogate && chunk.length) {
      const low = chunk.charCodeAt(0)
      const paired = low >= 0xdc00 && low <= 0xdfff
      consume(Buffer.from(highSurrogate + (paired ? chunk[0] : "")))
      highSurrogate = ""; offset = paired ? 1 : 0
    }
    while (offset < chunk.length) {
      let end = Math.min(offset + 16 * 1024, chunk.length)
      const last = chunk.charCodeAt(end - 1)
      if (last >= 0xd800 && last <= 0xdbff) {
        if (end === chunk.length) highSurrogate = chunk[end - 1]!
        end--
      }
      if (end > offset) consume(Buffer.from(chunk.slice(offset, end)))
      offset = end
      if (highSurrogate) break
    }
  }
}
