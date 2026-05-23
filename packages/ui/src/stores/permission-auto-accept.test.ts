import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { shouldSubagentInheritPermissionAutoAcceptValue } from "./permission-auto-accept-rules.ts"

describe("subagent YOLO inheritance", () => {
  it("does not inherit when the persisted setting defaults to false", () => {
    assert.equal(shouldSubagentInheritPermissionAutoAcceptValue(
      { parentId: "parent", revert: undefined },
      false,
      true,
    ), false)
  })

  it("does not inherit when the setting is disabled", () => {
    assert.equal(
      shouldSubagentInheritPermissionAutoAcceptValue(
        { parentId: "parent", revert: undefined },
        false,
        true,
      ),
      false,
    )
  })

  it("inherits only for non-fork child sessions when parent YOLO is enabled", () => {
    assert.equal(
      shouldSubagentInheritPermissionAutoAcceptValue(
        { parentId: "parent", revert: undefined },
        true,
        true,
      ),
      true,
    )
    assert.equal(
      shouldSubagentInheritPermissionAutoAcceptValue(
        { parentId: "parent", revert: { messageID: "msg", partID: "part" } },
        true,
        true,
      ),
      false,
    )
  })

  it("restores previous approval behavior when disabled", () => {
    assert.equal(
      shouldSubagentInheritPermissionAutoAcceptValue(
        { parentId: "parent", revert: undefined },
        false,
        true,
      ),
      false,
    )
  })

  it("does not inherit when parent YOLO is disabled", () => {
    assert.equal(
      shouldSubagentInheritPermissionAutoAcceptValue(
        { parentId: "parent", revert: undefined },
        true,
        false,
      ),
      false,
    )
  })
})
