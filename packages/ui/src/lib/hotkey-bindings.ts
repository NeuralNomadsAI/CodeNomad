import { defaultHotkeyBindings, getHotkeyDefinitions, hotkeyDefinitions, isMacPlatform as macPlatform, type HotkeyDefinition } from "./hotkey-definitions"

export interface HotkeyBinding {
  key: string
  mod?: boolean
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  alt?: boolean
}
export type HotkeyOverrides = Record<string, HotkeyBinding[]>
export interface HotkeyKeyEvent {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}
const modifierKeys = new Set(["control", "ctrl", "meta", "shift", "alt", "altgraph", "unidentified", "dead", "process"])
const aliases: Record<string, string> = { esc: "escape", space: " ", spacebar: " ", bracketleft: "[", bracketright: "]", "{": "[", "}": "]" }
const canonicalKey = (key: string) => /^digit[0-9]$/i.test(key) ? key.slice(-1)
  : Object.prototype.hasOwnProperty.call(aliases, key.toLowerCase()) ? aliases[key.toLowerCase()] : key.toLowerCase()
const validKey = (key: unknown): key is string => typeof key === "string" && Boolean(key) && key.length <= 40
  && !/[\u0000-\u001f\u007f-\u009f]/.test(key) && !modifierKeys.has(key.toLowerCase())

/** Digits/brackets have one physical identity; all other keys stay logical.
 * Legacy layout symbols on these slots must be re-recorded: key-only storage
 * cannot infer their physical position without guessing a keyboard layout.
 */
export function hotkeyEventKey(event: Pick<HotkeyKeyEvent, "key" | "code">): string {
  const code = event.code ?? ""
  return /^(?:Digit[0-9]|BracketLeft|BracketRight)$/i.test(code) ? canonicalKey(code) : canonicalKey(event.key)
}

export function normalizeHotkeyOverrides(input: unknown): HotkeyOverrides {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  const output: HotkeyOverrides = {}
  for (const { id } of hotkeyDefinitions) {
    if (!Object.prototype.hasOwnProperty.call(input, id)) continue
    const bindings = (input as Record<string, unknown>)[id]
    if (!Array.isArray(bindings) || bindings.length > 8) continue
    const normalized: HotkeyBinding[] = []
    let valid = true
    for (const value of bindings) {
      if (!value || typeof value !== "object" || Array.isArray(value)) { valid = false; break }
      const source = value as Record<string, unknown>
      if (!validKey(source.key)) { valid = false; break }
      const binding: HotkeyBinding = { key: canonicalKey(source.key) }
      for (const modifier of ["mod", "ctrl", "meta", "shift", "alt"] as const) {
        if (source[modifier] !== undefined && typeof source[modifier] !== "boolean") valid = false
        if (source[modifier] === true) binding[modifier] = true
      }
      if (!normalized.some(item => JSON.stringify(item) === JSON.stringify(binding))) normalized.push(binding)
    }
    // Invalid data restores defaults; it must not silently disable an action.
    if (valid) output[id] = normalized
  }
  return output
}

export function resolveHotkeyBindings(id: string, overrides: HotkeyOverrides, submitOnEnter = true, mac = macPlatform()): HotkeyBinding[] {
  if (!hotkeyDefinitions.some(definition => definition.id === id)) return []
  const bindings = overrides && Object.prototype.hasOwnProperty.call(overrides, id)
    ? normalizeHotkeyOverrides({ [id]: overrides[id] })[id] : undefined
  return bindings ?? defaultHotkeyBindings(id, submitOnEnter, mac)
}

function modifiers(binding: HotkeyBinding, mac: boolean) {
  return { ctrl: Boolean(binding.ctrl || (binding.mod && !mac)), meta: Boolean(binding.meta || (binding.mod && mac)),
    shift: Boolean(binding.shift), alt: Boolean(binding.alt) }
}

