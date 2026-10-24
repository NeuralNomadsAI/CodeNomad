import { createSignal } from "solid-js"
import { preferences, patchHotkeyPreferences } from "../stores/preferences"
import { resolveHotkeyBindings, matchesHotkeyBinding, formatHotkeyBinding, hotkeyOverridePatch, resetHotkeyOverridesPatch, type HotkeyBinding } from "./hotkey-bindings"

const [isHotkeyRecording, setHotkeyRecording] = createSignal(false)
export { isHotkeyRecording, setHotkeyRecording }

export function effectiveHotkeyBindings(id: string): HotkeyBinding[] {
  const settings = preferences()
  return resolveHotkeyBindings(id, settings.hotkeyOverrides, settings.promptSubmitOnEnter)
}

export function hotkeyLabel(id: string): string {
  return effectiveHotkeyBindings(id).map(binding => formatHotkeyBinding(binding)).join(" / ")
}

/** Tooltip text: the label followed by its effective shortcut, if any. */
export function withHotkey(label: string, id: string): string {
  const shortcut = hotkeyLabel(id)
  return shortcut ? `${label} (${shortcut})` : label
}

export function matchesHotkey(id: string, event: KeyboardEvent): boolean {
  return !isHotkeyRecording() && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229
    && effectiveHotkeyBindings(id).some(binding => matchesHotkeyBinding(binding, event))
}

export async function saveHotkeyOverride(id: string, bindings?: HotkeyBinding[]): Promise<boolean> {
  try { return await patchHotkeyPreferences(hotkeyOverridePatch(id, bindings)) }
  catch { return false }
}

export function resetHotkeyOverrides(): Promise<boolean> {
  return patchHotkeyPreferences(resetHotkeyOverridesPatch())
}
