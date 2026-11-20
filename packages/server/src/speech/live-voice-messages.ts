import type { RawData } from "ws"
import {
  liveVoiceIdentifier as identifier, liveVoiceKeys as keys, liveVoiceObject as object, type LiveVoiceClientMessage,
} from "./live-voice-contract"
export { identifier, object }

export type JsonObject = Record<string, unknown>

export function readObject(data: RawData): JsonObject | undefined {
  try {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
    return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
  } catch { return undefined }
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

export function readClientMessage(value: JsonObject): LiveVoiceClientMessage | undefined {
  switch (value.type) {
    case "start": {
      const context = object(value.context)
      if (!keys(value, "type", "context") || !context || !keys(context, "project", "branch", "worktree", "title", "status")) break
      const { project, branch, worktree, title, status } = context
      const label = (candidate: unknown): candidate is string => typeof candidate === "string" && candidate.length <= 256
      if (label(project) && label(branch) && label(worktree) && label(title)
        && (status === "running" || status === "idle" || status === "waiting_permission" || status === "waiting_question")) {
        return { type: "start", context: { project, branch, worktree, title, status } }
      }
      break
    }
    case "stop":
      if (keys(value, "type")) return { type: "stop" }
      break
    case "audio-end":
      if (keys(value, "type")) return { type: "audio-end" }
      break
    case "audio":
      if (keys(value, "type", "pcm") && typeof value.pcm === "string" && pcmBytes(value.pcm)) return { type: "audio", pcm: value.pcm }
      break
    case "interrupt":
      if (keys(value, "type", "responseId") && identifier(value.responseId)) return { type: "interrupt", responseId: value.responseId }
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