export function matchesHotkeyBinding(binding: HotkeyBinding, event: HotkeyKeyEvent, mac = macPlatform()): boolean {
  if (!validKey(binding?.key) || typeof event?.key !== "string") return false
  const expected = modifiers(binding, mac)
  return hotkeyEventKey(event) === canonicalKey(binding.key)
    && event.ctrlKey === expected.ctrl && event.metaKey === expected.meta
    && event.shiftKey === expected.shift && event.altKey === expected.alt
}

export function formatHotkeyBinding(binding: HotkeyBinding, mac = macPlatform()): string {
  if (!validKey(binding?.key)) return ""
  const expected = modifiers(binding, mac)
  const names: Record<string, string> = { escape: "Esc", " ": "Space", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→", enter: "Enter", backspace: "Backspace", tab: "Tab", delete: "Delete" }
  const key = canonicalKey(binding.key)
  return [expected.ctrl && "Ctrl", expected.meta && (mac ? "⌘" : "Meta"), expected.alt && (mac ? "⌥" : "Alt"),
    expected.shift && (mac ? "⇧" : "Shift"), Object.prototype.hasOwnProperty.call(names, key) ? names[key] : key.toUpperCase()].filter(Boolean).join("+")
}

function bindingsOverlap(a: HotkeyBinding, b: HotkeyBinding, mac: boolean): boolean {
  const expected = modifiers(a, mac)
  // Matching is equality on this identity, so no layout-specific witnesses.
  return matchesHotkeyBinding(b, { key: canonicalKey(a.key), ctrlKey: expected.ctrl,
    metaKey: expected.meta, shiftKey: expected.shift, altKey: expected.alt }, mac)
}

function scopesOverlap(a: HotkeyDefinition, b: HotkeyDefinition): boolean {
  if (a.scope === "home" || b.scope === "home") return a.scope === b.scope || a.scope === "app" || b.scope === "app" || a.scope === "instance-tab" || b.scope === "instance-tab"
  // These controls cannot own focus simultaneously. Session/global actions can
  // still run in each of them and therefore genuinely overlap.
  const focused = ["composer", "aside", "search", "files", "instance-tab"]
  if (focused.includes(a.scope) && focused.includes(b.scope) && a.scope !== b.scope) return false
  const escapeModes = ["session-abort", "prompt-blur", "prompt-exit-shell"]
  if (escapeModes.includes(a.id) && escapeModes.includes(b.id)) return false
  return true
}

export function findHotkeyConflicts(overrides: HotkeyOverrides, submitOnEnter = true, mac = macPlatform()): { ids: string[]; binding: string }[] {
  // ponytail: pairwise scan of the bounded catalog; index combos if this grows materially.
  const conflicts = new Map<string, Set<string>>()
  const definitions = getHotkeyDefinitions()
  for (let i = 0; i < definitions.length; i++) {
    const a = definitions[i]
    for (const b of definitions.slice(i + 1)) {
      if (!scopesOverlap(a, b)) continue
      for (const binding of resolveHotkeyBindings(a.id, overrides, submitOnEnter, mac)) {
        if (!resolveHotkeyBindings(b.id, overrides, submitOnEnter, mac).some(other => bindingsOverlap(binding, other, mac))) continue
        const label = formatHotkeyBinding(binding, mac)
        const ids = conflicts.get(label) ?? new Set<string>()
        ids.add(a.id); ids.add(b.id); conflicts.set(label, ids)
      }
    }
  }
  return [...conflicts].map(([binding, ids]) => ({ binding, ids: [...ids] }))
}

export function hotkeyOverridePatch(id: string, bindings?: HotkeyBinding[]) {
  if (!hotkeyDefinitions.some(item => item.id === id)) throw new Error("Unknown hotkey action")
  const normalized = bindings === undefined ? undefined : normalizeHotkeyOverrides({ [id]: bindings })[id]
  if (bindings !== undefined && normalized === undefined) throw new Error("Invalid hotkey binding")
  return { settings: { hotkeyOverrides: { [id]: normalized ?? null } } }
}

export function resetHotkeyOverridesPatch() {
  return { settings: { hotkeyOverrides: null } }
}
