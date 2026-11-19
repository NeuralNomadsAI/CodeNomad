import type { VoiceConversationEngine } from "../api-types"

export const LIVE_VOICE_PATH = "/api/speech/conversation/live"
export const LIVE_VOICE_CLIENT_BYTES = 32 * 1024
export const LIVE_VOICE_PROVIDER_BYTES = 256 * 1024

export type LiveVoiceEngine = Exclude<VoiceConversationEngine, "classic">

export type LiveVoiceTool =
  | { name: "send_to_agent"; arguments: { text: string } }
  | { name: "read_session"; arguments: Record<string, never> }

export type LiveVoiceClientMessage =
  | { type: "audio"; pcm: string }
  | { type: "truncate"; itemId: string; contentIndex: number; audioEndMs: number }
  | { type: "tool-result"; id: string; output: string }
  | { type: "stop" }

export type LiveVoiceServerMessage =
  | { type: "ready"; inputRate: 16000 | 24000; outputRate: 24000 }
  | { type: "audio"; pcm: string; itemId?: string; contentIndex?: number }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean; itemId?: string }
  | { type: "interrupted" }
  | { type: "turn-complete" }
  | ({ type: "tool-call"; id: string } & LiveVoiceTool)
  | { type: "tool-cancel"; id: string }

export type LiveVoiceEndReason =
  | "stopped" | "connection" | "unconfigured" | "busy" | "setup-timeout" | "idle" | "duration"
  | "limit" | "invalid-message" | "provider-error" | "provider-disconnected" | "revoked"

/** A single canonical request target, with the user's selected engine and no credential. */
export function liveVoiceTarget(engine: LiveVoiceEngine): string {
  return `${LIVE_VOICE_PATH}?engine=${engine}`
}

export function liveVoiceEngine(target: string | undefined): LiveVoiceEngine | undefined {
  if (target === liveVoiceTarget("gemini-live")) return "gemini-live"
  if (target === liveVoiceTarget("openai-realtime")) return "openai-realtime"
}
