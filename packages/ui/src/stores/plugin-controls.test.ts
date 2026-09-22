import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { PluginControlsSnapshot } from "../../../server/src/api-types"
import { PluginControlsCache } from "./plugin-controls"

describe("plugin controls cache", () => {
  it("shares concurrent reads and coalesces invalidations into one trailing refresh", async () => {
    const first = deferred<PluginControlsSnapshot>()
    const second = deferred<PluginControlsSnapshot>()
    const responses = [first, second]
    let reads = 0
    const cache = new PluginControlsCache({
      getPluginControls: async () => responses[reads++].promise,
      setPluginActivation: async () => { throw new Error("not used") },
    })
    const location = { directory: "/repo" }

    const pending = cache.load("instance", location)
    assert.equal(cache.state("instance", location).loading, true)
    assert.equal(cache.load("instance", location, { force: true }), pending)
    cache.invalidateInstance("instance")
    assert.equal(cache.state("instance", location).stale, true)
    assert.equal(cache.load("instance", location), pending)
    assert.equal(reads, 1)

    first.resolve(snapshot("first"))
    await pending
    await tick()
    assert.equal(reads, 2)
    assert.equal(cache.state("instance", location).snapshot, undefined, "invalidated response is fenced")

    second.resolve(snapshot("second"))
    await tick()
    assert.equal(cache.state("instance", location).snapshot?.controls[0]?.id, "second")
  })

  it("marks hidden snapshots stale without starting background work", async () => {
    let reads = 0
    const cache = new PluginControlsCache({
      getPluginControls: async () => snapshot(`read-${++reads}`),
      setPluginActivation: async () => { throw new Error("not used") },
    })
    const location = { directory: "/repo" }
    await cache.load("instance", location)

    cache.invalidateInstance("instance")

    assert.equal(reads, 1)
    assert.equal(cache.state("instance", location).snapshot?.controls[0]?.id, "read-1")
    assert.equal(cache.state("instance", location).stale, true)
    await cache.load("instance", location)
    assert.equal(reads, 2)
    assert.equal(cache.state("instance", location).snapshot?.controls[0]?.id, "read-2")
    assert.equal(cache.state("instance", location).stale, false)
  })

  it("shares one worktree snapshot across session workspace identifiers", async () => {
    let reads = 0
    const cache = new PluginControlsCache({
      getPluginControls: async () => {
        reads += 1
        return snapshot("shared")
      },
      setPluginActivation: async () => { throw new Error("not used") },
    })
    const firstSession = { directory: "/repo", workspaceID: "session-one" }
    const secondSession = { directory: "/repo", workspaceID: "session-two" }

    await cache.load("instance", firstSession)
    await cache.load("instance", secondSession)

    assert.equal(reads, 1)
    assert.equal(cache.state("instance", secondSession).snapshot?.controls[0]?.id, "shared")
  })

  it("invalidates only the event worktree", async () => {
    let reads = 0
    const cache = new PluginControlsCache({
      getPluginControls: async (_instanceId, location) => {
        reads += 1
        return { ...snapshot(location.directory), location }
      },
      setPluginActivation: async () => { throw new Error("not used") },
    })
    const first = { directory: "/repo/one" }
    const second = { directory: "/repo/two" }
    await cache.load("instance", first)
    await cache.load("instance", second)

    cache.invalidateLocation("instance", first)

    assert.equal(cache.state("instance", first).stale, true)
    assert.equal(cache.state("instance", second).stale, false)
    assert.equal(reads, 2)
  })

  it("marks sibling worktrees stale after a global mutation without refreshing them", async () => {
    let reads = 0
    const cache = new PluginControlsCache({
      getPluginControls: async (_instanceId, location) => {
        reads += 1
        return { ...snapshot(location.directory), location }
      },
      setPluginActivation: async (_instanceId, payload) => ({
        changed: true,
        rule: `-${payload.pluginId}`,
        reloadPending: true,
        target: { scope: payload.scope, path: "/config/opencode.jsonc", exists: true },
        snapshot: { ...snapshot("mutated"), location: payload.location },
      }),
    })
    const first = { directory: "/repo/one" }
    const second = { directory: "/repo/two" }
    await cache.load("instance", first)
    await cache.load("instance", second)

    await cache.mutate("instance", first, "first", "global", false)

    assert.equal(cache.state("instance", first).snapshot?.controls[0]?.id, "mutated")
    assert.equal(cache.state("instance", first).stale, false)
    assert.equal(cache.state("instance", second).stale, true)
    assert.equal(reads, 2)
  })

  it("keeps the last successful snapshot when a passive refresh fails", async () => {
    let fail = false
    const cache = new PluginControlsCache({
      getPluginControls: async () => {
        if (fail) throw new Error("offline")
        return snapshot("retained")
      },
      setPluginActivation: async () => { throw new Error("not used") },
    })
    const location = { directory: "/repo" }
    await cache.load("instance", location)
    fail = true

    await cache.load("instance", location, { force: true })

    const state = cache.state("instance", location)
    assert.equal(state.snapshot?.controls[0]?.id, "retained")
    assert.match(String(state.error), /offline/)
    assert.equal(state.refreshing, false)
  })

  it("publishes the durable mutation response and fences an older refresh", async () => {
    const stale = deferred<PluginControlsSnapshot>()
    const fresh = deferred<PluginControlsSnapshot>()
    let reads = 0
    const cache = new PluginControlsCache({
      getPluginControls: async () => reads++ === 0 ? snapshot("initial") : reads === 2 ? stale.promise : fresh.promise,
      setPluginActivation: async (_instanceId, request) => ({
        snapshot: snapshot(request.pluginId, "disabled"),
        rule: `-${request.pluginId}`,
        target: { scope: request.scope, path: "/repo/.opencode/opencode.jsonc", exists: true },
        changed: true,
        reloadPending: true,
      }),
    })
    const location = { directory: "/repo" }
    await cache.load("instance", location)
    const pendingRefresh = cache.load("instance", location, { force: true })

    await cache.mutate("instance", location, "acme", "project", false)
    assert.equal(cache.state("instance", location).snapshot?.controls[0]?.id, "acme")
    assert.equal(cache.state("instance", location).snapshot?.controls[0]?.effective, "disabled")

    stale.resolve(snapshot("stale"))
    await pendingRefresh
    await tick()
    assert.equal(cache.state("instance", location).snapshot?.controls[0]?.id, "acme", "stale response cannot overwrite mutation")

    fresh.resolve(snapshot("fresh", "disabled"))
    await tick()
    assert.equal(cache.state("instance", location).snapshot?.controls[0]?.id, "fresh")
  })

  it("fences requests after an instance is cleared", async () => {
    const response = deferred<PluginControlsSnapshot>()
    const cache = new PluginControlsCache({
      getPluginControls: async () => response.promise,
      setPluginActivation: async () => { throw new Error("not used") },
    })
    const location = { directory: "/repo" }
    const pending = cache.load("instance", location)
    cache.clearInstance("instance")
    response.resolve(snapshot("late"))
    await pending

    assert.equal(cache.state("instance", location).snapshot, undefined)
  })

  it("does not mislabel a mutation failure as a passive refresh failure", async () => {
    const cache = new PluginControlsCache({
      getPluginControls: async () => snapshot("retained"),
      setPluginActivation: async () => { throw new Error("write refused") },
    })
    const location = { directory: "/repo" }
    await cache.load("instance", location)

    await assert.rejects(cache.mutate("instance", location, "retained", "project", false), /write refused/)

    assert.equal(cache.state("instance", location).snapshot?.controls[0]?.id, "retained")
    assert.equal(cache.state("instance", location).error, undefined)
  })

  it("serializes mutations for one location so older responses cannot replace newer state", async () => {
    const first = deferred<PluginControlsSnapshot>()
    const second = deferred<PluginControlsSnapshot>()
    let writes = 0
    const cache = new PluginControlsCache({
      getPluginControls: async () => snapshot("initial"),
      setPluginActivation: async (_instanceId, request) => ({
        snapshot: await (writes++ === 0 ? first.promise : second.promise),
        rule: request.enabled ? request.pluginId : `-${request.pluginId}`,
        target: { scope: request.scope, path: "/repo/.opencode/opencode.jsonc", exists: true },
        changed: true,
        reloadPending: true,
      }),
    })
    const location = { directory: "/repo" }
    await cache.load("instance", location)

    const disable = cache.mutate("instance", location, "first", "project", false)
    const enable = cache.mutate("instance", location, "second", "project", true)
    await tick()
    assert.equal(writes, 1, "the second write waits for the first response")

    first.resolve(snapshot("first", "disabled"))
    await disable
    await tick()
    assert.equal(writes, 2)
    second.resolve(snapshot("second", "enabled"))
    await enable

    assert.equal(cache.state("instance", location).snapshot?.controls[0]?.id, "second")
    assert.equal(cache.state("instance", location).snapshot?.controls[0]?.effective, "enabled")
  })
})

function snapshot(id: string, effective: "default" | "enabled" | "disabled" = "default"): PluginControlsSnapshot {
  return {
    location: { directory: "/repo" },
    runtime: [],
    configured: { rules: [], sources: [] },
    controls: [{ id, effective, global: "default", project: effective }],
    targets: [
      { scope: "global", path: "/global/opencode.jsonc", exists: true },
      { scope: "project", path: "/repo/.opencode/opencode.jsonc", exists: true },
    ],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure })
  return { promise, resolve, reject }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
