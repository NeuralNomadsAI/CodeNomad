import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  applyRightPanelItemCustomization,
  collectRightPanelItems,
  moveRightPanelItem,
  parseRightPanelCustomization,
  reorderStatusSections,
  setRightPanelItemHidden,
  type RightPanelItem,
  type RightPanelModule,
  type RightPanelTabModule,
} from "./registry"

const item = (id: string, order: number, alwaysVisible = false): RightPanelItem => ({ id, labelKey: id, order, alwaysVisible })
const tab = (id: string, order: number): RightPanelTabModule => ({ ...item(id, order), render: () => undefined as any })
const module = (id: string, tabs: RightPanelTabModule[]): RightPanelModule => ({ id, displayNameKey: id, origin: "first-party", tabs })

describe("right panel registry", () => {
  it("collects and orders module items", () => {
    const items = collectRightPanelItems(
      [
        module("core", [tab("status", 40), tab("changes", 10)]),
        module("plugin", [tab("custom", 30)]),
      ],
      "tabs",
    )

    assert.deepEqual(items.map((entry) => entry.id), ["changes", "custom", "status"])
  })

  it("rejects duplicate item ids", () => {
    assert.throws(() => collectRightPanelItems([module("core", [tab("status", 10), tab("status", 20)])], "tabs"))
  })

  it("applies visibility and user order", () => {
    const visible = applyRightPanelItemCustomization(
      [item("changes", 10), item("files", 20), item("status", 30)],
      ["status", "changes"],
      ["files"],
    )

    assert.deepEqual(visible.map((entry) => entry.id), ["status", "changes"])
  })

  it("keeps always-visible items visible", () => {
    const visible = applyRightPanelItemCustomization([item("configure", 100, true)], [], ["configure"])

    assert.deepEqual(visible.map((entry) => entry.id), ["configure"])
  })

  it("moves items in the shown order", () => {
    assert.deepEqual(moveRightPanelItem(["changes", "status", "files"], ["changes", "status", "files"], "status", -1), [
      "status",
      "changes",
      "files",
    ])
    assert.deepEqual(moveRightPanelItem([], ["changes", "status"], "changes", -1), ["changes", "status"])
  })

  it("moves only the source section and keeps unknown and hidden ids in place", () => {
    const saved = ["plan", "tokens", "mcp", "integration:gone", "plugins", "yolo-mode"]
    // `yolo-mode` is hidden: the drag sees only the shown sections.
    assert.deepEqual(reorderStatusSections(saved, ["tokens", "mcp", "plugins"], "plugins", "tokens"),
      ["plan", "plugins", "tokens", "mcp", "integration:gone", "yolo-mode"])
    assert.deepEqual(reorderStatusSections(saved, ["tokens", "mcp", "plugins"], "tokens", "plugins"),
      ["plan", "mcp", "integration:gone", "plugins", "tokens", "yolo-mode"])
    assert.deepEqual(moveRightPanelItem(saved, ["tokens", "mcp", "plugins", "yolo-mode"], "plugins", 1),
      ["plan", "tokens", "mcp", "integration:gone", "yolo-mode", "plugins"])
  })

  it("materializes shown sections without a rank next to their shown predecessor", () => {
    assert.deepEqual(reorderStatusSections(["integration:gone"], ["tokens", "mcp", "plugins"], "plugins", "mcp"),
      ["tokens", "plugins", "mcp", "integration:gone"])
  })

  it("places an unranked integration after Plugins and the integrations that follow it", () => {
    const sections = [item("tokens", 0), item("mcp", 50), item("plugins", 60), item("background-processes", 40),
      { ...item("integration:blender", 61), after: "plugins" }, { ...item("integration:gaffer", 62), after: "plugins" }]
    const ids = (order: string[], hidden: string[] = []) => applyRightPanelItemCustomization(sections, order, hidden).map(entry => entry.id)
    assert.deepEqual(ids([]), ["tokens", "background-processes", "mcp", "plugins", "integration:blender", "integration:gaffer"])
    // A saved order from before both integrations were installed.
    assert.deepEqual(ids(["plugins", "tokens", "mcp", "background-processes"]),
      ["plugins", "integration:blender", "integration:gaffer", "tokens", "mcp", "background-processes"])
    // A ranked integration right after Plugins stays before the new one.
    assert.deepEqual(ids(["tokens", "plugins", "integration:gaffer", "mcp", "background-processes"]),
      ["tokens", "plugins", "integration:gaffer", "integration:blender", "mcp", "background-processes"])
    // A hidden anchor still places the integration.
    assert.deepEqual(ids(["plugins", "tokens", "mcp", "background-processes"], ["plugins"]),
      ["integration:blender", "integration:gaffer", "tokens", "mcp", "background-processes"])
  })

  it("restores an integration's position and visibility after it was momentarily absent", () => {
    const saved = parseRightPanelCustomization(JSON.stringify({
      statusSectionOrder: ["integration:blender", "tokens", "plugins"], hiddenStatusSectionIds: ["integration:blender"],
    }))
    const reordered = reorderStatusSections(saved.statusSectionOrder, ["tokens", "plugins"], "plugins", "tokens")
    assert.deepEqual(reordered, ["integration:blender", "plugins", "tokens"])
    assert.deepEqual(setRightPanelItemHidden(saved.hiddenStatusSectionIds, "tokens", true), ["integration:blender", "tokens"])
    const back = [item("tokens", 0), item("plugins", 60), { ...item("integration:blender", 61), after: "plugins" }]
    assert.deepEqual(applyRightPanelItemCustomization(back, reordered, []).map(entry => entry.id), ["integration:blender", "plugins", "tokens"])
    assert.deepEqual(applyRightPanelItemCustomization(back, reordered, saved.hiddenStatusSectionIds).map(entry => entry.id), ["plugins", "tokens"])
  })

  it("parses invalid customization safely", () => {
    assert.deepEqual(parseRightPanelCustomization("{"), {
      tabOrder: [],
      hiddenTabIds: [],
      statusSectionOrder: [],
      hiddenStatusSectionIds: [],
    })
  })

  it("toggles hidden ids", () => {
    assert.deepEqual(setRightPanelItemHidden(["files"], "status", true), ["files", "status"])
    assert.deepEqual(setRightPanelItemHidden(["files"], "files", false), [])
  })
})
