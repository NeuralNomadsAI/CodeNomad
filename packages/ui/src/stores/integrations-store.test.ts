import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { IntegrationsResponse } from "../../../server/src/integration-types"
import { createIntegrationsStore, INTEGRATION_EVENT_COALESCE_MS, isIntegrationRefreshEvent } from "./integrations-store.ts"

const response = (state: "fresh" | "unavailable" = "fresh"): IntegrationsResponse => ({ location: { directory: "/work" }, catalog: { state }, integrations: [] })

/** A store on a manual clock whose reads answer when the test says so. */
function fixture() {
  let now = 0
  const timers: Array<{ at: number; callback: () => void; cleared?: boolean }> = []
  const reads: Array<{ directory: string; signal: AbortSignal; resolve: (value: IntegrationsResponse) => void; reject: (error: unknown) => void }> = []
  const store = createIntegrationsStore((_instanceId, directory, signal) => new Promise((resolve, reject) => reads.push({ directory, signal, resolve, reject })), {
    setTimer: (callback, ms) => { const timer = { at: now + ms, callback }; timers.push(timer); return timer },
    clearTimer: timer => { (timer as { cleared?: boolean }).cleared = true },
  })
  const advance = async (ms: number) => {
    now += ms
    for (const timer of timers.splice(0).filter(timer => !timer.cleared)) {
      if (timer.at <= now) timer.callback()
      else timers.push(timer)
    }
    await new Promise(resolve => setImmediate(resolve))
  }
  const settle = () => new Promise(resolve => setImmediate(resolve))
  return { store, reads, timers, advance, settle }
}

describe("integrations store", () => {
  it("classifies integration RPC, plugin and configuration events only", () => {
    for (const type of ["rpc.neuralnomads.blender.status_changed", "rpc.neuralnomads.m365.hosts_changed", "plugin.updated", "config.updated"]) {
      assert.equal(isIntegrationRefreshEvent(type), true, type)
    }
    for (const type of ["rpc.opencode.goal.changed", "rpc.neuralnomads.blender.other", "rpc.neuralnomads.Blender.status_changed", "session.updated"]) {
      assert.equal(isIntegrationRefreshEvent(type), false, type)
    }
  })

  it("reads on demand and turns a burst of 10 events within 300 ms into one read", async () => {
    const f = fixture()
    const release = f.store.demand("i1", "/work")
    assert.equal(f.reads.length, 1)
    f.reads[0]!.resolve(response())
    await f.settle()
    assert.equal(f.store.state("i1", "/work").status, "ready")
    for (let index = 0; index < 10; index++) {
      f.store.applyEvent("i1", "rpc.neuralnomads.fixture.status_changed")
      await f.advance(INTEGRATION_EVENT_COALESCE_MS / 10 - 1)
    }
    assert.equal(f.reads.length, 1, "nothing reads inside the window")
    await f.advance(INTEGRATION_EVENT_COALESCE_MS)
    assert.equal(f.reads.length, 2, "the burst produced one read")
    release()
    assert.equal(f.reads[1]!.signal.aborted, true, "releasing the last demand aborts its read")
  })

  it("never reads without events or demand", async () => {
    const f = fixture()
    f.store.applyEvent("i1", "rpc.neuralnomads.fixture.hosts_changed")
    await f.advance(60_000)
    assert.equal(f.reads.length, 0, "no demand: events schedule nothing")
    const release = f.store.demand("i1", "/work")
    f.reads[0]!.resolve(response())
    await f.advance(60_000)
    assert.equal(f.reads.length, 1, "no event for 60 s: no read")
    assert.equal(f.timers.length, 0)
    f.store.applyEvent("i2", "plugin.updated")
    await f.advance(INTEGRATION_EVENT_COALESCE_MS)
    assert.equal(f.reads.length, 1, "another instance's event reads nothing here")
    release()
  })

  it("runs one trailing read for events during a read, and keeps the last answer after a failure", async () => {
    const f = fixture()
    const release = f.store.demand("i1", "/work")
    f.store.applyEvent("i1", "config.updated")
    await f.advance(INTEGRATION_EVENT_COALESCE_MS)
    f.store.applyEvent("i1", "config.updated")
    await f.advance(INTEGRATION_EVENT_COALESCE_MS)
    assert.equal(f.reads.length, 1, "events during a read only mark it dirty")
    f.reads[0]!.resolve(response())
    await f.settle()
    assert.equal(f.reads.length, 2, "one trailing read follows")
    f.reads[1]!.reject(new Error("unavailable"))
    await f.settle()
    const shown = f.store.state("i1", "/work")
    assert.equal(shown.status === "ready" && shown.response.catalog.state, "fresh")
    f.store.clearInstance("i1")
    assert.equal(f.store.state("i1", "/work").status, "loading")
    release()
  })
})
