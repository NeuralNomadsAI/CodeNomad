import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { PluginControlsSnapshot } from "../../../server/src/api-types"
import { PLUGIN_SOURCE_PENDING_TIMEOUT_MS, PluginSourcesStore, removableSources } from "./plugin-sources"

const location = { directory: "/repo" }

function harness(options: { failRemove?: boolean; failAdd?: boolean; install?: (resolve: (value: unknown) => void, reject: (error: unknown) => void) => void } = {}) {
  let now = 1_000
  const timers: Array<{ at: number; run: () => void }> = []
  const calls: unknown[] = []
  const invalidations: string[] = []
  const refreshes: string[] = []
  const store = new PluginSourcesStore({
    installIntegration: (instanceId, directory, integrationId, scope) => {
      calls.push(["install", instanceId, directory, integrationId, scope])
      return new Promise((resolve, reject) => options.install
        ? options.install(resolve as (value: unknown) => void, reject)
        : resolve({ scope, spec: `@neuralnomads/opencode-${integrationId}@^0.1`, reloadPending: true }))
    },
    addPluginSource: async (instanceId, payload) => {
      calls.push(["add", instanceId, payload])
      if (options.failAdd) throw new Error("refused")
      return { scope: payload.scope, spec: payload.spec, reloadPending: true } },
    removePluginSource: async (instanceId, payload) => {
      calls.push(["remove", instanceId, payload])
      if (options.failRemove) throw new Error("stale")
      return { scope: payload.scope, spec: payload.target, reloadPending: true }
    },
  }, instanceId => invalidations.push(instanceId), () => now, (run, delay) => timers.push({ at: now + delay, run }),
  instanceId => refreshes.push(instanceId))
  const advance = (ms: number) => {
    now += ms
    const due = timers.filter(item => item.at <= now)
    for (const timer of due) timers.splice(timers.indexOf(timer), 1)
    for (const timer of due) timer.run()
  }
  return { store, calls, invalidations, refreshes, advance }
}

