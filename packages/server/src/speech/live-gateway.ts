import type { IncomingMessage } from "node:http"
import type { Socket } from "node:net"
import tls from "node:tls"
import type { AuthManager } from "../auth/manager"
import type { SettingsService } from "../settings/service"
import type { Logger } from "../logger"
import type { LiveVoiceProvider } from "../api-types"
import { resolveLiveUpstream, type LiveUpstreamOptions } from "./live-upstream"

export interface LiveGatewayDeps {
  authManager: AuthManager
  settings: SettingsService
  logger: Logger
}

export class LiveGateway {
  private readonly authManager: AuthManager
  private readonly settings: SettingsService
  private readonly logger: Logger

  constructor(deps: LiveGatewayDeps) {
    this.authManager = deps.authManager
    this.settings = deps.settings
    this.logger = deps.logger.child({ component: "live-gateway" })
  }

  async handleUpgrade(request: IncomingMessage, clientSocket: Socket, head: Buffer): Promise<void> {
    if (!this.isWebSocketUpgrade(request)) {
      this.reject(clientSocket, 400, "Bad Request")
      return
    }

    const session = this.authManager.getSessionFromHeaders(request.headers)
    if (!session) {
      this.reject(clientSocket, 401, "Unauthorized")
      return
    }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(request.url ?? "/", "http://localhost")
    } catch {
      this.reject(clientSocket, 400, "Bad Request")
      return
    }

    const providerParam = parsedUrl.searchParams.get("provider") as LiveVoiceProvider | null
    const modelParam = parsedUrl.searchParams.get("model") ?? undefined
    const voiceParam = parsedUrl.searchParams.get("voice") ?? undefined

    let upstreamOptions: LiveUpstreamOptions
    try {
      upstreamOptions = resolveLiveUpstream(this.settings, {
        provider: providerParam ?? undefined,
        model: modelParam,
        voice: voiceParam,
      })
    } catch (error) {
      this.logger.error({ err: error }, "Failed to resolve live upstream options")
      this.reject(clientSocket, 502, "Bad Gateway")
      return
    }

