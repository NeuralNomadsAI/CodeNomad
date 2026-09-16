import { Readable } from "node:stream"
import type { FastifyReply, FastifyRequest } from "fastify"

export async function forwardRuntimeRequest(args: {
  request: FastifyRequest
  reply: FastifyReply
  url: string
  body: unknown
  headers: Record<string, unknown>
  fetch: typeof fetch
  release?: () => void
  invalidate: () => void
}) {
  const controller = new AbortController()
  let released = false
  let unauthorized = false
  const release = () => {
    if (released) return
    released = true
    args.release?.()
    args.reply.raw.off("close", disconnect)
    // Retiring the connection aborts its fetch bodies. Preserve the received
    // native 401 envelope until its body has been consumed by the downstream.
    if (unauthorized) args.invalidate()
  }
  const disconnect = () => { controller.abort(); release() }
  args.reply.raw.once("close", disconnect)
  if (args.reply.raw.destroyed || args.request.raw.aborted) controller.abort()
  try {
    const headers = new Headers()
    for (const [key, value] of Object.entries(args.headers)) {
      if (typeof value === "string") headers.set(key, value)
      else if (Array.isArray(value)) for (const item of value) headers.append(key, String(item))
    }
    headers.delete("content-length")
    const body = args.body === undefined || args.body === null ? undefined
      : typeof args.body === "string" ? args.body : Buffer.isBuffer(args.body) ? Uint8Array.from(args.body).buffer : JSON.stringify(args.body)
    if (body === undefined) headers.delete("content-type")
    const response = await args.fetch(args.url, { method: args.request.method, headers, body, signal: controller.signal })
    unauthorized = response.status === 401
    args.reply.code(response.status)
    // Fetch has decompressed the body. Do not relay its original framing,
    // cookies, redirect destinations or content-encoding/content-length.
    for (const name of ["content-type", "cache-control", "etag", "last-modified"]) {
      const value = response.headers.get(name)
      if (value !== null) args.reply.header(name, value)
    }
    if (!response.body) { release(); return args.reply.send() }
    const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream)
    stream.once("end", release).once("close", release).once("error", release)
    return args.reply.send(stream)
  } catch (error) {
    release()
    if (!controller.signal.aborted) args.invalidate()
    throw error
  }
}
