export const REMOTE_CONTROL_PROTOCOL_VERSION = 2 as const
export const REMOTE_CONTROL_HEARTBEAT_REQUEST = "codenomad.remote-control.ping.v2"
export const REMOTE_CONTROL_HEARTBEAT_RESPONSE = "codenomad.remote-control.pong.v2"
export const REMOTE_CONTROL_MAX_HANDSHAKE_BYTES = 4 * 1024
export const REMOTE_CONTROL_MAX_HTTP_BODY_BYTES = 12 * 1024 * 1024
export const REMOTE_CONTROL_MAX_SOCKET_MESSAGE_BYTES = 12 * 1024 * 1024
export const REMOTE_CONTROL_MAX_PLAINTEXT_BYTES = 20 * 1024 * 1024

export type HeaderEntries = Array<[string, string]>

export type RelayToHostMessage =
  | { type: "ready"; protocol: typeof REMOTE_CONTROL_PROTOCOL_VERSION }
  | { type: "tunnel.open"; id: string }
  | { type: "tunnel.message"; id: string; data: string; binary: boolean }
  | { type: "tunnel.close"; id: string; code?: number; reason?: string }

export type HostToRelayMessage =
  | { type: "ready"; protocol: typeof REMOTE_CONTROL_PROTOCOL_VERSION }
  | { type: "tunnel.message"; id: string; data: string; binary: boolean }
  | { type: "tunnel.close"; id: string; code?: number; reason?: string }

export type ClientToHostMessage =
  | {
      type: "http.request"
      id: string
      method: string
      path: string
      headers: HeaderEntries
      body?: string
    }
  | { type: "http.cancel"; id: string }
  | {
      type: "socket.open"
      id: string
      path: string
      headers: HeaderEntries
      protocols: string[]
    }
  | { type: "socket.message"; id: string; data: string; binary: boolean }
  | { type: "socket.close"; id: string; code?: number; reason?: string }

export type HostToClientMessage =
  | {
      type: "http.start"
      id: string
      status: number
      headers: HeaderEntries
    }
  | { type: "http.chunk"; id: string; data: string }
  | { type: "http.end"; id: string }
  | { type: "http.error"; id: string; message: string }
  | { type: "socket.ready"; id: string; protocol?: string }
  | { type: "socket.message"; id: string; data: string; binary: boolean }
  | { type: "socket.close"; id: string; code?: number; reason?: string }
  | { type: "socket.error"; id: string; message: string }

export interface RemoteControlStatus {
  manageable: boolean
  enabled: boolean
  state: "stopped" | "connecting" | "connected" | "reconnecting" | "error"
  hostId: string
  relayUrl: string
  remoteUrl: string
  pairedDevices: number
  lastConnectedAt?: string
  error?: string
}

export interface RemoteControlPairing {
  url: string
  expiresAt: string
}

export interface RemoteControlDevice {
  id: string
  name: string
  createdAt: string
  lastSeenAt: string
}

export interface RemoteControlStartResponse {
  status: RemoteControlStatus
  pairing: RemoteControlPairing
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
