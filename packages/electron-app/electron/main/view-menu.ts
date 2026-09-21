import type { BrowserWindow, Menu, MenuItemConstructorOptions } from "electron"

const entries = [
  ["leftPanel", "view-left-panel"],
  ["rightPanel", "view-right-panel"],
  ["timeline", "view-timeline"],
  ["timelineTools", "view-timeline-tools"],
] as const

type Entry = { label: string; checked: boolean; enabled: boolean }
type ViewMenuState = Record<(typeof entries)[number][0], Entry>
const states = new Map<number, ViewMenuState>()

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
  states.set(windowId, state)
}

export function updateViewMenu(menu: Menu | null, window: BrowserWindow | null): void {
  const state = window ? states.get(window.webContents.id) : undefined
  for (const [key, id] of entries) {
    const item = menu?.getMenuItemById(id)
    if (!item) continue
    if (state) item.label = state[key].label
    item.checked = state?.[key].checked ?? false
    item.enabled = state?.[key].enabled ?? false
  }
}

export function viewMenuItems(sendCommand: (id: string) => () => void): MenuItemConstructorOptions[] {
  return entries.flatMap(([key, id]): MenuItemConstructorOptions[] => [
    ...(key === "timeline" ? [{ type: "separator" as const }] : []),
    { id, label: "", type: "checkbox", enabled: false, checked: false, click: sendCommand(id) },
  ])
}
