import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { getBrowserFramePolicy } from "./browser-frame-security.ts"

describe("getBrowserFramePolicy", () => {
  it("isolates local native frames from the parent bridge", () => {
    for (const host of ["electron", "tauri"] as const) {
      const policy = getBrowserFramePolicy({ host, windowContext: "local" })
      const permissions = new Set(policy.sandbox?.split(" "))

      assert.deepEqual(permissions, new Set(["allow-scripts", "allow-forms", "allow-modals", "allow-popups", "allow-downloads"]))
      assert.equal(permissions.has("allow-same-origin"), false)
      assert.equal([...permissions].some((permission) => permission.startsWith("allow-top-navigation")), false)
      assert.equal(policy.canInspectDom, false)
    }
  })

  it("preserves same-origin DOM inspection in standalone web mode", () => {
    assert.deepEqual(getBrowserFramePolicy({ host: "web", windowContext: "remote" }), {
      sandbox: undefined,
      canInspectDom: true,
    })
  })
})
