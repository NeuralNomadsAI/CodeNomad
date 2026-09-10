import {
  REMOTE_CONTROL_HEARTBEAT_REQUEST,
  REMOTE_CONTROL_HEARTBEAT_RESPONSE,
  REMOTE_CONTROL_MAX_HANDSHAKE_BYTES,
  REMOTE_CONTROL_MAX_PLAINTEXT_BYTES,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  decodeBase64,
  encodeBase64,
  type RelayToHostMessage,
} from "@codenomad/remote-control-protocol"
import { base64ByteLength, parseHostMessage, readPairingInput, safeRelayCloseCode } from "./relay-messages"
import { HOST_SECRET_PATTERN, RELAY_TOKEN_PATTERN, bearerToken, clearDeviceCookie, cookieToken, deviceCookie, randomToken, tokenHash } from "./security"

const PAIRING_TTL_MS = 10 * 60_000
const DEVICE_TTL_MS = 30 * 24 * 60 * 60_000
const HOST_SECRET_KEY = "host-secret"
const PAIRING_PREFIX = "pair:"
const DEVICE_PREFIX = "device:"
const HOST_TAG = "host"
const CLIENT_TAG = "client"
const MAX_ACTIVE_PAIRINGS = 8
const MAX_CONNECTED_CLIENTS = 16
const MAX_DEVICES = 64
const MAX_PAIRING_BODY_BYTES = 4 * 1024
const MAX_TUNNEL_FRAME_BYTES = REMOTE_CONTROL_MAX_PLAINTEXT_BYTES + 1024
const MAX_HOST_MESSAGE_CHARS = Math.ceil(MAX_TUNNEL_FRAME_BYTES * 4 / 3) + 2 * 1024

interface PairingRecord {
  expiresAt: number
  connectionId: string
}
interface DeviceRecord {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number
  expiresAt: number
}

interface HostSocketAttachment {
  role: "host"
  connectionId: string
  ready: boolean
  active: boolean
}

interface ClientSocketAttachment {
  role: "client"
  id: string
  deviceId: string
  phase?: "hello" | "encrypted"
}

type SocketAttachment = HostSocketAttachment | ClientSocketAttachment

