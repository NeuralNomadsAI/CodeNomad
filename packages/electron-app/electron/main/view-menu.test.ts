import assert from "node:assert/strict"
import { test } from "node:test"
import { setViewMenuState, updateViewMenu, viewMenuItems } from "./view-menu"

test("view menu snapshots follow the target window and clear on reload/close", () => {
  const clicks: string[] = []
  const items = viewMenuItems(id => () => { clicks.push(id) })
  const menu = { getMenuItemById: (id: string) => items.find(item => item.id === id) }
  const state = (checked: boolean) => Object.fromEntries(["leftPanel", "rightPanel", "timeline", "timelineTools"].map(key => [key, {
    label: `${key}-${checked}`, checked, enabled: true,
  }]))
  setViewMenuState(1, state(true))
  setViewMenuState(2, state(false))
  updateViewMenu(menu as any, { webContents: { id: 1 } } as any)
  assert.equal(menu.getMenuItemById("view-left-panel")?.checked, true)
  updateViewMenu(menu as any, { webContents: { id: 2 } } as any)
  assert.equal(menu.getMenuItemById("view-left-panel")?.checked, false)
  assert.equal(menu.getMenuItemById("view-left-panel")?.label, "leftPanel-false")
  updateViewMenu(menu as any, null)
  assert.ok(items.filter(item => item.id).every(item => !item.enabled))
  setViewMenuState(1, undefined)
  updateViewMenu(menu as any, { webContents: { id: 1 } } as any)
  assert.ok(items.filter(item => item.id).every(item => !item.enabled && !item.checked))
  assert.throws(() => setViewMenuState(2, { leftPanel: { label: "bad" } }), /Invalid view menu/)
  updateViewMenu(menu as any, { webContents: { id: 2 } } as any)
  assert.equal(menu.getMenuItemById("view-left-panel")?.enabled, true, "invalid update does not replace the last valid state")
  ;(menu.getMenuItemById("view-timeline")!.click as () => void)()
  assert.deepEqual(clicks, ["view-timeline"])
  setViewMenuState(2, undefined)
})
