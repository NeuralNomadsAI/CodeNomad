import type { BrowserWindow, Menu, MenuItemConstructorOptions } from "electron"
import { NATIVE_MENU_LABEL_KEYS, type NativeMenuLabels } from "../../../ui/src/lib/native/menu-labels"
import { DEFAULT_NATIVE_MENU_LABELS } from "../../../ui/src/lib/native/menu-labels-en"

const entries = [
  ["leftPanel", "view-left-panel"],
  ["rightPanel", "view-right-panel"],
  ["timeline", "view-timeline"],
  ["timelineTools", "view-timeline-tools"],
] as const

type Entry = { label: string; checked: boolean; enabled: boolean }
type ViewMenuState = Record<(typeof entries)[number][0], Entry> & { labels?: Partial<NativeMenuLabels> }
const states = new Map<number, ViewMenuState>()
// A window without its own snapshot (loading, sign-in) keeps the last locale
// instead of flipping the whole menu back to English.
let lastLabels: Partial<NativeMenuLabels> | undefined

function parseLabels(value: unknown): Partial<NativeMenuLabels> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object") throw new Error("Invalid native menu labels")
  const labels: Partial<NativeMenuLabels> = {}
  for (const key of Object.keys(NATIVE_MENU_LABEL_KEYS) as (keyof NativeMenuLabels)[]) {
    const label = (value as Record<string, unknown>)[key]
    if (label === undefined) continue
    if (typeof label !== "string" || !label.trim() || label.length > 200) throw new Error("Invalid native menu label")
    labels[key] = label
  }
  return labels
}

export function setViewMenuState(windowId: number, value: unknown): void {
  if (value === undefined) {
    states.delete(windowId)
    return
  }
  if (!value || typeof value !== "object") throw new Error("Invalid view menu state")
  const state = {} as ViewMenuState
  for (const [key] of entries) {
    const item = (value as Record<string, Partial<Entry>>)[key]
    if (!item || typeof item.label !== "string" || item.label.length > 200
      || typeof item.checked !== "boolean" || typeof item.enabled !== "boolean") {
      throw new Error("Invalid view menu item")
    }
    state[key] = { label: item.label, checked: item.checked, enabled: item.enabled }
  }
  state.labels = parseLabels((value as { menuLabels?: unknown }).menuLabels)
  states.set(windowId, state)
}

/** Labels for the whole application menu, following the target window's locale. */
export function nativeMenuLabels(window: BrowserWindow | null): NativeMenuLabels {
  const labels = (window ? states.get(window.webContents.id)?.labels : undefined) ?? lastLabels
  if (labels) lastLabels = labels
  const merged = { ...DEFAULT_NATIVE_MENU_LABELS, ...labels }
  // Windows and Linux read "&" as a mnemonic marker.
  if (process.platform === "darwin") return merged
  return Object.fromEntries(Object.entries(merged).map(([key, label]) => [key, label.replace(/&/g, "&&")])) as NativeMenuLabels
}

// Labels are captured in Electron's native model at insertion time. Return true
// when the caller must rebuild; checked/enabled can be updated in place.
export function updateViewMenu(menu: Menu | null, window: BrowserWindow | null, builtLabels?: string): boolean {
  if (builtLabels !== undefined && JSON.stringify(nativeMenuLabels(window)) !== builtLabels) return true
  const state = window ? states.get(window.webContents.id) : undefined
  if (state && entries.some(([key, id]) => menu?.getMenuItemById(id)?.label !== state[key].label)) return true
  for (const [key, id] of entries) {
    const item = menu?.getMenuItemById(id)
    if (!item) continue
    item.checked = state?.[key].checked ?? false
    item.enabled = state?.[key].enabled ?? false
  }
  return false
}

export function viewMenuItems(sendCommand: (id: string) => () => void, window: BrowserWindow | null): MenuItemConstructorOptions[] {
  const state = window ? states.get(window.webContents.id) : undefined
  // Do not insert unnamed items before the first localized renderer snapshot.
  if (!state) return []
  return entries.flatMap(([key, id]): MenuItemConstructorOptions[] => [
    ...(key === "timeline" ? [{ type: "separator" as const }] : []),
    { id, ...state[key], type: "checkbox", click: sendCommand(id) },
  ])
}
