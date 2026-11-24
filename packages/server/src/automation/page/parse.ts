import { keyChord } from "./keys"

/** Page actions as tools receive them, with elements as refs from the latest inspection. Parsing is
 * idempotent, so the same flat command crosses the bridge and is validated again by the backend. */
export type RefAction =
  | { action: "click"; ref: string; button?: "left" | "right" }
  | { action: "type"; ref: string; text: string; clear: boolean }
  | { action: "select"; ref: string; values: string[] }
  | { action: "hover"; ref: string }
  | { action: "drag"; ref: string; to: string }
  | { action: "scroll"; ref?: string; direction: "up" | "down" | "left" | "right"; amount: number }
  | { action: "press"; key: string; ref?: string }
  | { action: "wait"; text: string; gone: boolean; timeout: number }

export const PAGE_ACTIONS = ["click", "type", "select", "hover", "drag", "scroll", "press", "wait"] as const
export const MAX_WAIT_MS = 15_000
const MAX_SELECT_VALUES = 64
const MAX_TEXT_LENGTH = 200
const MAX_SCROLL = 10_000

/** Validates one page action; `undefined` when `action` names no page action. */
export function parsePageAction(value: Record<string, unknown>, inspect: string): RefAction | undefined {
  const ref = (field = "ref") => {
    if (typeof value[field] !== "string" || !value[field]) throw new Error(`${value.action} requires ${field}: a ref from the latest ${inspect}`)
    return value[field] as string
  }
  const optionalRef = () => value.ref === undefined ? {} : { ref: ref() }
  switch (value.action) {
    case "click":
      if (value.button !== undefined && value.button !== "left" && value.button !== "right") throw new Error("click button must be left or right")
      return { action: "click", ref: ref(), ...(value.button === "right" ? { button: "right" as const } : {}) }
    case "type":
      if (typeof value.text !== "string") throw new Error("type requires ref and text")
      if (value.clear !== undefined && typeof value.clear !== "boolean") throw new Error("type clear must be true or false")
      return { action: "type", ref: ref(), text: value.text, clear: value.clear !== false }
    case "select":
      if (!Array.isArray(value.values) || value.values.length > MAX_SELECT_VALUES || !value.values.every(item => typeof item === "string")) {
        throw new Error("select requires ref and values: the option labels or values to choose")
      }
      return { action: "select", ref: ref(), values: value.values as string[] }
    case "hover":
      return { action: "hover", ref: ref() }
    case "drag":
      return { action: "drag", ref: ref(), to: ref("to") }
    case "scroll": {
      if (!["up", "down", "left", "right"].includes(value.direction as string)) throw new Error("scroll requires direction: up, down, left or right")
      const amount = value.amount ?? 600
      if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1 || amount > MAX_SCROLL) {
        throw new Error(`scroll amount must be a whole number of pixels from 1 to ${MAX_SCROLL}`)
      }
      return { action: "scroll", ...optionalRef(), direction: value.direction as "up" | "down" | "left" | "right", amount }
    }
    case "press":
      if (typeof value.key !== "string" || !value.key) throw new Error("press requires key, such as Enter, Escape, Tab, ArrowDown or Control+K")
      keyChord(value.key)
      return { action: "press", key: value.key, ...optionalRef() }
    case "wait": {
      if (typeof value.text !== "string" || !value.text.trim() || value.text.length > MAX_TEXT_LENGTH) {
        throw new Error(`wait requires text of at most ${MAX_TEXT_LENGTH} characters`)
      }
      if (value.gone !== undefined && typeof value.gone !== "boolean") throw new Error("wait gone must be true or false")
      const timeout = value.timeout ?? 5_000
      if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 0 || timeout > MAX_WAIT_MS) {
        throw new Error(`wait timeout must be a whole number of milliseconds from 0 to ${MAX_WAIT_MS}`)
      }
      return { action: "wait", text: value.text, gone: value.gone === true, timeout }
    }
    default:
      return undefined
  }
}

/** JSON Schema properties shared by the tools that accept page actions. */
export const PAGE_ACTION_PROPERTIES = {
  ref: { type: "string", description: "Element ref from the latest inspection (optional for scroll and press)" },
  text: { type: "string", description: "type: text to enter; wait: text to wait for" },
  clear: { type: "boolean", description: "type only: replace the field's current text (default true); false appends" },
  values: { type: "array", items: { type: "string" }, description: "select only: option labels or values to choose; one for an ordinary select" },
  button: { type: "string", enum: ["left", "right"], description: "click only: mouse button (default left)" },
  to: { type: "string", description: "drag only: ref of the element to drop onto" },
  direction: { type: "string", enum: ["up", "down", "left", "right"], description: "scroll only" },
  amount: { type: "integer", minimum: 1, maximum: MAX_SCROLL, description: "scroll only: pixels (default 600)" },
  key: { type: "string", description: "press only: a key or chord such as Enter, Escape, Tab, Shift+Tab, ArrowDown, a, Control+K or Mod+K (Meta on macOS)" },
  gone: { type: "boolean", description: "wait only: wait until the text disappears instead" },
  timeout: { type: "integer", minimum: 0, maximum: MAX_WAIT_MS, description: "wait only: milliseconds (default 5000)" },
} as const
