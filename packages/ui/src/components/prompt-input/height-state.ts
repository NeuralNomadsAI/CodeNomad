import { createSignal } from "solid-js"
import { readClientLayoutValue, writeClientLayoutValue } from "../../stores/client-state"

const STORAGE_KEY = "opencode-session-prompt-input-height-v1"
const AUTO_HEIGHT = "auto"
const MAX_STORED_HEIGHT = 10_000
export const MIN_PROMPT_FIELD_HEIGHT_RATIO = 0.08
export const MAX_PROMPT_FIELD_HEIGHT_RATIO = 0.6

// Numbers are legacy pixel heights, converted once the composer is measured.
type PromptInputHeight = number | { ratio: number } | null

// Each instance keeps its own height, like the side drawers. The stored value
// is only the starting height for instances that have not chosen one yet.
const [heights, setHeights] = createSignal<ReadonlyMap<string, PromptInputHeight>>(new Map())
let defaultHeight: PromptInputHeight = null
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

/** Pins the instance's height so later changes in other instances never move it. */
export function initializePromptInputHeight(
  instanceId: string,
  read: (key: string) => string | null = readClientLayoutValue,
): void {
  if (!initialized) {
    initialized = true
    defaultHeight = parsePromptInputHeight(read(STORAGE_KEY))
  }
  if (!heights().has(instanceId)) setPromptInputHeight(instanceId, defaultHeight)
}

export function promptInputHeight(instanceId: string): PromptInputHeight {
  const current = heights()
  return current.has(instanceId) ? current.get(instanceId)! : defaultHeight
}

export function setPromptInputHeight(instanceId: string, value: PromptInputHeight): void {
  setHeights((previous) => new Map(previous).set(instanceId, value))
}

export function persistPromptInputHeight(
  instanceId: string,
  value: PromptInputHeight = promptInputHeight(instanceId),
  write: (key: string, value: string) => void = writeClientLayoutValue,
): void {
  setPromptInputHeight(instanceId, value)
  defaultHeight = value
  write(STORAGE_KEY, value === null ? AUTO_HEIGHT
    : typeof value === "number" ? String(Math.round(value)) : `ratio:${value.ratio}`)
}
