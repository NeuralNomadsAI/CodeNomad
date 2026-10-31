import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { PluginControlsSnapshot } from "../../../server/src/api-types"
import { PLUGIN_SOURCE_PENDING_TIMEOUT_MS, PluginSourcesStore, removableSources } from "./plugin-sources"

const location = { directory: "/repo" }

function harness(options: { failRemove?: boolean } = {}) {
  let now = 1_000
  const timers: Array<{ at: number; run: () => void }> = []
  const calls: unknown[] = []
  const invalidations: string[] = []
  const store = new PluginSourcesStore({
    addPluginSource: async (instanceId, payload) => { calls.push(["add", instanceId, payload]); return { scope: payload.scope, spec: payload.spec, reloadPending: true } },
    removePluginSource: async (instanceId, payload) => {
      calls.push(["remove", instanceId, payload])
      if (options.failRemove) throw new Error("stale")
      return { scope: payload.scope, spec: payload.target, reloadPending: true }
    },
  }, instanceId => invalidations.push(instanceId), () => now, (run, delay) => timers.push({ at: now + delay, run }))
  const advance = (ms: number) => {
    now += ms
    for (const timer of timers.splice(0).filter(item => item.at <= now)) timer.run()
  }
  return { store, calls, invalidations, advance }
}

describe("plugin sources store", () => {
  it("keeps an added source pending for the named window, then marks it not confirmed", async () => {
    const { store, calls, invalidations, advance } = harness()
    await store.add("instance", location, "global", "fixture-plugin@1")
    assert.deepEqual(calls, [["add", "instance", { location, scope: "global", spec: "fixture-plugin@1" }]])
    assert.deepEqual(invalidations, ["instance"], "the inventory, never the response, decides what loaded")
    assert.equal(store.state("instance", location, "fixture-plugin@1"), "pending")
    advance(PLUGIN_SOURCE_PENDING_TIMEOUT_MS)
    assert.equal(store.state("instance", location, "fixture-plugin@1"), "pending")
    advance(1)
    assert.equal(store.state("instance", location, "fixture-plugin@1"), "unconfirmed")
    assert.equal(store.state("instance", location, "never-added"), "unconfirmed")
    assert.equal(store.state("instance", { directory: "/other" }, "fixture-plugin@1"), "unconfirmed", "tracking is per location")
  })

  it("removes exactly the displayed declaration, tracks it while saving and forgets its pending add", async () => {
    const { store, calls, invalidations } = harness()
    await store.add("instance", location, "project", "fixture-plugin")
    const source = { target: "fixture-plugin", scope: "project" as const, path: "/repo/.opencode/opencode.jsonc", entryIndex: 2, hasOptions: false }
    const removal = store.remove("instance", location, source)
    assert.equal(store.isRemoving("instance", location, source), true)
    await store.remove("instance", location, source)
    await removal
    assert.equal(store.isRemoving("instance", location, source), false)
    assert.deepEqual(calls.slice(1), [["remove", "instance", { location, scope: "project", target: "fixture-plugin", entryIndex: 2 }]], "one request while saving")
    assert.equal(store.addedSpecs("instance", location).length, 0)
    assert.deepEqual(invalidations, ["instance", "instance"])
  })

  it("releases a failed removal and still reconciles", async () => {
    const { store, invalidations } = harness({ failRemove: true })
    const source = { target: "x", scope: "global" as const, path: "/g/opencode.jsonc", entryIndex: 0, hasOptions: false }
    await assert.rejects(store.remove("instance", location, source))
    assert.equal(store.isRemoving("instance", location, source), false)
    assert.deepEqual(invalidations, ["instance"])
  })

  it("forgets an instance's added sources when it stops", async () => {
    const { store } = harness()
    await store.add("instance", location, "global", "a")
    await store.add("other", location, "global", "b")
    store.clearInstance("instance")
    assert.deepEqual(store.addedSpecs("instance", location), [])
    assert.equal(store.addedSpecs("other", location).length, 1)
  })

  it("offers removal only for declarations in a scope's own write target", () => {
    const snapshot = {
      location, runtime: [], controls: [],
      targets: [{ scope: "global", path: "C:\\Users\\me\\.config\\opencode\\opencode.jsonc", exists: true },
        { scope: "project", path: "C:\\repo\\.opencode\\opencode.jsonc", exists: true }],
      configured: { rules: [], sources: [
        { target: "a", scope: "global", path: "c:/users/me/.config/opencode/opencode.jsonc", entryIndex: 0, hasOptions: false },
        { target: "a", scope: "project", path: "C:\\repo\\opencode.json", entryIndex: 0, hasOptions: false },
        { target: "a", scope: "other", path: "C:\\opencode.json", entryIndex: 0, hasOptions: false },
        { target: "a", scope: "virtual", entryIndex: 0, hasOptions: false },
        { target: "b", scope: "project", path: "C:\\repo\\.opencode\\opencode.jsonc", entryIndex: 1, hasOptions: true },
      ] },
    } as PluginControlsSnapshot
    assert.deepEqual(removableSources(snapshot, source => source.target === "a").map(source => source.scope), ["global"])
    assert.deepEqual(removableSources(snapshot, source => source.target === "b").map(source => source.entryIndex), [1])
  })
})
