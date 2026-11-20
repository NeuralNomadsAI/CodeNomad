import type { VoiceConversationEngine } from "../api-types"

export const LIVE_VOICE_PATH = "/api/speech/conversation/live"
export const LIVE_VOICE_CLIENT_BYTES = 32 * 1024
export const LIVE_VOICE_PROVIDER_BYTES = 256 * 1024
export const LIVE_VOICE_OUTPUT_RATE = 24_000
export const LIVE_VOICE_TRACKED_IDS = 32
export const LIVE_VOICE_IDLE_MS = 2 * 60_000
export const LIVE_VOICE_ABSOLUTE_MS = 8 * 60_000
export const LIVE_VOICE_ESTABLISH_MS = 10_000
export const LIVE_VOICE_MAX_CALLS = 256
export const LIVE_VOICE_NOTICE_VERSION = 2
export const LIVE_VOICE_CONSENT_PATH = "/api/speech/conversation/consent"
export const LIVE_VOICE_TOOL_NAMES = ["send_to_agent", "get_session_status", "get_last_reply", "get_recent_errors"] as const

export type LiveVoiceEngine = Exclude<VoiceConversationEngine, "classic">

export function liveVoiceInputRate(engine: LiveVoiceEngine): 16000 | 24000 {
  return engine === "gemini-live" ? 16_000 : 24_000
}

export type LiveVoiceTool =
  | { name: "send_to_agent"; arguments: { text: string } }
  | { name: Exclude<typeof LIVE_VOICE_TOOL_NAMES[number], "send_to_agent">; arguments: Record<string, never> }

export type LiveVoiceSessionStatus = "running" | "idle" | "waiting_permission" | "waiting_question"
export interface LiveVoiceContext {
  project: string
  branch: string
  worktree: string
  title: string
  status: LiveVoiceSessionStatus
}

export function liveVoiceObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function liveVoiceKeys(value: Record<string, unknown>, ...expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

export function liveVoiceIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
}

export function readLiveVoiceTool(name: unknown, args: unknown): LiveVoiceTool | undefined {
  const value = liveVoiceObject(args)
  if (!value) return
  if (name === "send_to_agent") {
    const text = value.text
    if (liveVoiceKeys(value, "text") && typeof text === "string" && text.trim() && new TextEncoder().encode(text).length <= 4096) {
      return { name, arguments: { text } }
    }
  } else if ((name === "get_session_status" || name === "get_last_reply" || name === "get_recent_errors") && liveVoiceKeys(value)) {
    return { name, arguments: {} }
  }
}

export type LiveVoiceClientMessage =
  | { type: "start"; context: LiveVoiceContext }
  | { type: "audio"; pcm: string }
  | { type: "audio-end" }
  | { type: "interrupt"; responseId: string }
  | { type: "truncate"; itemId: string; contentIndex: number; audioEndMs: number }
  | { type: "tool-result"; id: string; output: string }
  | { type: "stop" }

export type LiveVoiceServerMessage =
  | { type: "ready"; inputRate: 16000 | 24000; outputRate: 24000 }
  | { type: "audio"; pcm: string; itemId?: string; contentIndex?: number }
  | { type: "item-order"; itemId: string; previousItemId?: string | null }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean; replace?: true; itemId?: string }
  | { type: "activity" }
  | { type: "speech-start" }
  | { type: "thinking"; responseId?: string }
  | { type: "interrupted" }
  | { type: "turn-complete"; thinking?: true }
  | ({ type: "tool-call"; id: string; responseId?: string } & LiveVoiceTool)
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
