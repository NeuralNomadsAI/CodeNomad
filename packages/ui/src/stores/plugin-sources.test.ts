import assert from "node:assert/strict"
import { describe, it, mock } from "node:test"
import type { PluginControlsSnapshot } from "../../../server/src/api-types"
import { PLUGIN_SOURCE_PENDING_TIMEOUT_MS, PluginSourcesStore, removableSources } from "./plugin-sources"
import { pluginControlsCache } from "./plugin-controls"

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
    const due = timers.filter(item => item.at <= now)
    timers.splice(0, timers.length, ...timers.filter(item => item.at > now))
    for (const timer of due) timer.run()
  }
  return { store, calls, invalidations, advance }
}

describe("plugin sources store", () => {
  it("keeps an added source pending for the named window, then marks it not confirmed", async () => {
    const { store, calls, invalidations, advance } = harness()
    await store.add("instance", location, "global", "fixture-plugin@1")
    assert.deepEqual(calls, [["add", "instance", { location, scope: "global", spec: "fixture-plugin@1" }]])
    assert.deepEqual(invalidations, ["instance"], "the inventory, never the response, decides what loaded")
    assert.equal(store.state("instance", location, "fixture-plugin@1"), "unconfirmed", "submission alone is insufficient")
    store.observe(store.addedSpecs("instance", location)[0]!, true, false)
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

  it("uses the original start across late receipts, scope isolation, runtime, removal and owner revocation", () => {
    const { store, advance } = harness(), owner = {}
    const entry = store.begin("instance", location, "global", "private-target", { owner })
    store.observe(entry, true, false)
    assert.equal(store.state("instance", location, entry.spec), "unconfirmed")
    advance(120_000)
    store.submitted(entry)
    assert.equal(store.state("instance", location, entry.spec, "global"), "pending")
    assert.equal(store.state("instance", location, entry.spec, "project"), "unconfirmed")
    advance(1)
    store.submitted(entry)
    assert.equal(store.state("instance", location, entry.spec), "unconfirmed", "late/duplicate receipt never resets start")
    for (const reason of ["runtime", "removal", "owner", "stop"] as const) {
      const attempt = store.begin("instance", location, "global", "x", { owner })
      store.observe(attempt, true, false)
      if (reason === "runtime") store.observe(attempt, true, true)
      if (reason === "removal") store.observe(attempt, false, false)
      if (reason === "owner") store.clearOwner(owner)
      if (reason === "stop") store.clearInstance("instance")
      store.submitted(attempt); store.observe(attempt, true, false)
      assert.equal(store.state("instance", location, "x"), "unconfirmed", reason)
    }
  })

  it("fences a late native add completion after instance stop and starts time before native IO", async () => {
    let done!: (value: any) => void, now = 0
    const store = new PluginSourcesStore({ addPluginSource: () => new Promise(resolve => { done = resolve }), removePluginSource: async () => assert.fail() },
      () => {}, () => now, () => {})
    const work = store.add("instance", location, "global", "x")
    const attempt = store.addedSpecs("instance", location)[0]!
    store.observe(attempt, true, false)
    now = 120_001
    done({ scope: "global", spec: "x", reloadPending: true }); await work
    assert.equal(store.state("instance", location, "x"), "unconfirmed")
    const late = store.add("instance", location, "global", "y")
    store.clearInstance("instance")
    done({ scope: "global", spec: "y", reloadPending: true }); await late
    assert.deepEqual(store.addedSpecs("instance", location), [])
  })

  it("shares canonical aliases, pins exact source identity and consumes bridge hints from native observations", () => {
    const { store } = harness(), canonical = { directory: "/canonical" }, alias = { directory: "X:/host" }
    const lookup = mock.method(pluginControlsCache, "state", (_instance: string, _location: unknown) => ({ snapshot: { location: canonical } }))
    try {
      const attempt = store.begin("instance", alias, "global", "x")
      store.submitted(attempt)
      const snapshot = { location: canonical, runtime: [], controls: [], targets: [], configured: { rules: [], sources: [
        { target: "x", scope: "global", entryIndex: 0, hasOptions: false, trackingTarget: "a".repeat(64) },
      ] } } as PluginControlsSnapshot
      store.observeSnapshot("instance", snapshot)
      assert.equal(store.state("instance", alias, "x"), "pending")
      assert.equal(store.state("instance", canonical, "a".repeat(64), "global"), "pending", "bridge uses the same native hint")
      snapshot.configured.sources[0]!.trackingTarget = "b".repeat(64)
      store.observeSnapshot("instance", snapshot)
      assert.equal(store.state("instance", alias, "x"), "unconfirmed", "new connection/index cannot inherit pending before its event arrives")
      for (const reason of ["runtime", "removal"] as const) {
        const bridge = store.begin("instance", canonical, "global", "b".repeat(64), { integration: "fixture" })
        store.submitted(bridge); store.observeSnapshot("instance", snapshot)
        assert.equal(store.state("instance", canonical, "x", "global", "b".repeat(64)), "pending", "native uses bridge hint")
        const changed = structuredClone(snapshot)
        if (reason === "runtime") changed.runtime.push({ id: "fixture", key: "x", source: { type: "package", target: "x" }, features: {}, state: { status: "active" } })
        else changed.configured.sources = []
        store.observeSnapshot("instance", changed); store.observeSnapshot("instance", snapshot); store.submitted(bridge)
        assert.equal(store.state("instance", canonical, "b".repeat(64), "global"), "unconfirmed", reason)
      }
    } finally { lookup.mock.restore() }
  })

  it("consumes runtime-only observations before any declaration, for native and bridge submissions", () => {
    const { store } = harness()
    const native = store.begin("instance", location, "global", "x")
    const bridge = store.begin("instance", location, "global", "a".repeat(64), { integration: "fixture", runtimeID: "neuralnomads.fixture" })
    for (const attempt of [native, bridge]) store.submitted(attempt)
    const snapshot: any = { location, runtime: [{ id: "neuralnomads.fixture", key: "x", source: { type: "package", target: "x" },
      features: {}, state: { status: "active" } }], configured: { sources: [] } }
    store.observeSnapshot("instance", snapshot)
    for (const attempt of [native, bridge]) { store.observe(attempt, true, false); store.submitted(attempt) }
    assert.deepEqual(store.addedSpecs("instance", location), [])
  })

  it("never adopts another connection before the first native declaration observation", async () => {
    const { store } = harness()
    const before = { location, targets: [{ scope: "global", path: "/global", trackingContext: "connection-A" }] }
    const lookup = mock.method(pluginControlsCache, "state", () => ({ snapshot: before }))
    try {
      await store.add("instance", location, "global", "x")
      const attempt = store.addedSpecs("instance", location)[0]!
      store.observeSnapshot("instance", { ...before, targets: [{ scope: "global", path: "/global", trackingContext: "connection-B" }],
        runtime: [], configured: { sources: [{ target: "x", scope: "global", path: "/global", entryIndex: 0, trackingTarget: "new-source" }] } } as any)
      store.submitted(attempt); store.observe(attempt, true, false)
      assert.equal(store.state("instance", location, "x"), "unconfirmed")
      assert.deepEqual(store.addedSpecs("instance", location), [])
    } finally { lookup.mock.restore() }
  })

  it("emits one local expiry notification without polling or resetting on a late receipt", async () => {
    const { store, advance, calls } = harness()
    await store.add("instance", location, "global", "x")
    const attempt = store.addedSpecs("instance", location)[0]!
    store.observe(attempt, true, false)
    let notifications = 0
    const release = store.onChanged(() => notifications++)
    advance(60_000)
    assert.equal(calls.length, 1); assert.equal(notifications, 0)
    advance(60_000)
    assert.equal(store.state("instance", location, "x"), "pending"); assert.equal(notifications, 0)
    advance(1)
    assert.equal(store.state("instance", location, "x"), "unconfirmed"); assert.equal(notifications, 1)
    store.submitted(attempt); advance(120_001)
    assert.equal(notifications, 1); assert.equal(calls.length, 1)
    release()
  })
})
