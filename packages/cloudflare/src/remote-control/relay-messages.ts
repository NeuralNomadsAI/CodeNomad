import type { HostToRelayMessage } from "@codenomad/remote-control-protocol"

export async function readPairingInput(request: Request, maxBytes: number): Promise<{ token?: unknown; name?: unknown } | null> {
  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
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
    if (message.type === "tunnel.close" && typeof message.id === "string") return message as HostToRelayMessage
    if (message.type === "tunnel.message" && typeof message.id === "string" && typeof message.data === "string" && typeof message.binary === "boolean") {
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
    || (value >= 1007 && value <= 1014) || (value >= 3000 && value <= 4999)) return value
  return 1011
}
