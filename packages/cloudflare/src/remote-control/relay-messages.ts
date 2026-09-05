import type { HostToRelayMessage } from "@codenomad/remote-control-protocol"

const MESSAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_PAIRING_BODY_CHUNKS = 256
const MAX_CLOSE_REASON_CHARS = 120

export async function readPairingInput(request: Request, maxBytes: number): Promise<{ token?: unknown; name?: unknown } | null> {
  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let reads = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    reads += 1
    size += value.byteLength
    if (size > maxBytes || reads > MAX_PAIRING_BODY_CHUNKS) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(body)) as unknown
    return typeof value === "object" && value !== null ? value : null
  } catch {
    return null
  }
}

export function parseHostMessage(value: string): HostToRelayMessage | null {
  try {
    const message = JSON.parse(value) as Partial<HostToRelayMessage>
    if (message.type === "ready" && typeof message.protocol === "number") return message as HostToRelayMessage
    if (!validMessageId((message as { id?: unknown }).id)) return null
    if (message.type === "tunnel.close" && validCloseMetadata(message.code, message.reason)) return message as HostToRelayMessage
    if (message.type === "tunnel.message" && typeof message.data === "string" && typeof message.binary === "boolean") {
      return message as HostToRelayMessage
    }
    return null
  } catch {
    return null
  }
}

export function base64ByteLength(value: string): number {
  if (!value) return 0
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.floor(value.length * 3 / 4) - padding
}

export function safeRelayCloseCode(value: number): number {
  if (value === 1000 || value === 1001 || value === 1002 || value === 1003
    || (Number.isSafeInteger(value) && value >= 1007 && value <= 1014)
    || (Number.isSafeInteger(value) && value >= 3000 && value <= 4999)) return value
  return 1011
}

function validMessageId(value: unknown): value is string {
  return typeof value === "string" && MESSAGE_ID_PATTERN.test(value)
}

function validCloseMetadata(code: unknown, reason: unknown): boolean {
  return (code === undefined || (typeof code === "number" && Number.isSafeInteger(code) && code >= 0 && code <= 0xffff))
    && (reason === undefined || (typeof reason === "string" && reason.length <= MAX_CLOSE_REASON_CHARS
      && new TextEncoder().encode(reason).byteLength <= 123 && !/[\0\r\n]/.test(reason)))
}
