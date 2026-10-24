import assert from "node:assert/strict"
import { test } from "node:test"
import { nativeMenuLabels, setViewMenuState, updateViewMenu, viewMenuItems } from "./view-menu"

test("view menu snapshots follow the target window and clear on reload/close", () => {
  const clicks: string[] = []
  let items = viewMenuItems(id => () => { clicks.push(id) }, null)
  const menu = { getMenuItemById: (id: string) => items.find(item => item.id === id) }
  const state = (checked: boolean) => Object.fromEntries(["leftPanel", "rightPanel", "timeline"].map(key => [key, {
    label: `${key}-${checked}`, checked, enabled: true,
  }]))
  setViewMenuState(1, state(true))
  setViewMenuState(2, state(false))
  const update = (id: number | null) => {
    const window = id === null ? null : { webContents: { id } } as any
    if (updateViewMenu(menu as any, window)) items = viewMenuItems(id => () => { clicks.push(id) }, window)
  }
  update(1)
  assert.equal(menu.getMenuItemById("view-left-panel")?.checked, true)
  update(2)
  assert.equal(menu.getMenuItemById("view-left-panel")?.checked, false)
  assert.equal(menu.getMenuItemById("view-left-panel")?.label, "leftPanel-false")
  update(null)
  assert.ok(items.filter(item => item.id).every(item => !item.enabled))
  setViewMenuState(1, undefined)
  update(1)
  assert.ok(items.filter(item => item.id).every(item => !item.enabled && !item.checked))
  assert.throws(() => setViewMenuState(2, { leftPanel: { label: "bad" } }), /Invalid view menu/)
  update(2)
  assert.equal(menu.getMenuItemById("view-left-panel")?.enabled, true, "invalid update does not replace the last valid state")
  ;(menu.getMenuItemById("view-timeline")!.click as () => void)()
  assert.deepEqual(clicks, ["view-timeline"])
  setViewMenuState(2, undefined)
})

test("native menu labels follow the target window's locale and keep it for windows without one", () => {
  const view = Object.fromEntries(["leftPanel", "rightPanel", "timeline"].map(key => [key, { label: key, checked: false, enabled: true }]))
  const win = (id: number) => ({ webContents: { id } }) as any
  assert.equal(nativeMenuLabels(null).undo, "Undo", "English before any renderer reports")
  setViewMenuState(11, { ...view, menuLabels: { undo: "Annuler", about: "À propos de CodeNomad", unknown: "ignored" } })
  setViewMenuState(12, { ...view, menuLabels: { undo: "Rückgängig" } })
  assert.equal(nativeMenuLabels(win(11)).undo, "Annuler")
  assert.equal(nativeMenuLabels(win(11)).copy, "Copy", "missing keys keep the English default")
  assert.equal(nativeMenuLabels(win(12)).undo, "Rückgängig")
  setViewMenuState(13, view)
  assert.equal(nativeMenuLabels(win(13)).undo, "Rückgängig", "a window without labels keeps the last locale")
  const built = JSON.stringify(nativeMenuLabels(win(12)))
  const items = viewMenuItems(() => () => {}, win(12))
  const menu = { getMenuItemById: (id: string) => items.find(item => item.id === id) } as any
  assert.equal(updateViewMenu(menu, win(12), built), false)
  assert.equal(updateViewMenu(menu, win(11), built), true, "a locale change rebuilds the menu")
  for (const menuLabels of [{ undo: "" }, { undo: 1 }, { undo: "x".repeat(201) }, "labels"]) {
    assert.throws(() => setViewMenuState(14, { ...view, menuLabels }), /Invalid native menu label/)
  }
  if (process.platform !== "darwin") {
    setViewMenuState(15, { ...view, menuLabels: { copy: "Copy & paste" } })
    assert.equal(nativeMenuLabels(win(15)).copy, "Copy && paste", "a literal & is not a mnemonic")
  }
  for (const id of [11, 12, 13, 15]) setViewMenuState(id, undefined)
})
