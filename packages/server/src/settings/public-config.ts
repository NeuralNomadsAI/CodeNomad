import type { SettingsDoc } from "./yaml-doc-store"

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sanitizeServerOwner(value: SettingsDoc): SettingsDoc {
  const next: SettingsDoc = { ...value }
  const speech = isPlainObject(next.speech) ? { ...next.speech } : null

  if (!speech) {
    return next
  }

  const rawApiKey = typeof speech.apiKey === "string" ? speech.apiKey.trim() : ""
  if (rawApiKey) {
    delete speech.apiKey
    speech.hasApiKey = true
  } else if (!("hasApiKey" in speech)) {
    speech.hasApiKey = false
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
  }
  return next
}
