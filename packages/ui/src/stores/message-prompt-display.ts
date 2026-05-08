import type { HiddenPromptDisplayMetadata } from "../lib/hidden-prompt-sections"

const STORAGE_KEY = "codenomad:hidden-prompt-display:v1"

let loaded = false
const promptDisplayOverrides = new Map<string, HiddenPromptDisplayMetadata>()

function makeKey(instanceId: string, sessionId: string, messageId: string): string {
  return `${instanceId}:${sessionId}:${messageId}`
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
    if (!raw) return
    const parsed = JSON.parse(raw) as Record<string, HiddenPromptDisplayMetadata>
    for (const [key, value] of Object.entries(parsed)) {
      if (isPromptDisplayMetadata(value)) {
        promptDisplayOverrides.set(key, value)
      }
    }
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

function isPromptDisplayMetadata(value: unknown): value is HiddenPromptDisplayMetadata {
  if (!value || typeof value !== "object") return false
  const segments = (value as HiddenPromptDisplayMetadata).segments
  if (!Array.isArray(segments) || segments.length === 0) return false
  return segments.every(
    (segment) =>
      segment && typeof segment === "object" && typeof segment.hidden === "boolean" && typeof segment.length === "number" && segment.length >= 0,
  )
}

export function getPromptDisplayOverride(
  instanceId: string,
  sessionId: string,
  messageId: string,
): HiddenPromptDisplayMetadata | undefined {
  ensureLoaded()
  return promptDisplayOverrides.get(makeKey(instanceId, sessionId, messageId))
}

export function setPromptDisplayOverride(
  instanceId: string,
  sessionId: string,
  messageId: string,
  displayMetadata: HiddenPromptDisplayMetadata | undefined,
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
  const prefix = `${instanceId}:${sessionId}:`
  let changed = false
  for (const key of promptDisplayOverrides.keys()) {
    if (key.startsWith(prefix)) {
      promptDisplayOverrides.delete(key)
      changed = true
    }
  }
  if (!changed) return
  persist()
}

export function clearPromptDisplayOverridesForInstance(instanceId: string): void {
  ensureLoaded()
  const prefix = `${instanceId}:`
  let changed = false
  for (const key of promptDisplayOverrides.keys()) {
    if (key.startsWith(prefix)) {
      promptDisplayOverrides.delete(key)
      changed = true
    }
  }
  if (!changed) return
  persist()
}
