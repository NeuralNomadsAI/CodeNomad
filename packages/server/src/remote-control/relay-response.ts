import type { RemoteControlDevice } from "@codenomad/remote-control-protocol"

const MAX_CONTROL_RESPONSE_BYTES = 128 * 1024
const MAX_CONTROL_RESPONSE_CHUNKS = 1024
const MAX_DEVICES = 64
const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export interface RelayPairingMetadata {
  token: string
  expiresAt: string
}

export interface RelayResponse {
  status: number
  headers: { get(name: string): string | null }
  body: {
    cancel(): Promise<unknown>
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>
      cancel(): Promise<unknown>
    }
  } | null
}

export async function readRelayJson(response: RelayResponse): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CONTROL_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error("Remote Control relay response is too large")
  }
  if (!response.body) throw new Error("Remote Control relay returned an empty response")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done || !value) break
    if (!value.byteLength) continue
    size += value.byteLength
    if (size > MAX_CONTROL_RESPONSE_BYTES || chunks.length >= MAX_CONTROL_RESPONSE_CHUNKS) {
      await reader.cancel().catch(() => undefined)
      throw new Error("Remote Control relay response is too large")
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
}

export function parseRelayPairing(value: unknown): RelayPairingMetadata | null {
  if (!isRecord(value) || typeof value.token !== "string" || !TOKEN_PATTERN.test(value.token)
    || typeof value.expiresAt !== "string" || value.expiresAt.length > 64
    || !Number.isFinite(Date.parse(value.expiresAt))) return null
  return { token: value.token, expiresAt: value.expiresAt }
}

export function parseRelayDevices(value: unknown): RemoteControlDevice[] | null {
  if (!isRecord(value) || !Array.isArray(value.devices) || value.devices.length > MAX_DEVICES) return null
  const ids = new Set<string>()
  const devices: RemoteControlDevice[] = []
  for (const candidate of value.devices) {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || !DEVICE_ID_PATTERN.test(candidate.id)
      || ids.has(candidate.id) || typeof candidate.name !== "string" || !candidate.name.trim()
      || candidate.name.length > 80 || typeof candidate.createdAt !== "string" || candidate.createdAt.length > 64
      || typeof candidate.lastSeenAt !== "string" || candidate.lastSeenAt.length > 64
      || !Number.isFinite(Date.parse(candidate.createdAt)) || !Number.isFinite(Date.parse(candidate.lastSeenAt))) return null
    ids.add(candidate.id)
    devices.push({
      id: candidate.id,
      name: candidate.name,
      createdAt: candidate.createdAt,
      lastSeenAt: candidate.lastSeenAt,
    })
  }
  return devices
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