    this.proxyUpstream(request, clientSocket, head, upstreamOptions)
  }

  private isWebSocketUpgrade(request: IncomingMessage): boolean {
    const upgrade = request.headers.upgrade
    if (typeof upgrade !== "string" || upgrade.toLowerCase() !== "websocket") {
      return false
    }
    const connection = request.headers.connection
    const connectionValue = Array.isArray(connection) ? connection.join(",") : connection ?? ""
    return connectionValue
      .toLowerCase()
      .split(",")
      .map((part) => part.trim())
      .includes("upgrade")
  }

  private reject(socket: Socket, statusCode: number, statusText: string): void {
    if (socket.destroyed) {
      return
    }
    socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    socket.destroy()
  }

  private proxyUpstream(
    request: IncomingMessage,
    clientSocket: Socket,
    head: Buffer,
    upstreamOptions: LiveUpstreamOptions,
  ): void {
    const { host, port, path, headers } = upstreamOptions
    const startTime = Date.now()

    this.logger.debug({ host, port, path }, "Connecting to live upstream")

    let upstreamSocket: tls.TLSSocket
    try {
      upstreamSocket = tls.connect({
        host,
        port: port || 443,
        servername: host,
      })
    } catch (error) {
      this.logger.error({ err: error, host }, "Failed to initiate TLS connection to upstream")
      this.reject(clientSocket, 502, "Bad Gateway")
      return
    }

    let handshakeCompleted = false
    let cleanedUp = false

    const cleanDestroy = (err?: Error) => {
      if (cleanedUp) return
      cleanedUp = true

      const durationMs = Date.now() - startTime
      if (err) {
        this.logger.warn({ host, durationMs, err: err.message }, "Live gateway session terminated with error")
      } else {
        this.logger.debug({ host, durationMs }, "Live gateway session closed cleanly")
      }

      if (!clientSocket.destroyed) {
        clientSocket.destroy()
      }
      if (!upstreamSocket.destroyed) {
        upstreamSocket.destroy()
      }
    }

    clientSocket.once("error", (err) => {
      this.logger.debug({ err: err.message }, "Client socket error in live gateway")
      cleanDestroy(err)
    })

    clientSocket.once("close", () => {
      cleanDestroy()
    })

    clientSocket.once("end", () => {
      cleanDestroy()
    })

    upstreamSocket.once("error", (err) => {
      this.logger.error({ err: err.message, host }, "Upstream socket error in live gateway")
      if (!handshakeCompleted) {
        this.reject(clientSocket, 502, "Bad Gateway")
      }
      cleanDestroy(err)
    })

    upstreamSocket.once("close", () => {
      cleanDestroy()
    })

    upstreamSocket.once("end", () => {
      cleanDestroy()
    })

    upstreamSocket.once("secureConnect", () => {
      const requestLine = `GET ${path} HTTP/1.1\r\n`
      const headerLines: string[] = [
        `Host: ${host}\r\n`,
        "Upgrade: websocket\r\n",
        "Connection: Upgrade\r\n",
      ]

      // Forward client websocket headers if present
      const secKey = request.headers["sec-websocket-key"]
      if (typeof secKey === "string") {
        headerLines.push(`Sec-WebSocket-Key: ${secKey}\r\n`)
      }
      const secVersion = request.headers["sec-websocket-version"]
      if (typeof secVersion === "string") {
        headerLines.push(`Sec-WebSocket-Version: ${secVersion}\r\n`)
      }
      const secProtocol = request.headers["sec-websocket-protocol"]
      if (typeof secProtocol === "string") {
        headerLines.push(`Sec-WebSocket-Protocol: ${secProtocol}\r\n`)
      }
      const secExtensions = request.headers["sec-websocket-extensions"]
      if (typeof secExtensions === "string") {
        headerLines.push(`Sec-WebSocket-Extensions: ${secExtensions}\r\n`)
      }

      // Add custom headers from upstream options (e.g. Authorization, OpenAI-Beta)
      for (const [k, v] of Object.entries(headers)) {
        headerLines.push(`${k}: ${v}\r\n`)
      }

      headerLines.push("\r\n")

      const rawRequest = requestLine + headerLines.join("")
      upstreamSocket.write(rawRequest)
      if (head.length > 0) {
        upstreamSocket.write(head)
      }

      // Buffer incoming response data until we see the HTTP response headers end (\r\n\r\n)
      let responseBuffer = Buffer.alloc(0)

      const onData = (chunk: Buffer) => {
        responseBuffer = Buffer.concat([responseBuffer, chunk])
        const headerEndIndex = responseBuffer.indexOf("\r\n\r\n")

        if (headerEndIndex !== -1) {
          upstreamSocket.off("data", onData)

          const headerPart = responseBuffer.subarray(0, headerEndIndex + 4)
          const remainingData = responseBuffer.subarray(headerEndIndex + 4)
          const headerString = headerPart.toString("latin1")
          const firstLine = headerString.split("\r\n")[0] ?? ""

          if (firstLine.includes("101")) {
            handshakeCompleted = true
            this.logger.debug({ host, status: firstLine }, "Upstream accepted WebSocket upgrade (101)")

            // Forward the 101 handshake to client
            clientSocket.write(headerPart)

            // If there's leftover payload, forward it
            if (remainingData.length > 0) {
              clientSocket.write(remainingData)
            }

            // Pipe sockets seamlessly in raw duplex binary mode
            clientSocket.pipe(upstreamSocket)
            upstreamSocket.pipe(clientSocket)
          } else {
            this.logger.warn({ host, status: firstLine }, "Upstream rejected WebSocket upgrade")
            // Pass the upstream non-101 rejection back to client and close
            clientSocket.write(headerPart)
            if (remainingData.length > 0) {
              clientSocket.write(remainingData)
            }
            cleanDestroy(new Error(`Upstream handshake failed with: ${firstLine}`))
          }
        }
      }

      upstreamSocket.on("data", onData)
    })
  }
}
