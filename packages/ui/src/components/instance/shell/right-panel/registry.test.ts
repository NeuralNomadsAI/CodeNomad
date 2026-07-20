import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  applyRightPanelItemCustomization,
  collectRightPanelItems,
  moveRightPanelItem,
  parseRightPanelCustomization,
  setRightPanelItemHidden,
  type RightPanelItem,
  type RightPanelTabModule,
} from "./registry"

const item = (id: string, order: number, alwaysVisible = false): RightPanelItem => ({ id, labelKey: id, order, alwaysVisible })
const tab = (id: string, order: number): RightPanelTabModule => ({ ...item(id, order), render: () => undefined as any })

describe("right panel registry", () => {
  it("collects and orders module items", () => {
    const items = collectRightPanelItems(
      [
        { id: "core", tabs: [tab("status", 40), tab("changes", 10)] },
        { id: "plugin", tabs: [tab("custom", 30)] },
      ],
      "tabs",
    )

    assert.deepEqual(items.map((entry) => entry.id), ["changes", "custom", "status"])
  })

  it("rejects duplicate item ids", () => {
    assert.throws(() => collectRightPanelItems([{ id: "core", tabs: [tab("status", 10), tab("status", 20)] }], "tabs"))
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
