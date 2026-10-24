/** Keyboard chords for `press`, as DevTools `Input.dispatchKeyEvent` sequences. */

interface KeyDefinition {
  key: string
  code: string
  keyCode: number
  /** Text a plain press inserts (Enter submits forms and breaks lines). */
  text?: string
  location?: number
}

export interface KeyEvent extends Record<string, unknown> {
  type: "keyDown" | "rawKeyDown" | "keyUp"
  key: string
  code: string
  windowsVirtualKeyCode: number
  modifiers: number
  text?: string
  unmodifiedText?: string
  location?: number
}

const MODIFIERS: Record<string, { definition: KeyDefinition; bit: number }> = {
  Alt: { definition: { key: "Alt", code: "AltLeft", keyCode: 18, location: 1 }, bit: 1 },
  Control: { definition: { key: "Control", code: "ControlLeft", keyCode: 17, location: 1 }, bit: 2 },
  Meta: { definition: { key: "Meta", code: "MetaLeft", keyCode: 91, location: 1 }, bit: 4 },
  Shift: { definition: { key: "Shift", code: "ShiftLeft", keyCode: 16, location: 1 }, bit: 8 },
}
const MODIFIER_ALIASES: Record<string, string> = { alt: "Alt", option: "Alt", control: "Control", ctrl: "Control",
  meta: "Meta", cmd: "Meta", command: "Meta", shift: "Shift" }

const NAMED: Record<string, KeyDefinition> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Insert: { key: "Insert", code: "Insert", keyCode: 45 },
  ContextMenu: { key: "ContextMenu", code: "ContextMenu", keyCode: 93 },
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, { key: `F${index + 1}`, code: `F${index + 1}`, keyCode: 112 + index }])),
}
const NAMED_ALIASES: Record<string, string> = { esc: "Escape", return: "Enter", del: "Delete", up: "ArrowUp", down: "ArrowDown",
  left: "ArrowLeft", right: "ArrowRight", pgup: "PageUp", pgdn: "PageDown", " ": "Space" }

/** US-layout punctuation: [code, key code, shifted character]. */
const PUNCTUATION: Record<string, [string, number, string?]> = {
  "`": ["Backquote", 192, "~"], "-": ["Minus", 189, "_"], "=": ["Equal", 187, "+"], "[": ["BracketLeft", 219, "{"],
  "]": ["BracketRight", 221, "}"], "\\": ["Backslash", 220, "|"], ";": ["Semicolon", 186, ":"], "'": ["Quote", 222, "\""],
  ",": ["Comma", 188, "<"], ".": ["Period", 190, ">"], "/": ["Slash", 191, "?"],
}
const SHIFTED_DIGITS = ")!@#$%^&*("

function character(value: string): KeyDefinition | undefined {
  if (value.length !== 1) return undefined
  if (/[a-z]/i.test(value)) return { key: value, code: `Key${value.toUpperCase()}`, keyCode: value.toUpperCase().charCodeAt(0), text: value }
  if (/[0-9]/.test(value)) return { key: value, code: `Digit${value}`, keyCode: value.charCodeAt(0), text: value }
  const shiftedDigit = SHIFTED_DIGITS.indexOf(value)
  if (shiftedDigit >= 0) return { key: value, code: `Digit${shiftedDigit}`, keyCode: 48 + shiftedDigit, text: value }
  for (const [base, [code, keyCode, shifted]] of Object.entries(PUNCTUATION)) {
    if (value === base || value === shifted) return { key: value, code, keyCode, text: value }
  }
  return undefined
}

/** Parses "Enter", "a", "Shift+Tab", "Control+Shift+K" or "Mod+K" (Meta on macOS, Control elsewhere). */
export function keyChord(chord: string, platform: NodeJS.Platform = process.platform): KeyEvent[] {
  const parts = chord === "+" ? ["+"] : chord.split("+").map(part => part.trim())
  if (!parts.length || parts.some(part => !part) || chord.length > 64) throw new Error(`Unknown key ${JSON.stringify(chord)}`)
  const main = parts.pop()!
  const modifiers: string[] = []
  for (const part of parts) {
    const name = part.toLowerCase() === "mod" ? (platform === "darwin" ? "Meta" : "Control") : MODIFIER_ALIASES[part.toLowerCase()]
    if (!name) throw new Error(`Unknown modifier ${JSON.stringify(part)} in ${JSON.stringify(chord)}; use Control, Shift, Alt, Meta or Mod`)
    if (!modifiers.includes(name)) modifiers.push(name)
  }
  const named = NAMED[main] ?? NAMED[NAMED_ALIASES[main.toLowerCase()] ?? ""]
    ?? Object.values(NAMED).find(definition => definition.key.toLowerCase() === main.toLowerCase() && definition.key.length > 1)
  let definition = named ?? character(main)
  if (!definition) throw new Error(`Unknown key ${JSON.stringify(main)}; use a character or a key name such as Enter, Escape, Tab or ArrowDown`)
  // Shift+a types "A", like a physical keyboard.
  if (modifiers.includes("Shift") && definition.text && /^[a-z]$/.test(definition.text)) {
    definition = { ...definition, key: definition.text.toUpperCase(), text: definition.text.toUpperCase() }
  }
  const events: KeyEvent[] = []
  let bits = 0
  for (const name of modifiers) {
    const { definition: modifier, bit } = MODIFIERS[name]
    bits |= bit
    events.push(keyEvent("rawKeyDown", modifier, bits))
  }
  // A shortcut types nothing; a plain or shifted press produces its text.
  const text = bits & ~MODIFIERS.Shift.bit ? undefined : definition.text
  events.push(keyEvent(text ? "keyDown" : "rawKeyDown", definition, bits, text))
  events.push(keyEvent("keyUp", definition, bits))
  for (const name of [...modifiers].reverse()) {
    const { definition: modifier, bit } = MODIFIERS[name]
    bits &= ~bit
    events.push(keyEvent("keyUp", modifier, bits))
  }
  return events
}

function keyEvent(type: KeyEvent["type"], definition: KeyDefinition, modifiers: number, text?: string): KeyEvent {
  return { type, key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode, modifiers,
    ...(text ? { text, unmodifiedText: text } : {}), ...(definition.location ? { location: definition.location } : {}) }
}
