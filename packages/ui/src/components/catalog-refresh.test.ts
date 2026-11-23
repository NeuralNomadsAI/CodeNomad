import assert from "node:assert/strict"
import test from "node:test"
import { createEffect, createRoot, createSignal, on, onCleanup } from "solid-js"
import { productionHandler } from "../../tests/test-support/production-ast"
import { isCatalogEvent } from "../lib/catalog-events"

const id = "instance"
const listeners = () => {
  const handlers = new Map<string, (payload: any) => void>(), opens: Array<() => void> = []
  return { handlers, opens, serverEvents: {
    on: (type: string, handler: (payload: any) => void) => { handlers.set(type, handler); return () => handlers.delete(type) },
    forInstance: () => ({ onOpen: (handler: () => void) => { opens.push(handler); return () => {} } }),
  } }
}

test("the provider manager rereads once for a catalog event that crossed its initial read", async () => {
  const [loading, setLoading] = createSignal(true), events = listeners(), reads: string[] = []
  const effect = productionHandler(new URL("./provider-auth/provider-manager-modal.tsx", import.meta.url), "createEffect", {
    createEffect, on, onCleanup, loading, isCatalogEvent, serverEvents: events.serverEvents, props: { instanceId: id, open: true },
    client: () => ({}), currentCatalogLocation: () => ({ directory: "/repo" }), loadVersion: 1,
    captureBackendOperation: () => ({ current: () => true }),
    loadProviderData: async () => { reads.push("read") },
  }, "isCatalogEvent") as () => void
  let dispose!: () => void
  createRoot(close => { dispose = close; createEffect(effect) })
  // The initial read answered before the plugin's models loaded; their event arrives meanwhile.
  events.handlers.get("instance.event")!({ type: "instance.event", instanceId: id, event: { type: "model.updated" } })
  events.handlers.get("instance.event")!({ type: "instance.event", instanceId: id, event: { type: "provider.updated" } })
  assert.deepEqual(reads, [], "no overlapping read")
  setLoading(false)
  await Promise.resolve()
  assert.deepEqual(reads, ["read"], "one trailing reread after the initial read")
  dispose()
})

test("Mission profile pickers invalidate on model and provider updates", () => {
  const invalidations: string[] = [], events = listeners()
  productionHandler(new URL("./mission-profile-controls.tsx", import.meta.url), "events", {
    props: { instanceId: id }, isCatalogEvent, invalidate: () => invalidations.push("invalidate"), serverEvents: events.serverEvents,
  })
  const handler = events.handlers.get("instance.event")!
  for (const type of ["model.updated", "provider.updated", "plugin.updated", "session.updated"])
    handler({ type: "instance.event", instanceId: id, event: { type } })
  handler({ type: "instance.event", instanceId: "other", event: { type: "model.updated" } })
  assert.equal(invalidations.length, 3)
})
