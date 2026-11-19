import type { RawData } from "ws"
import type { LiveVoiceClientMessage, LiveVoiceTool } from "./live-voice-contract"

export type JsonObject = Record<string, unknown>

export function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined
}

export function readObject(data: RawData): JsonObject | undefined {
  try {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
    return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
  } catch { return undefined }
}

export function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
}

function boundedText(value: unknown, bytes: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= bytes
}

export function transcriptText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 24 * 1024
}

/** Inspect framing only; PCM bytes pass unchanged, including samples at zero. */
export function pcmBytes(value: unknown): number {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return 0
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return 0
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  const bytes = value.length * 3 / 4 - padding
  return bytes % 2 === 0 ? bytes : 0
}

function keys(value: JsonObject, ...expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

export function readClientMessage(value: JsonObject): LiveVoiceClientMessage | undefined {
  switch (value.type) {
    case "stop":
      if (keys(value, "type")) return { type: "stop" }
      break
    case "audio":
      if (keys(value, "type", "pcm") && typeof value.pcm === "string" && pcmBytes(value.pcm)) return { type: "audio", pcm: value.pcm }
      break
    case "truncate": {
      const { itemId, contentIndex, audioEndMs } = value
      if (keys(value, "type", "itemId", "contentIndex", "audioEndMs") && identifier(itemId)
        && typeof contentIndex === "number" && Number.isInteger(contentIndex) && contentIndex >= 0 && contentIndex <= 32
        && typeof audioEndMs === "number" && Number.isInteger(audioEndMs) && audioEndMs >= 0 && audioEndMs <= 8 * 60_000) {
        return { type: "truncate", itemId, contentIndex, audioEndMs }
      }
      break
    }
    case "tool-result":
      if (keys(value, "type", "id", "output") && identifier(value.id) && boundedText(value.output, 16 * 1024)) {
        return { type: "tool-result", id: value.id, output: value.output }
      }
  }
}

export function readTool(name: unknown, args: unknown): LiveVoiceTool | undefined {
  const value = object(args)
  if (!value) return
  if (name === "read_session" && keys(value)) return { name, arguments: {} }
  if (name === "send_to_agent" && keys(value, "text") && boundedText(value.text, 4096)) {
    return { name, arguments: { text: value.text } }
  }
}
