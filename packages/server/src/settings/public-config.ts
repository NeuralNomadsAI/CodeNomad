import { publicVoiceConversationConfig } from "../speech/voice-conversation-config"
import type { SettingsDoc } from "./yaml-doc-store"

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sanitizeSpeechCredentials(value: SettingsDoc): SettingsDoc {
  const { apiKey, ...publicValue } = value
  return { ...publicValue, hasApiKey: typeof apiKey === "string" && Boolean(apiKey.trim()) }
}

function sanitizeServerOwner(value: SettingsDoc): SettingsDoc {
  const next: SettingsDoc = { ...value }
  const voiceConversation = publicVoiceConversationConfig(next.voiceConversation)
  if (voiceConversation) next.voiceConversation = voiceConversation
  else delete next.voiceConversation
  const speech = isPlainObject(next.speech) ? sanitizeSpeechCredentials(next.speech) : null

  if (!speech) {
    delete next.speech
    return next
  }

  for (const dir of ["stt", "tts"] as const) {
    if (isPlainObject(speech[dir])) {
      speech[dir] = sanitizeSpeechCredentials(speech[dir])
    } else delete speech[dir]
  }

  next.speech = speech
  return next
}

export function sanitizeConfigOwner(owner: string, value: SettingsDoc): SettingsDoc {
  if (owner !== "server") {
    return value
  }
  return sanitizeServerOwner(value)
}

export function sanitizeConfigDoc(value: SettingsDoc): SettingsDoc {
  const next: SettingsDoc = { ...value }
  if (isPlainObject(next.server)) {
    next.server = sanitizeServerOwner(next.server)
  } else {
    delete next.server
  }
  return next
}
