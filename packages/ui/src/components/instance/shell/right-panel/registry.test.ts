import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  applyRightPanelItemCustomization,
  collectRightPanelItems,
  moveRightPanelItem,
  parseRightPanelCustomization,
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

  it("moves items in normalized order", () => {
    assert.deepEqual(moveRightPanelItem(["changes", "status", "files"], ["changes", "files", "status"], "status", -1), [
      "status",
      "changes",
      "files",
    ])
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