export class RemoteControlHost implements DurableObject {
  constructor(private readonly state: DurableObjectState) {
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(
      REMOTE_CONTROL_HEARTBEAT_REQUEST,
      REMOTE_CONTROL_HEARTBEAT_RESPONSE,
    ))
  }

  async fetch(request: Request): Promise<Response> {
    const operation = request.headers.get("x-codenomad-relay-operation")
    if (operation === "host-connect") return this.connectHost(request)
    if (operation === "pair-create") return this.createPairing(request)
    if (operation === "pair-exchange") return this.exchangePairing(request)
    if (operation === "devices") return this.devices(request)
    if (operation === "device-revoke") return this.revokeDevice(request)
    if (operation === "session-check") return this.checkDevice(request)
    if (operation === "tunnel-connect") return this.connectTunnel(request)
    return Response.json({ error: "Unknown remote-control operation" }, { status: 404 })
  }

  webSocketMessage(socket: WebSocket, payload: string | ArrayBuffer): void {
    const attachment = socketAttachment(socket)
    if (!attachment) {
      socket.close(1008, "Missing relay socket identity")
      return
    }
    if (attachment.role === "host") {
      this.onHostMessage(socket, payload)
      return
    }

    const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : new Uint8Array(payload)
    if ((attachment.phase === undefined && typeof payload !== "string")
      || attachment.phase === "hello"
      || (attachment.phase === "encrypted" && typeof payload === "string")) {
      this.closeClient(attachment.id, 1002, "Invalid encrypted tunnel sequence")
      return
    }
    if (bytes.byteLength > (attachment.phase === "encrypted" ? MAX_TUNNEL_FRAME_BYTES : REMOTE_CONTROL_MAX_HANDSHAKE_BYTES)) {
      this.closeClient(attachment.id, 1009, attachment.phase === "encrypted"
        ? "Encrypted tunnel frame is too large"
        : "Encryption handshake is too large")
      return
    }
    if (!this.sendHost({
      type: "tunnel.message",
      id: attachment.id,
      data: encodeBase64(bytes),
      binary: typeof payload !== "string",
    })) {
      this.closeClient(attachment.id, 1013, "CodeNomad host disconnected")
    } else if (attachment.phase !== "encrypted") {
      attachment.phase = "hello"
      socket.serializeAttachment(attachment)
    }
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    const attachment = socketAttachment(socket)
    if (!attachment) return
    if (attachment.role === "host") {
      this.onHostClosed(socket)
      return
    }
    this.sendHost({ type: "tunnel.close", id: attachment.id, code, reason })
  }

  webSocketError(socket: WebSocket): void {
    const attachment = socketAttachment(socket)
    if (!attachment) return
    if (attachment.role === "host") {
      this.onHostClosed(socket)
      return
    }
    this.sendHost({ type: "tunnel.close", id: attachment.id, code: 1011, reason: "Remote tunnel failed" })
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    const expiredDeviceIds = await this.state.storage.transaction(async (transaction) => {
      const pairings = await transaction.list<PairingRecord>({ prefix: PAIRING_PREFIX })
      const devices = await transaction.list<DeviceRecord>({ prefix: DEVICE_PREFIX })
      const expiredDevices = Array.from(devices.entries()).filter(([, record]) => record.expiresAt <= now)
      const expired = [
        ...Array.from(pairings.entries()).filter(([, record]) => record.expiresAt <= now).map(([key]) => key),
        ...expiredDevices.map(([key]) => key),
      ]
      if (expired.length) await transaction.delete(expired)
      const nextExpiration = [...pairings.values(), ...devices.values()]
        .map((record) => record.expiresAt)
        .filter((expiresAt) => expiresAt > now)
        .sort((left, right) => left - right)[0]
      if (nextExpiration) await transaction.setAlarm(nextExpiration)
      else await transaction.deleteAlarm()
      return expiredDevices.map(([, record]) => record.id)
    })
    this.closeDeviceSockets(expiredDeviceIds, "Remote device expired")
  }

  private async connectHost(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "WebSocket required" }, { status: 426 })
    }
    if (!(await this.authorizeHost(request, true))) return Response.json({ error: "Unauthorized" }, { status: 401 })

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    const previous = this.hostConnection()
    if (previous) {
      previous.attachment.active = false
      previous.socket.serializeAttachment(previous.attachment)
      previous.socket.close(1012, "Host reconnected")
      this.closeAllClients("CodeNomad host reconnected")
    }
    const attachment: HostSocketAttachment = {
      role: "host",
      connectionId: crypto.randomUUID(),
      ready: false,
      active: true,
    }
    server.serializeAttachment(attachment)
    this.state.acceptWebSocket(server, [HOST_TAG])
    return new Response(null, { status: 101, webSocket: client })
  }

  private async connectTunnel(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "WebSocket required" }, { status: 426 })
    }
    const device = await this.authorizeDevice(request)
    if (!device) return this.unpairedResponse()
    if (!this.isHostConnected()) return Response.json({ error: "CodeNomad host is offline" }, { status: 503 })
    if (this.state.getWebSockets(CLIENT_TAG).filter((socket) => socket.readyState === WebSocket.OPEN).length >= MAX_CONNECTED_CLIENTS) {
      return Response.json({ error: "Too many active remote clients" }, { status: 429 })
    }

    const id = crypto.randomUUID()
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    const attachment: ClientSocketAttachment = { role: "client", id, deviceId: device.id }
    server.serializeAttachment(attachment)
    this.state.acceptWebSocket(server, [CLIENT_TAG, clientTag(id)])
    if (!this.sendHost({ type: "tunnel.open", id })) {
      server.close(1013, "CodeNomad host disconnected")
      return Response.json({ error: "CodeNomad host is offline" }, { status: 503 })
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  private async createPairing(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 })
    if (!(await this.authorizeHost(request))) return Response.json({ error: "Unauthorized" }, { status: 401 })
    if (!this.isHostConnected()) return Response.json({ error: "Host is offline" }, { status: 409 })

    const now = Date.now()
    const token = randomToken()
    const key = `${PAIRING_PREFIX}${await tokenHash(token)}`
    const expiresAt = now + PAIRING_TTL_MS
    const host = this.hostConnection()
    if (!host?.attachment.ready) return Response.json({ error: "Host reconnected while creating the pairing link" }, { status: 409 })
    const connectionId = host.attachment.connectionId
    const created = await this.state.storage.transaction(async (transaction) => {
      const pairings = await transaction.list<PairingRecord>({ prefix: PAIRING_PREFIX })
      const expired = Array.from(pairings.entries())
        .filter(([, record]) => record.expiresAt <= now)
        .map(([pairingKey]) => pairingKey)
      if (expired.length) await transaction.delete(expired)
      const active = Array.from(pairings.values())
        .filter((record) => record.expiresAt > now && record.connectionId === connectionId)
      if (active.length >= MAX_ACTIVE_PAIRINGS) return false
      await transaction.put(key, {
        expiresAt,
        connectionId,
      } satisfies PairingRecord)
      await scheduleExpiration(transaction, expiresAt)
      return true
    })
    if (!created) {
      return Response.json({ error: "Too many active pairing links" }, { status: 429 })
    }
    if (!this.isCurrentHost(connectionId)) {
      await this.state.storage.transaction(async (transaction) => {
        const record = await transaction.get<PairingRecord>(key)
        if (record?.connectionId === connectionId) await transaction.delete(key)
      })
      return Response.json({ error: "Host reconnected while creating the pairing link" }, { status: 409 })
    }
    return Response.json({ token, expiresAt: new Date(expiresAt).toISOString() })
  }

  private async exchangePairing(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 })
    const input = await readPairingInput(request, MAX_PAIRING_BODY_BYTES)
    if (!input) return Response.json({ error: "Invalid or oversized pairing request" }, { status: 400 })
    const token = typeof input.token === "string" ? input.token.trim() : ""
    if (!RELAY_TOKEN_PATTERN.test(token)) return Response.json({ error: "Valid pairing token required" }, { status: 400 })

    const pairingKey = `${PAIRING_PREFIX}${await tokenHash(token)}`
    const now = Date.now()
    const deviceToken = randomToken()
    const device: DeviceRecord = {
      id: crypto.randomUUID(),
      name: typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : "Remote device",
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + DEVICE_TTL_MS,
    }
    const deviceKey = `${DEVICE_PREFIX}${await tokenHash(deviceToken)}`
    const host = this.hostConnection()
    const connectionId = host?.attachment.ready ? host.attachment.connectionId : null
    const result = await this.state.storage.transaction(async (transaction) => {
      const record = await transaction.get<PairingRecord>(pairingKey)
      if (record) await transaction.delete(pairingKey)
      if (!record || record.expiresAt <= now || !connectionId || record.connectionId !== connectionId) {
        return { status: "invalid" as const, expiredDeviceIds: [] as string[] }
      }
      const devices = await transaction.list<DeviceRecord>({ prefix: DEVICE_PREFIX })
      const expiredEntries = Array.from(devices.entries()).filter(([, candidate]) => candidate.expiresAt <= now)
      if (expiredEntries.length) await transaction.delete(expiredEntries.map(([key]) => key))
      const expiredDeviceIds = expiredEntries.map(([, candidate]) => candidate.id)
      if (devices.size - expiredEntries.length >= MAX_DEVICES) {
        return { status: "full" as const, expiredDeviceIds }
      }
      await transaction.put(deviceKey, device)
      await scheduleExpiration(transaction, device.expiresAt)
      return { status: "created" as const, expiredDeviceIds }
    })
    this.closeDeviceSockets(result.expiredDeviceIds, "Remote device expired")
    if (result.status === "invalid") {
      return Response.json({ error: "Pairing link is invalid or expired" }, { status: 401 })
    }
    if (result.status === "full") {
      return Response.json({ error: "Too many paired devices" }, { status: 429 })
    }
    if (!connectionId || !this.isCurrentHost(connectionId)) {
      await this.state.storage.transaction(async (transaction) => {
        const stored = await transaction.get<DeviceRecord>(deviceKey)
        if (stored?.id === device.id) await transaction.delete(deviceKey)
      })
      return Response.json({ error: "Pairing link is invalid or expired" }, { status: 401 })
    }

    return new Response(null, {
      status: 204,
      headers: { "Set-Cookie": deviceCookie(deviceToken, Math.floor(DEVICE_TTL_MS / 1000)) },
    })
  }

  private async devices(request: Request): Promise<Response> {
    if (!(await this.authorizeHost(request))) return Response.json({ error: "Unauthorized" }, { status: 401 })
    const now = Date.now()
    const result = await this.state.storage.transaction(async (transaction) => {
      const records = await transaction.list<DeviceRecord>({ prefix: DEVICE_PREFIX })
      const expiredEntries = Array.from(records.entries()).filter(([, device]) => device.expiresAt <= now)
      if (expiredEntries.length) await transaction.delete(expiredEntries.map(([key]) => key))
      return {
        expiredDeviceIds: expiredEntries.map(([, device]) => device.id),
        devices: Array.from(records.values())
          .filter((device) => device.expiresAt > now)
          .map((device) => ({
            id: device.id,
            name: device.name,
            createdAt: new Date(device.createdAt).toISOString(),
            lastSeenAt: new Date(device.lastSeenAt).toISOString(),
          })),
      }
    })
    this.closeDeviceSockets(result.expiredDeviceIds, "Remote device expired")
    return Response.json({ devices: result.devices })
  }

  private async revokeDevice(request: Request): Promise<Response> {
    if (request.method !== "DELETE") return new Response(null, { status: 405 })
    if (!(await this.authorizeHost(request))) return Response.json({ error: "Unauthorized" }, { status: 401 })
    const deviceId = request.headers.get("x-codenomad-relay-device-id")
    const entry = await this.state.storage.transaction(async (transaction) => {
      const records = await transaction.list<DeviceRecord>({ prefix: DEVICE_PREFIX })
      const match = Array.from(records.entries()).find(([, device]) => device.id === deviceId)
      if (match) await transaction.delete(match[0])
      return match?.[1] ?? null
    })
    if (entry) {
      this.closeDeviceSockets([entry.id], "Remote device was revoked")
    }
    return new Response(null, { status: 204 })
  }

  private async checkDevice(request: Request): Promise<Response> {
    return await this.authorizeDevice(request) ? new Response(null, { status: 204 }) : this.unpairedResponse()
  }

  private onHostMessage(socket: WebSocket, payload: string | ArrayBuffer): void {
    const current = this.hostConnection()
    if (current?.socket !== socket) return
    if (typeof payload !== "string") {
      socket.close(1003, "Invalid binary host message")
      return
    }
    if (payload.length > MAX_HOST_MESSAGE_CHARS) {
      socket.close(1009, "Relay message is too large")
      return
    }
    const message = parseHostMessage(payload)
    if (!message) {
      socket.close(1003, "Invalid relay message")
      return
    }
    if (message.type === "ready") {
      if (message.protocol !== REMOTE_CONTROL_PROTOCOL_VERSION) {
        socket.close(1002, "Unsupported protocol")
        return
      }
      current.attachment.ready = true
      socket.serializeAttachment(current.attachment)
      this.sendHost({ type: "ready", protocol: REMOTE_CONTROL_PROTOCOL_VERSION })
      return
    }
    if (!current.attachment.ready) {
      socket.close(1002, "Relay handshake required")
      return
    }
    if (message.type === "tunnel.close") {
      this.closeClient(message.id, message.code ?? 1011, message.reason ?? "CodeNomad closed the tunnel")
      return
    }
    const client = this.clientSocket(message.id)
    if (!client) return
    const attachment = socketAttachment(client)
    if (!attachment || attachment.role !== "client") return
    const phase = attachment.phase ?? "hello"
    if ((phase === "hello" && message.binary) || (phase === "encrypted" && !message.binary)) {
      this.closeClient(message.id, 1002, "Invalid encrypted tunnel sequence")
      return
    }
    const limit = phase === "hello" ? REMOTE_CONTROL_MAX_HANDSHAKE_BYTES : MAX_TUNNEL_FRAME_BYTES
    if (base64ByteLength(message.data) > limit) {
      this.closeClient(message.id, 1009, phase === "hello" ? "Encryption handshake is too large" : "Encrypted tunnel frame is too large")
      return
    }
    try {
      const bytes = decodeBase64(message.data)
      client.send(message.binary ? bytes.buffer : new TextDecoder().decode(bytes))
      if (phase === "hello") {
        attachment.phase = "encrypted"
        client.serializeAttachment(attachment)
      }
    } catch {
      this.closeClient(message.id, 1003, "Invalid tunnel frame")
    }
  }

  private onHostClosed(socket: WebSocket): void {
    const attachment = socketAttachment(socket)
    if (!attachment || attachment.role !== "host" || !attachment.active) return
    attachment.active = false
    socket.serializeAttachment(attachment)
    this.closeAllClients("CodeNomad host disconnected")
  }

  private closeAllClients(reason: string): void {
    for (const socket of this.state.getWebSockets(CLIENT_TAG)) {
      const attachment = socketAttachment(socket)
      if (attachment?.role === "client") this.closeClient(attachment.id, 1012, reason)
    }
  }

  private closeClient(id: string, code: number, reason: string): void {
    this.clientSocket(id)?.close(safeRelayCloseCode(code), boundedCloseReason(reason))
  }

  private isHostConnected(): boolean {
    return this.hostConnection()?.attachment.ready === true
  }

  private isCurrentHost(connectionId: string): boolean {
    const host = this.hostConnection()
    return host?.attachment.ready === true && host.attachment.connectionId === connectionId
  }

  private sendHost(message: RelayToHostMessage): boolean {
    const host = this.hostConnection()
    if (!host?.attachment.ready && message.type !== "ready") return false
    if (!host) return false
    try {
      host.socket.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  private hostConnection(): { socket: WebSocket; attachment: HostSocketAttachment } | null {
    for (const socket of this.state.getWebSockets(HOST_TAG)) {
      const attachment = socketAttachment(socket)
      if (socket.readyState === WebSocket.OPEN && attachment?.role === "host" && attachment.active) return { socket, attachment }
    }
    return null
  }

  private clientSocket(id: string): WebSocket | null {
    return this.state.getWebSockets(clientTag(id)).find((socket) => socket.readyState === WebSocket.OPEN) ?? null
  }

  private async authorizeHost(request: Request, allowRegistration = false): Promise<boolean> {
    const token = bearerToken(request)
    if (!token || !HOST_SECRET_PATTERN.test(token)) return false
    const presented = await tokenHash(token)
    if (!allowRegistration) return await this.state.storage.get<string>(HOST_SECRET_KEY) === presented
    return this.state.storage.transaction(async (transaction) => {
      const stored = await transaction.get<string>(HOST_SECRET_KEY)
      if (stored) return stored === presented
      await transaction.put(HOST_SECRET_KEY, presented)
      return true
    })
  }

  private async authorizeDevice(request: Request): Promise<DeviceRecord | null> {
    const token = cookieToken(request)
    if (!token || !RELAY_TOKEN_PATTERN.test(token)) return null
    const key = `${DEVICE_PREFIX}${await tokenHash(token)}`
    const now = Date.now()
    const result = await this.state.storage.transaction(async (transaction) => {
      const device = await transaction.get<DeviceRecord>(key)
      if (!device) return { device: null, expiredDeviceId: null }
      if (device.expiresAt <= now) {
        await transaction.delete(key)
        return { device: null, expiredDeviceId: device.id }
      }
      if (now - device.lastSeenAt > 60_000) {
        device.lastSeenAt = now
        await transaction.put(key, device)
      }
      return { device, expiredDeviceId: null }
    })
    if (result.expiredDeviceId) this.closeDeviceSockets([result.expiredDeviceId], "Remote device expired")
    return result.device
  }

  private unpairedResponse(): Response {
    return Response.json({ error: "Remote device is not paired" }, {
      status: 401,
      headers: { "Set-Cookie": clearDeviceCookie() },
    })
  }

  private closeDeviceSockets(deviceIds: Iterable<string>, reason: string): void {
    const ids = new Set(deviceIds)
    if (!ids.size) return
    for (const socket of this.state.getWebSockets(CLIENT_TAG)) {
      const attachment = socketAttachment(socket)
      if (attachment?.role === "client" && ids.has(attachment.deviceId)) {
        this.closeClient(attachment.id, 1008, reason)
      }
    }
  }
}

async function scheduleExpiration(
  transaction: DurableObjectTransaction,
  expiresAt: number,
): Promise<void> {
  const scheduled = await transaction.getAlarm()
  if (scheduled === null || expiresAt < scheduled) await transaction.setAlarm(expiresAt)
}

function clientTag(id: string): string {
  return `${CLIENT_TAG}:${id}`
}

function socketAttachment(socket: WebSocket): SocketAttachment | null {
  const value = socket.deserializeAttachment() as Partial<SocketAttachment> | null
  if (!value || (value.role !== "host" && value.role !== "client")) return null
  return value as SocketAttachment
}

function boundedCloseReason(value: string): string {
  let result = ""
  let bytes = 0
  for (const character of value) {
    const next = new TextEncoder().encode(character).byteLength
    if (bytes + next > 123) break
    result += character
    bytes += next
  }
  return result
}
