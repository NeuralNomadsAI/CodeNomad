import { createSignal } from "solid-js"
import { readClientLayoutValue, writeClientLayoutValue } from "../../stores/client-state"

const STORAGE_KEY = "opencode-session-prompt-input-height-v1"
const AUTO_HEIGHT = "auto"
const MAX_STORED_HEIGHT = 10_000

const [promptInputHeight, setPromptInputHeightValue] = createSignal<number | null>(null)
let initialized = false

export function parsePromptInputHeight(value: string | null): number | null {
  if (value === null || value === AUTO_HEIGHT || !/^\d+$/.test(value)) return null
  const height = Number(value)
  return height > 0 && height <= MAX_STORED_HEIGHT ? height : null
}

export function initializePromptInputHeight(
  read: (key: string) => string | null = readClientLayoutValue,
): void {
  if (initialized) return
  initialized = true
  setPromptInputHeightValue(parsePromptInputHeight(read(STORAGE_KEY)))
}

export function setPromptInputHeight(value: number | null): void {
  initialized = true
  setPromptInputHeightValue(value)
}

export function persistPromptInputHeight(
  value: number | null = promptInputHeight(),
  write: (key: string, value: string) => void = writeClientLayoutValue,
): void {
  setPromptInputHeight(value)
  write(STORAGE_KEY, value === null ? AUTO_HEIGHT : String(Math.round(value)))
}

export { promptInputHeight }
