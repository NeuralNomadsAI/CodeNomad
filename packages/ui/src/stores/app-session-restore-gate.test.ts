import assert from "node:assert/strict"
import { it } from "node:test"

import { shouldShowEmptyAppHome } from "./app-session-restore-gate.ts"

const tab = { kind: "sidecar" as const, sidecarId: "preview" }

it("hides the empty-app home while saved tabs are restoring", () => {
  assert.equal(shouldShowEmptyAppHome({ tabs: [tab], activeTabIndex: 0 }, true), false)
  assert.equal(shouldShowEmptyAppHome({ tabs: [tab], activeTabIndex: 0, homeActive: true }, true), true)
  assert.equal(shouldShowEmptyAppHome({ tabs: [], activeTabIndex: -1 }, true), true)
  assert.equal(shouldShowEmptyAppHome({ tabs: [tab], activeTabIndex: 0 }, false), true)
})
