import { request as httpRequest, ServerResponse, type IncomingMessage, type IncomingHttpHeaders } from "node:http"
import type { RequestOptions } from "node:https"
import { request as httpsRequest } from "node:https"
import type { Socket } from "node:net"
import type { Logger } from "../logger"
import { proxyDestination, ProxyDestinationDenied } from "./proxy-destination"

// Use Node's bounded HTTP parser before forwarding a handshake. Piping raw
// upstream bytes would let Set-Cookie overwrite the application's credentials.
export async function proxyWebSocket(args: {
  request: IncomingMessage
  socket: Socket
  head: Buffer
  targetUrl: URL
  headers: IncomingHttpHeaders
  responseHeaders: (headers: IncomingHttpHeaders) => IncomingHttpHeaders
  logger: Logger
  logContext: Record<string, unknown>
  /** Internal capability transport: caller owns the pinned dial, TLS identity and revocation signal. */
  connection?: RequestOptions
  signal?: AbortSignal
}) {
  const { request, socket, head, targetUrl } = args
  if (socket.destroyed || args.signal?.aborted) { socket.destroy(); return }
  let lookup
  try {
    // The capability caller already resolved its saved destination, possibly through
    // an authorized private SSH forward. Ordinary proxies always use the boundary.
    if (!args.connection) lookup = await proxyDestination(targetUrl.hostname, Number(targetUrl.port) || (targetUrl.protocol === "https:" ? 443 : 80))
  } catch (error) {
    const status = error instanceof ProxyDestinationDenied ? "404 Not Found" : "502 Bad Gateway"
    if (!socket.destroyed) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    return
  }
  if (socket.destroyed || args.signal?.aborted) { socket.destroy(); return }
  let upgraded: Socket | undefined
  let replied = false
  const send = targetUrl.protocol === "https:" ? httpsRequest : httpRequest
  const upstream = send(targetUrl, { lookup, ...args.connection, method: request.method, headers: args.headers, agent: false, signal: args.signal })
  const abort = () => { upstream.destroy(); upgraded?.destroy(); socket.destroy() }
  args.signal?.addEventListener("abort", abort, { once: true })
  if (args.signal?.aborted) abort()
  upstream.setTimeout(15_000, () => upstream.destroy(new Error("WebSocket handshake timed out")))
  upstream.on("error", () => {
    args.logger.warn(args.logContext, "SideCar/preview WebSocket upstream failed")
    if (!socket.destroyed && !replied) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
    else socket.destroy()
    upgraded?.destroy()
  })
  socket.on("error", () => { upstream.destroy(); upgraded?.destroy() })
  socket.once("close", () => { upstream.destroy(); upgraded?.destroy(); args.signal?.removeEventListener("abort", abort) })
  upstream.once("upgrade", (response, remote, buffered) => {
    upgraded = remote
    upstream.setTimeout(0)
    remote.setTimeout(0)
    if (socket.destroyed || args.signal?.aborted) { remote.destroy(); socket.destroy(); return }
    remote.on("error", () => socket.destroy())
    remote.once("close", () => socket.end())
    const headers = args.responseHeaders(response.headers)
    const lines = Object.entries(headers).flatMap(([name, value]) =>
      value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(item => `${name}: ${item}\r\n`))
    replied = true
    socket.write(`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n${lines.join("")}\r\n`)
    if (buffered.length) socket.write(buffered)
    if (head.length) remote.write(head)
    remote.pipe(socket)
    socket.pipe(remote)
  })
  upstream.once("response", response => {
    upstream.setTimeout(0)
    if (socket.destroyed || args.signal?.aborted) { response.destroy(); socket.destroy(); return }
    // Non-101 responses also carry cookies. ServerResponse re-encodes decoded
    // chunked bodies correctly, rather than forwarding stale transfer framing.
    replied = true
    const output = new ServerResponse(request)
    output.assignSocket(socket)
    output.shouldKeepAlive = false
    output.writeHead(response.statusCode ?? 502, args.responseHeaders(response.headers))
    response.on("error", () => socket.destroy())
    output.on("error", () => socket.destroy())
    output.once("finish", () => socket.end())
    response.pipe(output)
  })
  upstream.end()
}
