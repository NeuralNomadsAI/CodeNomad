import { createSignal } from "solid-js"
import { readClientLayoutValue, writeClientLayoutValue } from "../../stores/client-state"

const STORAGE_KEY = "opencode-session-prompt-input-height-v1"
const AUTO_HEIGHT = "auto"
const MAX_STORED_HEIGHT = 10_000
export const MIN_PROMPT_FIELD_HEIGHT_RATIO = 0.08
export const MAX_PROMPT_FIELD_HEIGHT_RATIO = 0.6

// Numbers are legacy pixel heights, converted once the composer is measured.
type PromptInputHeight = number | { ratio: number } | null
const [promptInputHeight, setPromptInputHeightValue] = createSignal<PromptInputHeight>(null)
let initialized = false

export function parsePromptInputHeight(value: string | null): PromptInputHeight {
  if (value?.startsWith("ratio:")) {
    const ratio = Number(value.slice(6))
    return Number.isFinite(ratio) && ratio >= MIN_PROMPT_FIELD_HEIGHT_RATIO && ratio <= MAX_PROMPT_FIELD_HEIGHT_RATIO ? { ratio } : null
  }
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

export function setPromptInputHeight(value: PromptInputHeight): void {
  initialized = true
  setPromptInputHeightValue(value)
}

export function persistPromptInputHeight(
  value: PromptInputHeight = promptInputHeight(),
  write: (key: string, value: string) => void = writeClientLayoutValue,
): void {
  setPromptInputHeight(value)
  write(STORAGE_KEY, value === null ? AUTO_HEIGHT
    : typeof value === "number" ? String(Math.round(value)) : `ratio:${value.ratio}`)
}

export { promptInputHeight }
