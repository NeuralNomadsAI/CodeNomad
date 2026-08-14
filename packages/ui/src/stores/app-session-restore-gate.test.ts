import assert from "node:assert/strict"
import { it } from "node:test"

import { shouldShowAppHomeOverlay, shouldShowAppRestoreLoading } from "./app-session-restore-gate.ts"

const tab = { kind: "sidecar" as const, sidecarId: "preview" }

it("shows loading while saved tabs are restoring", () => {
  assert.equal(shouldShowAppRestoreLoading({ tabs: [tab], activeTabIndex: 0 }, true), true)
  assert.equal(shouldShowAppRestoreLoading({ tabs: [tab], activeTabIndex: 0, homeActive: true }, true), false)
  assert.equal(shouldShowAppRestoreLoading({ tabs: [], activeTabIndex: -1 }, true), false)
  assert.equal(shouldShowAppRestoreLoading({ tabs: [tab], activeTabIndex: 0 }, false), false)
})

it("mounts the requested home overlay only when tabs exist", () => {
  assert.equal(shouldShowAppHomeOverlay(true, 0), false)
  assert.equal(shouldShowAppHomeOverlay(true, 1), true)
  assert.equal(shouldShowAppHomeOverlay(false, 1), false)
})
