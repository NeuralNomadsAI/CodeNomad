import type { PromptDisplayMetadata } from "../lib/prompt-display-metadata"
import { estimateRetainedBytes } from "../lib/retained-size"

const STORAGE_KEY = "codenomad:prompt-display:v3"
const LEGACY_STORAGE_KEY = "codenomad:prompt-display:v2"
const ENTRY_LIMIT = 512
const BYTE_LIMIT = 1024 * 1024
const ENTRY_BYTE_LIMIT = 64 * 1024

let loaded = false
const promptDisplayOverrides = new Map<string, PromptDisplayMetadata>()
const promptDisplayOverrideBytes = new Map<string, number>()
let retainedBytes = 0

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
    const raw = storage.getItem(STORAGE_KEY)
    if (raw) {
      loadStoredEntries(JSON.parse(raw) as Record<string, PromptDisplayMetadata>, false)
    }
    const legacyRaw = storage.getItem(LEGACY_STORAGE_KEY)
    if (legacyRaw) {
      loadStoredEntries(JSON.parse(legacyRaw) as Record<string, PromptDisplayMetadata>, true)
    }
    if (!raw && !legacyRaw) return
    if (persist() && legacyRaw) storage.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    promptDisplayOverrides.clear()
    promptDisplayOverrideBytes.clear()
    retainedBytes = 0
  }
}

function loadStoredEntries(parsed: Record<string, PromptDisplayMetadata>, migrateLegacyKeys: boolean): void {
  for (const [key, value] of Object.entries(parsed)) {
    if (isPromptDisplayMetadata(value)) setEntry(migrateLegacyKeys ? migrateStoredKey(key) : key, value)
  }
}

function deleteEntry(key: string): boolean {
  const bytes = promptDisplayOverrideBytes.get(key)
  if (bytes === undefined) return false
  retainedBytes -= bytes
  promptDisplayOverrideBytes.delete(key)
  promptDisplayOverrides.delete(key)
  return true
}

function setEntry(key: string, value: PromptDisplayMetadata): boolean {
  const bytes = key.length * 2 + estimateRetainedBytes(value, ENTRY_BYTE_LIMIT)
  if (bytes > ENTRY_BYTE_LIMIT) return false
  deleteEntry(key)
  promptDisplayOverrides.set(key, value)
  promptDisplayOverrideBytes.set(key, bytes)
  retainedBytes += bytes
  while (promptDisplayOverrides.size > ENTRY_LIMIT || retainedBytes > BYTE_LIMIT) {
    const oldest = promptDisplayOverrides.keys().next().value
    if (oldest === undefined) break
    deleteEntry(oldest)
  }
  return promptDisplayOverrides.has(key)
}

function persist(): boolean {
  const storage = readStorage()
  if (!storage) return false

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(promptDisplayOverrides)))
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
  const key = makeKey(instanceId, sessionId, messageId)
  const value = promptDisplayOverrides.get(key)
  if (value) {
    promptDisplayOverrides.delete(key)
    promptDisplayOverrides.set(key, value)
  }
  return value
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
    if (!setEntry(key, displayMetadata)) return
  } else {
    if (!deleteEntry(key)) return
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
  if (!setEntry(newKey, nextValue)) return
  deleteEntry(oldKey)
  persist()
}

export function clearPromptDisplayOverride(instanceId: string, sessionId: string, messageId: string): void {
  ensureLoaded()
  if (!deleteEntry(makeKey(instanceId, sessionId, messageId))) {
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
      deleteEntry(key)
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
      deleteEntry(key)
      changed = true
    }
  }
  if (!changed) return
  persist()
}

export function resetPromptDisplayOverrideStateForTests(): void {
  loaded = false
  promptDisplayOverrides.clear()
  promptDisplayOverrideBytes.clear()
  retainedBytes = 0
}
