export type SpeechEngine = "api" | "hex"
export type MicrophonePurpose = "dictation" | "test" | "conversation"
export type MicrophoneRequest =
  | { action: "claimMicrophone"; id: string; purpose: MicrophonePurpose }
  | { action: "releaseMicrophone"; id: string }
export function isMicrophonePurpose(value: unknown): value is MicrophonePurpose {
  return value === "dictation" || value === "test" || value === "conversation"
}
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id)
const validMicrophoneId = (id: unknown): id is string =>
  typeof id === "string" && id.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)
export const maxHexWavBase64 = Math.ceil((44 + 16_000 * 2 * 120) / 3) * 4
export type HexComponent = "engine" | "model" | "vad"
export interface HexPlan {
  id: string
  missing: { component: HexComponent; downloadBytes: number }[]
}
export interface DeviceSpeechCapabilities {
  hex: { state: "unavailable" } | { state: "ready" | "needsPreparation"; plan: HexPlan }
}
export interface DeviceSpeechSnapshot extends DeviceSpeechCapabilities {
  engine: SpeechEngine | null
}
export type DeviceSpeechError =
  | "unavailable" | "busy" | "notOwned" | "planChanged" | "failed"

export const maxDeviceSpeechTextBytes = 64 * 1024

export type DeviceSpeechOperation =
  | { state: "starting" | "transcribing" | "verifying" | "stopping" }
  | { state: "recording" }
  | { state: "downloading"; downloadedBytes: number }
  | { state: "prepared" | "cancelled" }
  | { state: "transcribed"; text: string }
  | { state: "error"; error: DeviceSpeechError }

export type DeviceSpeechRequests = {
  read: Record<never, never>
  select: { engine: SpeechEngine }
  prepare: { planId: string }
  start: { locale: string; engine?: "hex"; microphoneLeaseId?: string }
  claimMicrophone: { id: string; purpose: MicrophonePurpose }
  releaseMicrophone: { id: string }
  status: { id: string }
  finish: { id: string; wav: string }
  cancel: { id: string }
}
export type DeviceSpeechResponses = {
  read: DeviceSpeechSnapshot
  select: DeviceSpeechSnapshot
  prepare: { id: string }
  start: { id: string }
  claimMicrophone: { busy: MicrophonePurpose | null }
  releaseMicrophone: null
  status: DeviceSpeechOperation
  finish: null
  cancel: { state: "prepared" } | null
}
export type DeviceSpeechAction = keyof DeviceSpeechRequests
export type DeviceSpeechRequest = {
  [A in DeviceSpeechAction]: { action: A } & DeviceSpeechRequests[A]
}[DeviceSpeechAction]
export type DeviceSpeechResult<T> = { ok: true; value: T } | { ok: false; error: DeviceSpeechError }

export function isSpeechEngine(value: unknown): value is SpeechEngine {
  return value === "api" || value === "hex"
}

const localePattern = /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8}){0,5}$/

export function isSpeechLocale(value: unknown): value is string {
  return typeof value === "string" && localePattern.test(value)
}

export function isDeviceSpeechRequest(value: unknown): value is DeviceSpeechRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  const count = Object.keys(input).length
  switch (input.action) {
    case "read": return count === 1
    case "select": return count === 2 && isSpeechEngine(input.engine)
    case "prepare": return count === 2 && typeof input.planId === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(input.planId)
    case "start": return isSpeechLocale(input.locale) && (count === 2 ||
      (input.engine === "hex" && (count === 3 || (count === 4 && validMicrophoneId(input.microphoneLeaseId)))))
    case "claimMicrophone": return count === 3 && validMicrophoneId(input.id) && isMicrophonePurpose(input.purpose)
    case "releaseMicrophone": return count === 2 && validMicrophoneId(input.id)
    case "finish": return count === 3 && validId(input.id) && typeof input.wav === "string" && validHexWavBase64(input.wav)
    case "status":
    case "cancel": return count === 2 && validId(input.id)
    default: return false
  }
}

export function validHexWavBase64(wav: string): boolean {
  return wav.length >= 64 && wav.length <= maxHexWavBase64 && wav.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(wav)
}
