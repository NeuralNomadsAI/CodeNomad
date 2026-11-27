import { PassThrough, Readable } from "node:stream"
import type { FastifyReply, FastifyRequest } from "fastify"
import { supportsDispatchHooks, type RuntimeFetchDispatchHooks } from "./transport"

export class PreDispatchHttpError extends Error {
  constructor(readonly statusCode: number, readonly payload: Record<string, unknown>) {
    super(typeof payload.error === "string" ? payload.error : `Pre-dispatch HTTP ${statusCode}`)
  }
}

export async function forwardRuntimeRequest(args: {
  request: FastifyRequest
  reply: FastifyReply
  url: string
  body: unknown
  headers: Record<string, unknown>
  fetch: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
    mediaResponseProcessor?: undefined,
    dispatchHooks?: RuntimeFetchDispatchHooks,
  ) => Promise<Response>
  beforeDispatch?: () => Promise<void>
  release?: () => void
  /** Once dispatched, the native response owns settlement even if downstream closes. */
  retainMutation?: (confirmed: boolean) => void
  invalidate: () => void
  /** Rewrites a successful JSON response in place before it is relayed whole. */
  transform?: (body: unknown) => void
}) {
  const controller = new AbortController()
  let released = false
  let unauthorized = false
  let dispatched = false
  let detached = false
  let confirmed = false
  let grace: ReturnType<typeof setTimeout> | undefined
  let downstreamRelay: PassThrough | undefined
  const release = () => {
    if (released) return
    released = true
    if (grace) clearTimeout(grace)
    if (dispatched) args.retainMutation?.(confirmed)
    args.release?.()
    args.reply.raw.off("close", disconnect)
    // Retiring the connection aborts its fetch bodies. Preserve the received
    // native 401 envelope until its body has been consumed by the downstream.
    if (unauthorized) args.invalidate()
  }
  const disconnect = () => {
    detached = true
    downstreamRelay?.destroy()
    if (!args.retainMutation || !dispatched) { controller.abort(); release() }
    else {
      // A lost window bounds the detached transport wait, not the uncertainty hold.
      grace = setTimeout(() => controller.abort(), 60_000)
      grace.unref?.()
    }
  }
  args.reply.raw.once("close", disconnect)
  if (args.reply.raw.destroyed || args.request.raw.aborted) controller.abort()
  try {
    controller.signal.throwIfAborted()
    const headers = new Headers()
    for (const [key, value] of Object.entries(args.headers)) {
      if (typeof value === "string") headers.set(key, value)
      else if (Array.isArray(value)) for (const item of value) headers.append(key, String(item))
    }
    headers.delete("content-length")
    const body = args.body === undefined || args.body === null ? undefined
      : typeof args.body === "string" ? args.body : Buffer.isBuffer(args.body) ? Uint8Array.from(args.body).buffer : JSON.stringify(args.body)
    if (body === undefined) headers.delete("content-type")
    let response: Response
    if (args.beforeDispatch) {
      if (!supportsDispatchHooks(args.fetch)) {
        throw new PreDispatchHttpError(502, { error: "opencode_unavailable_before_send" })
      }
      let beforeRan = false
      const dispatchHooks: RuntimeFetchDispatchHooks = {
        beforeFetch: async () => {
          beforeRan = true
          await args.beforeDispatch!()
        },
        onDispatch: () => { dispatched = true },
      }
      response = await args.fetch(args.url, { method: args.request.method, headers, body, signal: controller.signal }, undefined, dispatchHooks)
      if (!beforeRan) {
        await response.body?.cancel().catch(() => {})
        release()
        if (detached) return
        return args.reply.code(502).send({ error: "OpenCode dispatch hook did not run" })
      }
    } else {
      dispatched = true
      response = await args.fetch(args.url, { method: args.request.method, headers, body, signal: controller.signal })
    }
    const definitive = response.status < 500
    unauthorized = response.status === 401
    if (detached) {
      if (response.body && args.retainMutation) {
        // Drain without buffering; a truncated response is not a receipt.
        for await (const _chunk of Readable.fromWeb(response.body as import("node:stream/web").ReadableStream)) { /* discard */ }
      } else await response.body?.cancel()
      confirmed = definitive
      release()
      return
    }
    args.reply.code(response.status)
    // Fetch has decompressed the body. Do not relay its original framing,
    // cookies, redirect destinations or content-encoding/content-length.
    for (const name of ["content-type", "cache-control", "etag", "last-modified"]) {
      const value = response.headers.get(name)
      if (value !== null) args.reply.header(name, value)
    }
    if (!response.body) { confirmed = definitive; release(); return args.reply.send() }
    if (args.transform && response.ok && /^application\/json\b/i.test(response.headers.get("content-type") ?? "")) {
      let text: string
      try { text = await response.text() } catch {
        // Like an interrupted stream: the connection stays; only this response failed.
        release()
        return args.reply.code(502).send({ error: "OpenCode response was interrupted" })
      }
      confirmed = definitive
      release()
      let value: unknown
      try { value = JSON.parse(text) } catch { return args.reply.send(text) }
      args.transform(value)
      return args.reply.send(JSON.stringify(value))
    }
    const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream)
    if (args.retainMutation) {
      // Fastify owns only the downstream relay. A closed relay wakes backpressure
      // but cannot destroy the native reader or settle the mutation.
      const relay = downstreamRelay = new PassThrough()
      args.reply.send(relay)
      try {
        for await (const chunk of stream) {
          if (!detached && !relay.destroyed && !relay.write(chunk)) await waitForRelay(relay)
        }
        confirmed = definitive
        relay.end()
      } catch (error) {
        relay.destroy(error instanceof Error ? error : new Error("OpenCode response was interrupted"))
      } finally {
        release()
      }
      return
    }
    stream.once("end", () => { confirmed = definitive; release() }).once("close", release).once("error", release)
    return args.reply.send(stream)
  } catch (error) {
    release()
    if (error instanceof PreDispatchHttpError) {
      if (detached) return
      args.reply.header("x-codenomad-before-dispatch", "1")
      return args.reply.code(error.statusCode).send(error.payload)
    }
    if (!dispatched && args.beforeDispatch && !controller.signal.aborted) {
      if (detached) return
      return args.reply.header("x-codenomad-before-dispatch", "1").code(502).send({ error: "opencode_unavailable_before_send" })
    }
    if (!controller.signal.aborted) args.invalidate()
    if (detached) return
    throw error
  }
}

function waitForRelay(relay: PassThrough): Promise<void> {
  if (relay.destroyed || !relay.writableNeedDrain) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => {
      relay.off("drain", done).off("close", done)
      resolve()
    }
    relay.once("drain", done).once("close", done)
  })
}
