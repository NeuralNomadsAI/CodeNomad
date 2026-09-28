import assert from "node:assert/strict"
import { test } from "node:test"
import type { PluginControlsSnapshot } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { pluginControlsCache } from "./plugin-controls"

test("renderer SSE reconnect invalidates every cached worktree without reading hidden surfaces", async (t) => {
  const sources: Array<{ onopen: (() => void) | null; close: () => void; closed: boolean }> = []
  // Keep the real ServerEvents connection/open dispatch and the feature's real
  // handler registration; replace only the network boundary before importing it.
  t.mock.method(serverApi, "connectEvents", () => {
    const source = { onopen: null, closed: false, close: () => { source.closed = true } }
    sources.push(source)
    return source
  })
  const { serverEvents } = await import("../lib/server-events")
  await import("./plugin-controls-events")
  await tick()
  sources[0].onopen!()
  let nativeStatuses = 0
  t.after(serverEvents.on("instance.eventStatus", () => { nativeStatuses++ }))

  const visible = { directory: "/repo" }
  const sibling = { directory: "/repo/worktree" }
  const other = { directory: "/other" }
  const instances = ["reconnect-first", "reconnect-other"]
  t.after(() => instances.forEach((id) => pluginControlsCache.clearInstance(id)))
  const reads: string[] = []
  let version = "before-gap"
  t.mock.method(serverApi, "getPluginControls", async (instanceId: string, location: { directory: string }) => {
    reads.push(`${instanceId}:${location.directory}`)
    return {
      location, runtime: [], configured: { rules: [], sources: [] }, targets: [],
      controls: [{ id: version, builtin: false, global: "default", project: "default", effective: "default" }],
    } satisfies PluginControlsSnapshot
  })
  await Promise.all([
    pluginControlsCache.load(instances[0], visible),
    pluginControlsCache.load(instances[0], sibling),
    pluginControlsCache.load(instances[1], other),
  ])
  const release = pluginControlsCache.acquireDemand(instances[0], visible)
  t.after(release)
  assert.equal(reads.length, 3)

  version = "after-gap"
  serverEvents.restart("isolated plugin transport reconnect")
  await tick()
  assert.equal(sources[0].closed, true)
  assert.equal(sources.length, 2)
  sources[1].onopen!()
  await tick()

  assert.equal(nativeStatuses, 0, "the backend's native subscription did not reconnect")
  assert.equal(reads.length, 4, "only the visible worktree reconciles")
  assert.equal(pluginControlsCache.state(instances[0], visible).snapshot?.controls[0].id, "after-gap")
  for (const [instanceId, location] of [[instances[0], sibling], [instances[1], other]] as const) {
    const hidden = pluginControlsCache.state(instanceId, location)
    assert.equal(hidden.stale, true)
    assert.equal(hidden.snapshot?.controls[0].id, "before-gap")
  }

  release()
  t.after(pluginControlsCache.acquireDemand(instances[0], sibling))
  await tick()
  assert.equal(reads.length, 5)
  assert.equal(pluginControlsCache.state(instances[0], sibling).snapshot?.controls[0].id, "after-gap")
  assert.equal(pluginControlsCache.state(instances[1], other).stale, true)
})

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
