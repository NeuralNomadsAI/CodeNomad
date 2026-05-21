import type { PromptDisplayMetadata } from "../lib/prompt-display-metadata"

const STORAGE_KEY = "codenomad:prompt-display:v3"

let loaded = false
const promptDisplayOverrides = new Map<string, PromptDisplayMetadata>()

function makeKey(_instanceId: string, sessionId: string, messageId: string): string {
  return `${sessionId}:${messageId}`
}

function isLegacyInstanceScopedKey(key: string): boolean {
  return key.split(":").length === 3
}

function migrateStoredKey(key: string): string {
  if (!isLegacyInstanceScopedKey(key)) {
    return key
  }
  const [, sessionId, messageId] = key.split(":")
  if (!sessionId || !messageId) {
    return key
  }
  return `${sessionId}:${messageId}`
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
    const parsedEntries: Record<string, PromptDisplayMetadata>[] = []
    const raw = storage.getItem(STORAGE_KEY)
    if (raw) {
      parsedEntries.push(JSON.parse(raw) as Record<string, PromptDisplayMetadata>)
    }
    const legacyRaw = storage.getItem("codenomad:prompt-display:v2")
    if (legacyRaw) {
      parsedEntries.push(JSON.parse(legacyRaw) as Record<string, PromptDisplayMetadata>)
    }
    if (parsedEntries.length === 0) return
    for (const parsed of parsedEntries) {
      for (const [key, value] of Object.entries(parsed)) {
        if (isPromptDisplayMetadata(value)) {
          promptDisplayOverrides.set(migrateStoredKey(key), value)
        }
      }
    }
    persist()
  } catch {
    promptDisplayOverrides.clear()
  }
}

function persist(): void {
  const storage = readStorage()
  if (!storage) return

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(promptDisplayOverrides)))
  } catch {
    // Ignore persistence failures.
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
