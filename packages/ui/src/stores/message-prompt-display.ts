import type { PromptDisplayMetadata } from "../lib/prompt-display-metadata"

const STORAGE_KEY = "codenomad:prompt-display:v3"
const LEGACY_STORAGE_KEY = "codenomad:prompt-display:v2"

let loaded = false
const promptDisplayOverrides = new Map<string, PromptDisplayMetadata>()

function storageKey(): string {
  const windowId = typeof window === "undefined" ? "" : window.__CODENOMAD_WINDOW_ID__?.trim()
  return windowId ? `${STORAGE_KEY}:${windowId}` : STORAGE_KEY
}

function makeKey(_instanceId: string, sessionId: string, messageId: string): string {
  return `${sessionId}:${messageId}`
}

function isLegacyInstanceScopedKey(key: string): boolean {
  const firstSeparator = key.indexOf(":")
  if (firstSeparator <= 0) return false
  const secondSeparator = key.indexOf(":", firstSeparator + 1)
  return secondSeparator > firstSeparator + 1 && secondSeparator < key.length - 1
}

function migrateStoredKey(key: string): string {
  if (!isLegacyInstanceScopedKey(key)) {
    return key
  }
  return key.slice(key.indexOf(":") + 1)
}

function readStorage(): Storage | null {
  if (typeof window === "undefined" || !window.localStorage) {
    return null
  }

  return window.localStorage
}

function ensureLoaded(): void {
  if (loaded) return
  loaded = true

  const storage = readStorage()
  if (!storage) return

  try {
    const key = storageKey()
    const raw = storage.getItem(key)
    if (raw) {
      loadStoredEntries(JSON.parse(raw) as Record<string, PromptDisplayMetadata>, false)
    }
    const migrateIntoScopedKey = key !== STORAGE_KEY && !raw
    const legacyV3Raw = migrateIntoScopedKey ? storage.getItem(STORAGE_KEY) : null
    if (legacyV3Raw) {
      loadStoredEntries(JSON.parse(legacyV3Raw) as Record<string, PromptDisplayMetadata>, false)
    }
    const legacyV2Raw = key === STORAGE_KEY || migrateIntoScopedKey
      ? storage.getItem(LEGACY_STORAGE_KEY)
      : null
    if (legacyV2Raw) {
      loadStoredEntries(JSON.parse(legacyV2Raw) as Record<string, PromptDisplayMetadata>, true)
    }
    if (!legacyV3Raw && !legacyV2Raw) return
    if (!persist()) return
    if (legacyV3Raw) storage.removeItem(STORAGE_KEY)
    if (legacyV2Raw) storage.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    promptDisplayOverrides.clear()
  }
}

function loadStoredEntries(parsed: Record<string, PromptDisplayMetadata>, migrateLegacyKeys: boolean): void {
  for (const [key, value] of Object.entries(parsed)) {
    if (isPromptDisplayMetadata(value)) {
      promptDisplayOverrides.set(migrateLegacyKeys ? migrateStoredKey(key) : key, value)
    }
  }
}

function persist(): boolean {
  const storage = readStorage()
  if (!storage) return false

  try {
    storage.setItem(storageKey(), JSON.stringify(Object.fromEntries(promptDisplayOverrides)))
    return true
  } catch {
    // Ignore persistence failures.
    return false
  }
}

function isPromptDisplayMetadata(value: unknown): value is PromptDisplayMetadata {
  if (!value || typeof value !== "object") return false
  const segments = (value as PromptDisplayMetadata).segments
  if (!Array.isArray(segments) || segments.length === 0) return false
  return segments.every(
    (segment) =>
      segment &&
      typeof segment === "object" &&
      (segment.kind === "inline" || segment.kind === "pasted") &&
      typeof segment.length === "number" &&
      segment.length >= 0,
  )
}

export function getPromptDisplayOverride(
  instanceId: string,
  sessionId: string,
  messageId: string,
): PromptDisplayMetadata | undefined {
  ensureLoaded()
  return promptDisplayOverrides.get(makeKey(instanceId, sessionId, messageId))
}

export function setPromptDisplayOverride(
  instanceId: string,
  sessionId: string,
  messageId: string,
  displayMetadata: PromptDisplayMetadata | undefined,
): void {
  ensureLoaded()
  const key = makeKey(instanceId, sessionId, messageId)
  const previous = promptDisplayOverrides.get(key)
  if (displayMetadata && isPromptDisplayMetadata(displayMetadata)) {
    const serialized = JSON.stringify(displayMetadata)
    if (previous && JSON.stringify(previous) === serialized) return
    promptDisplayOverrides.set(key, displayMetadata)
  } else {
    if (!promptDisplayOverrides.has(key)) return
    promptDisplayOverrides.delete(key)
  }
  persist()
}

export function movePromptDisplayOverride(instanceId: string, sessionId: string, oldMessageId: string, newMessageId: string): void {
  ensureLoaded()
  const oldKey = makeKey(instanceId, sessionId, oldMessageId)
  const nextValue = promptDisplayOverrides.get(oldKey)
  if (!nextValue) return

  const newKey = makeKey(instanceId, sessionId, newMessageId)
  if (oldKey === newKey) return
  promptDisplayOverrides.delete(oldKey)
  promptDisplayOverrides.set(newKey, nextValue)
  persist()
}

export function clearPromptDisplayOverride(instanceId: string, sessionId: string, messageId: string): void {
  ensureLoaded()
  if (!promptDisplayOverrides.delete(makeKey(instanceId, sessionId, messageId))) {
    return
  }
  persist()
}

export function clearPromptDisplayOverridesForSession(instanceId: string, sessionId: string): void {
  ensureLoaded()
  const stablePrefix = `${sessionId}:`
  const legacyPrefix = `${instanceId}:${sessionId}:`
  let changed = false
  for (const key of promptDisplayOverrides.keys()) {
    if (key.startsWith(stablePrefix) || key.startsWith(legacyPrefix)) {
      promptDisplayOverrides.delete(key)
      changed = true
    }
  }
  if (!changed) return
  persist()
}

export function clearPromptDisplayOverridesForInstance(instanceId: string, sessionIds: string[] = []): void {
  ensureLoaded()
  let changed = false
  for (const key of promptDisplayOverrides.keys()) {
    const shouldDeleteStableKey = sessionIds.some((sessionId) => key.startsWith(`${sessionId}:`))
    const shouldDeleteLegacyKey = key.startsWith(`${instanceId}:`)
    if (shouldDeleteStableKey || shouldDeleteLegacyKey) {
      promptDisplayOverrides.delete(key)
      changed = true
    }
  }
  if (!changed) return
  persist()
}

export function resetPromptDisplayOverrideStateForTests(): void {
  loaded = false
  promptDisplayOverrides.clear()
}
