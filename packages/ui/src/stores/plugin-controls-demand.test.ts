import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createRoot, onCleanup } from "solid-js"
import type { PluginControlsSnapshot } from "../../../server/src/api-types"
import { PluginControlsCache } from "./plugin-controls"

const location = { directory: "/repo" }

describe("plugin controls visible demand", () => {
  for (const dispose of [false, true]) {
    it(`defers a queued refresh after ${dispose ? "disposal" : "deactivation"} until reopening`, async (t) => {
      const pending = deferred<PluginControlsSnapshot>()
      let reads = 0
      const cache = new PluginControlsCache({
        getPluginControls: async () => ++reads === 2 ? pending.promise : snapshot(`read-${reads}`),
        setPluginActivation: async () => { throw new Error("not used") },
      })
      const release = dispose
        ? createRoot((disposeRoot) => {
            onCleanup(cache.acquireDemand("instance", location))
            return disposeRoot
          })
        : cache.acquireDemand("instance", location)
      t.after(release)
      await tick()
      const refresh = cache.load("instance", location, { force: true })
      cache.invalidateInstance("instance")
      release()
      release()
      pending.resolve(snapshot("obsolete"))
      await refresh
      await tick()

      assert.equal(reads, 2, "no follow-up starts without a visible owner")
      assert.equal(cache.state("instance", location).stale, true)
      assert.equal(cache.state("instance", location).snapshot?.controls[0].id, "read-1")
      t.after(cache.acquireDemand("instance", location))
      await tick()
      assert.equal(reads, 3)
      assert.equal(cache.state("instance", location).stale, false)
      assert.equal(cache.state("instance", location).snapshot?.controls[0].id, "read-3")
    })
  }

  it("keeps a queued refresh while another consumer remains and releases idempotently", async (t) => {
    const pending = deferred<PluginControlsSnapshot>()
    let reads = 0
    const cache = new PluginControlsCache({
      getPluginControls: async () => ++reads === 2 ? pending.promise : snapshot(`read-${reads}`),
      setPluginActivation: async () => { throw new Error("not used") },
    })
    const first = cache.acquireDemand("instance", location)
    const second = cache.acquireDemand("instance", location)
    t.after(first)
    t.after(second)
    await tick()
    assert.equal(reads, 1, "consumers share initial loading")
    const refresh = cache.load("instance", location, { force: true })
    cache.invalidateInstance("instance")
    first()
    first()
    pending.resolve(snapshot("obsolete"))
    await refresh
    await tick()
    assert.equal(reads, 3, "remaining owner retains one trailing read")
    assert.equal(cache.state("instance", location).snapshot?.controls[0].id, "read-3")
    second()
    cache.invalidateInstance("instance")
    await tick()
    assert.equal(reads, 3)
    assert.equal(cache.state("instance", location).stale, true)
  })

  it("retains demand when reopening before the old read settles", async (t) => {
    const pending = deferred<PluginControlsSnapshot>()
    let reads = 0
    const cache = new PluginControlsCache({
      getPluginControls: async () => ++reads === 1 ? pending.promise : snapshot("fresh"),
      setPluginActivation: async () => { throw new Error("not used") },
    })
    const release = cache.acquireDemand("instance", location)
    cache.invalidateInstance("instance")
    release()
    t.after(cache.acquireDemand("instance", location))
    assert.equal(reads, 1)
    pending.resolve(snapshot("obsolete"))
    await tick()
    assert.equal(reads, 2)
    assert.equal(cache.state("instance", location).snapshot?.controls[0].id, "fresh")
  })

  for (const canonicalWins of [false, true]) {
    it(`transfers demand handles when the ${canonicalWins ? "canonical" : "host"} alias wins`, async (t) => {
      const host = { directory: "\\\\wsl.localhost\\Ubuntu\\srv\\repo" }
      const canonical = { directory: "/srv/repo" }
      const hostRead = deferred<PluginControlsSnapshot>()
      const canonicalRead = deferred<PluginControlsSnapshot>()
      const pending = deferred<PluginControlsSnapshot>()
      let reads = 0
      const cache = new PluginControlsCache({
        getPluginControls: async () => [hostRead, canonicalRead, pending][reads++].promise,
        setPluginActivation: async () => { throw new Error("not used") },
      })
      const releaseHost = cache.acquireDemand("instance", host)
      const releaseCanonical = cache.acquireDemand("instance", canonical)
      t.after(releaseHost)
      t.after(releaseCanonical)
      const value = { ...snapshot("initial"), location: canonical }
      const winner = canonicalWins ? canonicalRead : hostRead
      const loser = canonicalWins ? hostRead : canonicalRead
      winner.resolve(value)
      await tick()
      loser.resolve(value)
      await tick()
      // Release the owner originally on the orphaned record. Its handle must
      // remove only itself from the merged record, not lose the other owner.
      const releaseOrphan = canonicalWins ? releaseHost : releaseCanonical
      const releaseWinner = canonicalWins ? releaseCanonical : releaseHost
      releaseOrphan()
      cache.invalidateLocation("instance", canonical)
      assert.equal(reads, 3, "surviving owner refreshes the merged identity")
      cache.invalidateLocation("instance", canonical)
      releaseWinner()
      pending.resolve({ ...snapshot("obsolete"), location: canonical })
      await tick()
      assert.equal(reads, 3, "both original handles release their merged demand")
      for (const alias of [host, canonical]) {
        assert.equal(cache.state("instance", alias).stale, true)
        assert.equal(cache.state("instance", alias).snapshot?.controls[0].id, "initial")
      }
    })
  }

  it("does not let hidden mutation completion start an older read's follow-up", async (t) => {
    const pending = deferred<PluginControlsSnapshot>()
    const write = deferred<void>()
    let reads = 0
    const cache = new PluginControlsCache({
      getPluginControls: async () => ++reads === 2 ? pending.promise : snapshot("known"),
      setPluginActivation: async () => {
        await write.promise
        const durable = snapshot("known")
        durable.controls[0].project = "disabled"
        return {
          snapshot: durable, changed: true, reloadPending: true, rule: "-known",
          target: { scope: "project", path: "/repo/.opencode/opencode.jsonc", exists: true },
        }
      },
    })
    const release = cache.acquireDemand("instance", location)
    t.after(release)
    await tick()
    const refresh = cache.load("instance", location, { force: true })
    const mutation = cache.mutate("instance", location, "known", "project", false)
    release()
    write.resolve()
    await mutation
    pending.resolve(snapshot("obsolete"))
    await refresh
    await tick()
    assert.equal(reads, 2)
    assert.equal(cache.state("instance", location).snapshot?.controls[0].project, "disabled")
    assert.equal(cache.state("instance", location).stale, true)
    t.after(cache.acquireDemand("instance", location))
    await tick()
    assert.equal(reads, 3)
  })

  it("retries a failed initial read on new demand without a retry loop", async (t) => {
    let reads = 0
    const cache = new PluginControlsCache({
      getPluginControls: async () => {
        if (++reads === 1) throw new Error("offline")
        return snapshot("recovered")
      },
      setPluginActivation: async () => { throw new Error("not used") },
    })
    const release = cache.acquireDemand("instance", location)
    await tick()
    assert.equal(reads, 1)
    assert.match(String(cache.state("instance", location).error), /offline/)
    release()
    t.after(cache.acquireDemand("instance", location))
    await tick()
    assert.equal(reads, 2)
    assert.equal(cache.state("instance", location).error, undefined)
  })

  it("recovers a failed canonical refresh from the first successful host-alias read", async (t) => {
    const host = { directory: "\\\\wsl.localhost\\Ubuntu\\srv\\repo" }
    const canonical = { directory: "/srv/repo" }
    let reads = 0
    const cache = new PluginControlsCache({
      getPluginControls: async () => {
        if (++reads === 2) throw new Error("offline")
        return { ...snapshot(reads === 1 ? "old" : "recovered"), location: canonical }
      },
      setPluginActivation: async () => { throw new Error("not used") },
    })
    await cache.load("instance", canonical)
    cache.invalidateLocation("instance", canonical)
    await cache.load("instance", canonical)
    const release = cache.acquireDemand("instance", host)
    t.after(release)
    await tick()

    assert.equal(reads, 3, "the successful recovery needs no duplicate read")
    for (const alias of [host, canonical]) {
      assert.equal(cache.state("instance", alias).snapshot?.controls[0].id, "recovered")
      assert.equal(cache.state("instance", alias).error, undefined)
      assert.equal(cache.state("instance", alias).stale, false)
    }
    cache.invalidateLocation("instance", canonical)
    await tick()
    assert.equal(reads, 4, "the transferred demand still refreshes")
    release()
    cache.invalidateLocation("instance", canonical)
    await tick()
    assert.equal(reads, 4, "the original host handle releases the canonical demand")
  })

  for (const winner of ["healthy", "newer-read", "newer-mutation"] as const) {
    it(`does not recover over a ${winner} canonical snapshot`, async (t) => {
      const host = { directory: "\\\\wsl.localhost\\Ubuntu\\srv\\repo" }
      const canonical = { directory: "/srv/repo" }
      const aliasRead = deferred<PluginControlsSnapshot>()
      const reconciliation = deferred<PluginControlsSnapshot>()
      const write = deferred<void>()
      let canonicalReads = 0
      let hostReads = 0
      let fail = false
      let reconcile = false
      const cache = new PluginControlsCache({
        getPluginControls: async (_instanceId, requested) => {
          if (requested.directory === host.directory) {
            hostReads++
            return aliasRead.promise
          }
          canonicalReads++
          if (reconcile) return reconciliation.promise
          if (fail) throw new Error("offline")
          return { ...snapshot(canonicalReads === 1 ? "original" : "newer"), location: canonical }
        },
        setPluginActivation: async () => {
          await write.promise
          return {
            snapshot: { ...snapshot("newer"), location: canonical },
            changed: true, reloadPending: true, rule: "newer",
            target: { scope: "project", path: "/srv/repo/.opencode/opencode.jsonc", exists: true },
          }
        },
      })
      await cache.load("instance", canonical)
      // Dispatch the mutation BEFORE the alias read, but publish it AFTER.
      // Its dispatch revision alone must not let the alias roll it back.
      const mutation = winner === "newer-mutation"
        ? cache.mutate("instance", canonical, "newer", "project", true)
        : undefined
      await tick()
      t.after(cache.acquireDemand("instance", host))
      if (winner === "newer-read") await cache.load("instance", canonical, { force: true })
      if (mutation) {
        write.resolve()
        await mutation
      }
      if (winner !== "healthy") {
        fail = true
        await cache.load("instance", canonical, { force: true })
        reconcile = true
      }
      aliasRead.resolve({ ...snapshot("obsolete-alias"), location: canonical })
      await tick()

      assert.equal(hostReads, 1)
      for (const alias of [host, canonical]) {
        assert.equal(cache.state("instance", alias).snapshot?.controls[0].id, winner === "healthy" ? "original" : "newer")
      }
      if (winner === "healthy") {
        assert.equal(canonicalReads, 1, "healthy canonical caches retain first-winner behavior")
      } else {
        assert.equal(cache.state("instance", canonical).refreshing, true, "recovery is reconciled instead of using an obsolete alias")
        reconciliation.resolve({ ...snapshot("reconciled"), location: canonical })
        await tick()
        assert.equal(cache.state("instance", host).snapshot?.controls[0].id, "reconciled")
        assert.equal(cache.state("instance", host).error, undefined)
      }
    })
  }

  for (const hidden of [false, true]) {
    it(`preserves a later canonical invalidation during alias recovery, hidden=${hidden}`, async (t) => {
      const host = { directory: "\\\\wsl.localhost\\Ubuntu\\srv\\repo" }
      const canonical = { directory: "/srv/repo" }
      const aliasRead = deferred<PluginControlsSnapshot>()
      const reconciliation = deferred<PluginControlsSnapshot>()
      let reads = 0
      const cache = new PluginControlsCache({
        getPluginControls: async () => {
          reads++
          if (reads === 1) return { ...snapshot("old"), location: canonical }
          if (reads === 2) throw new Error("offline")
          return reads === 3 ? aliasRead.promise : reconciliation.promise
        },
        setPluginActivation: async () => { throw new Error("not used") },
      })
      await cache.load("instance", canonical)
      await cache.load("instance", canonical, { force: true })
      const release = cache.acquireDemand("instance", host)
      t.after(release)
      cache.invalidateLocation("instance", canonical)
      if (hidden) release()
      aliasRead.resolve({ ...snapshot("before-event"), location: canonical })
      await tick()

      assert.equal(cache.state("instance", host).snapshot?.controls[0].id, "old")
      assert.equal(reads, hidden ? 3 : 4)
      if (hidden) {
        assert.equal(cache.state("instance", host).stale, true)
        t.after(cache.acquireDemand("instance", host))
      }
      assert.equal(reads, 4, "exactly one reconciliation survives the merge")
      reconciliation.resolve({ ...snapshot("after-event"), location: canonical })
      await tick()
      assert.equal(cache.state("instance", host).snapshot?.controls[0].id, "after-event")
      assert.equal(cache.state("instance", canonical).stale, false)
    })
  }

  it("keeps canonical queued mutations when a successful alias recovers its failed refresh", async (t) => {
    const host = { directory: "\\\\wsl.localhost\\Ubuntu\\srv\\repo" }
    const canonical = { directory: "/srv/repo" }
    const firstWrite = deferred<void>()
    let reads = 0
    const writes: boolean[] = []
    const cache = new PluginControlsCache({
      getPluginControls: async () => {
        if (++reads === 2) throw new Error("offline")
        return { ...snapshot(reads === 1 ? "old" : "recovered"), location: canonical }
      },
      setPluginActivation: async (_instanceId, request) => {
        writes.push(request.enabled)
        if (writes.length === 1) await firstWrite.promise
        return {
          snapshot: { ...snapshot(request.enabled ? "enabled" : "disabled"), location: canonical },
          changed: true, reloadPending: true, rule: request.enabled ? "known" : "-known",
          target: { scope: "project", path: "/srv/repo/.opencode/opencode.jsonc", exists: true },
        }
      },
    })
    await cache.load("instance", canonical)
    await cache.load("instance", canonical, { force: true })
    const disable = cache.mutate("instance", canonical, "known", "project", false)
    const enable = cache.mutate("instance", canonical, "known", "project", true)
    await tick()
    const release = cache.acquireDemand("instance", host)
    t.after(release)
    await tick()
    assert.equal(cache.state("instance", host).snapshot?.controls[0].id, "recovered")
    assert.deepEqual(writes, [false])
    release()
    firstWrite.resolve()
    await Promise.all([disable, enable])
    assert.deepEqual(writes, [false, true], "neither queued mutation is orphaned or replayed")
    assert.equal(cache.state("instance", host).snapshot?.controls[0].id, "enabled")
    assert.equal(reads, 3, "completion cannot restart hidden reads")
  })

  it("a released handle from a cleared instance cannot cancel its replacement", async (t) => {
    let reads = 0
    const cache = new PluginControlsCache({
      getPluginControls: async () => snapshot(`read-${++reads}`),
      setPluginActivation: async () => { throw new Error("not used") },
    })
    const old = cache.acquireDemand("instance", location)
    await tick()
    cache.clearInstance("instance")
    t.after(cache.acquireDemand("instance", location))
    await tick()
    old()
    cache.invalidateInstance("instance")
    await tick()
    assert.equal(reads, 3)
  })
})

function snapshot(id: string): PluginControlsSnapshot {
  return {
    location, runtime: [], configured: { rules: [], sources: [] }, targets: [],
    controls: [{ id, builtin: false, global: "default", project: "default", effective: "default" }],
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
