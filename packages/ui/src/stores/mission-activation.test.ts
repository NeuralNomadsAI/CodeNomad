import assert from "node:assert/strict"
import { test } from "node:test"
import type { PluginControlsState } from "./plugin-controls"
import { missionActivationStatus } from "./mission-activation"

test("Missions activation treats any pending or failed read as unknown, even with a cached value", () => {
  const state = (effective: "enabled" | "disabled"): PluginControlsState => ({
    loading: false, refreshing: false, stale: false,
    snapshot: { location: { directory: "/project" }, runtime: [], configured: { rules: [], sources: [] }, targets: [],
      controls: [{ id: "codenomad.missions", managedBy: "codenomad", builtin: false, global: effective, project: "default", effective }] },
  })
  assert.equal(missionActivationStatus(), "unknown")
  for (const value of ["enabled", "disabled"] as const) {
    const known = state(value)
    assert.equal(missionActivationStatus(known), value)
    for (const invalidated of [{ loading: true }, { refreshing: true }, { stale: true }, { error: new Error("503") }]) {
      assert.equal(missionActivationStatus({ ...known, ...invalidated }), "unknown")
    }
  }
})
