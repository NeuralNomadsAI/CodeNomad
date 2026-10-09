import http from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { markRemoteSocket } from "./request-origin"

type Router = (request: http.IncomingMessage, response: http.ServerResponse) => void

// The local Fastify listener's timeouts, so long uploads and idle keep-alive
// connections behave the same remotely (Node's defaults are 300 s and 5 s).
export const INGRESS_TIMEOUTS = { requestTimeout: 0, headersTimeout: 60_000, keepAliveTimeout: 72_000 } as const

/**
 * Loopback listener receiving only decrypted Remote Control connections. Every
 * accepted socket is classified as remote before any request is parsed, so the
 * tunnel's loopback peer address never grants local privileges.
 */
export class RemoteIngress {
  private server: http.Server | null = null
  private readonly sockets = new Set<Socket>()
  private readonly devices = new WeakMap<Socket, string>()

  constructor(private readonly router: Router) {}

  /** Starts listening and returns the `host:port` tunnel target. */
  async start(): Promise<string> {
    if (this.server) return target(this.server)
    const server = http.createServer((request, response) => this.router(request, response))
    Object.assign(server, INGRESS_TIMEOUTS)
    server.on("connection", (socket: Socket) => {
      markRemoteSocket(socket)
      this.sockets.add(socket)
      socket.once("close", () => this.sockets.delete(socket))
    })
    // The remote surface exposes no WebSocket endpoints.
    server.on("upgrade", (_request, socket: Socket) => {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
    })
    server.on("clientError", (_error, socket: Socket) => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject)
        resolve()
      })
    })
    this.server = server
    return target(server)
  }

  /** Associates a connection with the paired device that authenticated on it. */
  assignDevice(socket: Socket, deviceId: string): void {
    this.devices.set(socket, deviceId)
  }

  /** Closes every live connection, including streams, opened by a device. */
  disconnectDevice(deviceId: string): void {
    for (const socket of this.sockets) {
      if (this.devices.get(socket) === deviceId) socket.destroy()
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function target(server: http.Server): string {
  const address = server.address() as AddressInfo
  return `127.0.0.1:${address.port}`
}
