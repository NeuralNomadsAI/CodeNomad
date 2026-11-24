import { projectInboxUserFiles } from "../opencode/session-pruning/user-file-reference"

// A native inbox envelope can contain the four 5 MiB uploads admitted by the composer,
// encoded in base64. Shrink it before the shared SDK reader's 16 MiB limit.
const FRAME_BYTES = 32 * 1024 * 1024
const SDK_FRAME_BYTES = 16 * 1024 * 1024

export function projectLargeNativeEvents(response: Response): Response {
  if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0]?.trim() !== "text/event-stream" || !response.body) return response
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let line: string[] = [], lines: string[] = [], bytes = 0, units = 0, afterCR = false
  const limit = () => {
    if (bytes > FRAME_BYTES) throw new Error("OpenCode event exceeds the frame limit")
  }
  const fragment = (value: string) => {
    if (!value.length) return
    bytes += Buffer.byteLength(value)
    units += value.length
    limit()
    line.push(value)
  }
  const finishLine = (stream: TransformStreamDefaultController<Uint8Array>) => {
    const value = line.join("")
    line = []
    if (value) {
      lines.push(value)
      return
    }
    if (units <= SDK_FRAME_BYTES) stream.enqueue(encoder.encode(`${lines.join("\n")}\n\n`))
    else {
      const event = JSON.parse(lines.flatMap(value => value.startsWith("data:") ? [value.slice(5).trimStart()] : []).join("\n"))
      const envelope = { type: "instance.event", event }
      const projected = projectInboxUserFiles(envelope)
      if (projected === envelope) throw new Error("OpenCode event exceeds the SDK frame limit")
      const frame = `data: ${JSON.stringify(projected.event)}\n\n`
      if (frame.length > SDK_FRAME_BYTES) throw new Error("OpenCode event exceeds the SDK frame limit")
      stream.enqueue(encoder.encode(frame))
    }
    lines = []
    bytes = units = 0
  }
  const consume = (text: string, stream: TransformStreamDefaultController<Uint8Array>) => {
      let start = 0
      for (const match of text.matchAll(/[\r\n]/g)) {
        const at = match.index
        const continuation = afterCR && text[at] === "\n" && at === start
        fragment(text.slice(start, at))
        if (!continuation) {
          bytes++
          units++
          limit()
          finishLine(stream)
        }
        afterCR = text[at] === "\r"
        start = at + 1
      }
      if (start < text.length) {
        afterCR = false
        fragment(text.slice(start))
      }
  }
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform: (chunk, stream) => consume(decoder.decode(chunk, { stream: true }), stream),
    flush: stream => {
      consume(decoder.decode(), stream)
      if (line.length) finishLine(stream)
      if (lines.length) finishLine(stream)
    },
  }))
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return new Response(body, { status: response.status, headers })
}
