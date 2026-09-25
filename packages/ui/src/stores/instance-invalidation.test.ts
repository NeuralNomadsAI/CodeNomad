import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { getInstanceRefreshTargets } from "./instance-invalidation.ts"

describe("instance invalidation targets", () => {
  it("keeps narrow catalog events narrow", () => {
    assert.deepEqual(getInstanceRefreshTargets("agent.updated"), ["agents"])
    assert.deepEqual(getInstanceRefreshTargets("command.updated"), ["commands"])
    assert.deepEqual(getInstanceRefreshTargets("models-dev.refreshed"), ["agents", "providers", "commands"])
    assert.deepEqual(getInstanceRefreshTargets("model.updated"), ["providers"])
    assert.deepEqual(getInstanceRefreshTargets("plugin.updated"), ["agents", "providers", "commands"])
    assert.deepEqual(getInstanceRefreshTargets("plugin.added"), [])
  })

  it("refreshes only state affected by metadata and filesystem events", () => {
    assert.deepEqual(getInstanceRefreshTargets("integration.updated"), ["providers", "metadata"])
    assert.deepEqual(getInstanceRefreshTargets("credential.updated"), ["providers", "metadata"])
    assert.deepEqual(getInstanceRefreshTargets("filesystem.changed"), ["filesystem"])
    assert.deepEqual(getInstanceRefreshTargets("vcs.branch.updated"), ["filesystem", "metadata"])
    assert.deepEqual(getInstanceRefreshTargets("session.text.delta"), [])
  })
})