const fixture = (plugin: { declared: boolean; runtime?: "loaded" | "failed" }) => ({ id: "fixture", plugin })
const SPEC = "@neuralnomads/opencode-fixture@^0.1"

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

  it("installs an integration by ID once, then tracks the returned spec as pending until the inventory loads it", async () => {
    const { store, calls, invalidations, refreshes, advance } = harness()
    assert.deepEqual(await store.installIntegration("instance", location, "fixture", "global"), { scope: "global", spec: SPEC, reloadPending: true })
    assert.deepEqual(calls, [["install", "instance", "/repo", "fixture", "global"]], "the client names the ID and scope only")
    assert.deepEqual(invalidations, ["instance"])
    assert.deepEqual(refreshes, ["instance"], "the integrations read is refreshed after the write")
    assert.deepEqual(store.addedSpecs("instance", location).map(item => [item.spec, item.scope]), [[SPEC, "global"]])
    assert.equal(store.state("instance", location, SPEC), "pending", "the Plugins row of the returned spec is pending")
    assert.equal(store.installation("instance", location, fixture({ declared: true })), "pending")
    advance(60_000)
    assert.equal(store.installation("instance", location, fixture({ declared: true, runtime: "loaded" })), "active")
    assert.equal(store.installation("instance", location, fixture({ declared: true, runtime: "failed" })), "failed")
    assert.equal(store.installation("instance", { directory: "/other" }, fixture({ declared: false })), undefined, "tracking is per location")
    assert.equal(store.installation("instance", location, { id: "other", plugin: { declared: false } }), undefined)
  })

  it("marks an install not confirmed once the 120 s window passes without the plugin loading", async () => {
    const { store, advance } = harness()
    await store.installIntegration("instance", location, "fixture", "global")
    advance(PLUGIN_SOURCE_PENDING_TIMEOUT_MS)
    assert.equal(store.installation("instance", location, fixture({ declared: true })), "pending")
    advance(1)
    assert.equal(store.installation("instance", location, fixture({ declared: true })), "unconfirmed")
    assert.equal(store.state("instance", location, SPEC), "unconfirmed")
    assert.equal(store.installation("instance", location, fixture({ declared: true, runtime: "loaded" })), "active", "a late load is still active")
  })

  it("shows no hint before the server confirms, and none after a refused or lost answer, without replaying", async () => {
    let settle: { resolve: (value: unknown) => void; reject: (error: unknown) => void } | undefined
    const { store, calls, invalidations, refreshes } = harness({ install: (resolve, reject) => { settle = { resolve, reject } } })
    const sent = store.installIntegration("instance", location, "fixture", "global")
    assert.deepEqual(store.addedSpecs("instance", location), [], "reserved before transmission, shown only once submitted")
    assert.equal(store.installation("instance", location, fixture({ declared: false })), undefined)
    settle!.reject(new Error("connection reset"))
    await assert.rejects(sent, /connection reset/)
    assert.deepEqual(store.addedSpecs("instance", location), [])
    assert.equal(store.installation("instance", location, fixture({ declared: true })), "unconfirmed", "a write the reread shows is unconfirmed, never pending")
    assert.deepEqual([calls.length, invalidations, refreshes], [1, ["instance"], ["instance"]], "one transmission, then reconciliation")
    const mismatch = store.installIntegration("instance", location, "fixture", "global")
    settle!.resolve({ scope: "project", spec: SPEC, reloadPending: true })
    await assert.rejects(mismatch, /could not be confirmed/)
    assert.deepEqual(store.addedSpecs("instance", location), [])
    assert.equal(calls.length, 2)
  })

  it("leaves no hint for a failed add or an install answered after its instance stopped", async () => {
    let settle: ((value: unknown) => void) | undefined
    const { store, invalidations } = harness({ failAdd: true, install: resolve => { settle = resolve } })
    await assert.rejects(store.add("instance", location, "global", "fixture-plugin"), /refused/)
    assert.deepEqual(store.addedSpecs("instance", location), [])
    assert.equal(store.state("instance", location, "fixture-plugin"), "unconfirmed")
    assert.deepEqual(invalidations, ["instance"], "a failed add still reconciles")
    const late = store.installIntegration("instance", location, "fixture", "global")
    store.clearInstance("instance")
    settle!({ scope: "global", spec: SPEC, reloadPending: true })
    await late
    assert.deepEqual(store.addedSpecs("instance", location), [], "a stopped instance's late answer creates no hint")
    assert.equal(store.installation("instance", location, fixture({ declared: true })), "unconfirmed")
  })

  it("never lets failed reservations crowd out a later confirmed hint", async () => {
    const options = { failAdd: false, install: (_resolve: unknown, reject: (error: unknown) => void) => reject(new Error("lost")) }
    const { store } = harness(options)
    // A confirmed hint first, then as many failed reservations as the tracker holds.
    await store.add("instance", location, "global", "first-plugin")
    options.failAdd = true
    for (let index = 0; index < 100; index += 1) {
      await assert.rejects(store.installIntegration("instance", location, "fixture", "global"))
      await assert.rejects(store.add("instance", location, "global", `plugin-${index}`))
    }
    assert.equal(store.state("instance", location, "first-plugin"), "pending", "failed reservations are consumed, never retained")
  })

  it("drops an install hint when its source is removed or its instance stops", async () => {
    const { store } = harness()
    await store.installIntegration("instance", location, "fixture", "global")
    await store.remove("instance", location, { target: SPEC, scope: "global", entryIndex: 0, hasOptions: false, expectedRevision: "a".repeat(64) })
    assert.equal(store.installation("instance", location, fixture({ declared: false })), undefined)
    await store.installIntegration("instance", location, "fixture", "global")
    store.clearInstance("instance")
    assert.equal(store.installation("instance", location, fixture({ declared: true })), "unconfirmed")
  })

  it("removes exactly the displayed declaration, tracks it while saving and forgets its pending add", async () => {
    const { store, calls, invalidations } = harness()
    await store.add("instance", location, "project", "fixture-plugin")
    const source = { target: "fixture-plugin", scope: "project" as const, path: "/repo/.opencode/opencode.jsonc", entryIndex: 2, hasOptions: false, expectedRevision: "a".repeat(64) }
    const removal = store.remove("instance", location, source)
    assert.equal(store.isRemoving("instance", location, source), true)
    await store.remove("instance", location, source)
    await removal
    assert.equal(store.isRemoving("instance", location, source), false)
    assert.deepEqual(calls.slice(1), [["remove", "instance", { location, scope: "project", target: "fixture-plugin", entryIndex: 2, expectedRevision: source.expectedRevision }]], "one request while saving")
    assert.equal(store.addedSpecs("instance", location).length, 0)
    assert.deepEqual(invalidations, ["instance", "instance"])
  })

  it("releases a failed removal and still reconciles", async () => {
    const { store, invalidations } = harness({ failRemove: true })
    const source = { target: "x", scope: "global" as const, path: "/g/opencode.jsonc", entryIndex: 0, hasOptions: false, expectedRevision: "b".repeat(64) }
    await assert.rejects(store.remove("instance", location, source))
    assert.equal(store.isRemoving("instance", location, source), false)
    assert.deepEqual(invalidations, ["instance"])
  })

  it("drops a superseded Installing hint after a lost removal response, leaving inventory to reconcile", async () => {
    const { store, calls, invalidations } = harness({ failRemove: true })
    await store.add("instance", location, "global", "x")
    const source = { target: "x", scope: "global" as const, entryIndex: 0, hasOptions: false, expectedRevision: "a".repeat(64) }
    await assert.rejects(store.remove("instance", location, source))
    assert.deepEqual(store.addedSpecs("instance", location), [])
    assert.equal(calls.length, 2, "one add and one removal, no replay")
    assert.deepEqual(invalidations, ["instance", "instance"])
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
