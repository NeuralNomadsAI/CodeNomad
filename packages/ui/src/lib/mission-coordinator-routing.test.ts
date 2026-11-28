import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { after, test } from "node:test"
import { backendOf, backends, createBackendClient, type BackendClient } from "./backend-client"
import { backendEvents } from "./backend-events"

const state = { sends: [] as string[], hydrate: [] as string[], pending: undefined as Promise<void> | undefined }
;(globalThis as any).__missionCoordinatorRouting = state
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (!context.parentURL?.endsWith("/mission-coordinator-message.ts")) return next(specifier, context)
  const sources: Record<string, string> = {
    "../stores/instances": "export const instances = () => ({ get: () => ({ client: {} }) });",
    "../stores/sessions": `export async function hydrateRestoredSessionChain(id) {
      globalThis.__missionCoordinatorRouting.hydrate.push(id);
      await globalThis.__missionCoordinatorRouting.pending;
    }`,
    "../stores/session-actions": `export async function sendMessage(id) {
      globalThis.__missionCoordinatorRouting.sends.push(id); return 'message';
    }`,
  }
  return sources[specifier] ? { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(sources[specifier])}` } : next(specifier, context)
} })
after(() => { hooks.deregister(); delete (globalThis as any).__missionCoordinatorRouting })
const { sendMissionCoordinatorMessage } = await import("./mission-coordinator-message")
const registry = backends as Map<string, BackendClient>
const mission = { id: "mission", status: "active", coordinatorSessionId: "coordinator", projectID: "project" } as any

test("coordinator admission uses the project's backend and never falls back", async t => {
  const requests: string[] = []
  state.sends = []; state.hydrate = []
  for (const id of ["coordA", "coordB"]) {
    const backend = createBackendClient({ id, baseUrl: `https://${id}.invalid`, fetcher: async input => {
      requests.push(String(input)); return Response.json({ available: true, mission })
    } })
    registry.set(id, backend)
    const detach = backendEvents.attach(id, backend.events)
    t.after(() => { detach(); backend.events.dispose(); registry.delete(id) })
    const instanceId = `${id}~workspace`
    const result = await sendMissionCoordinatorMessage({ instanceId, mission, current: () => true,
      text: () => "Continue", onSending() {} })
    assert.deepEqual(result, { state: "admitted", messageId: "message" })
    assert.equal(backendOf(instanceId), backend)
  }
  assert.deepEqual(requests, ["https://coorda.invalid/api/workspaces/workspace/missions/mission/admission",
    "https://coordb.invalid/api/workspaces/workspace/missions/mission/admission"])
  assert.deepEqual(state.sends, ["coordA~workspace", "coordB~workspace"])
  const result = await sendMissionCoordinatorMessage({ instanceId: "missingCoord~workspace", mission,
    current: () => true, text: () => { throw new Error("unreachable") }, onSending() {} })
  assert.deepEqual(result, { state: "error" }); assert.equal(requests.length, 2)
})

test("revocation after admission or hydration prevents every later effect", async t => {
  for (const stage of ["admission", "hydration"]) {
    state.sends = []; state.hydrate = []
    let release!: () => void, entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    state.pending = stage === "hydration" ? gate : undefined
    const id = `coord${stage}`
    const backend = createBackendClient({ id, baseUrl: "https://coordinator.invalid", fetcher: async () => {
      if (stage === "admission") { entered(); await gate }
      else queueMicrotask(entered)
      return Response.json({ available: true, mission })
    } })
    registry.set(id, backend)
    const detach = backendEvents.attach(id, backend.events)
    t.after(() => { detach(); backend.events.dispose(); registry.delete(id) })
    const sending: string[] = []
    const result = sendMissionCoordinatorMessage({ instanceId: `${id}~workspace`, mission, current: () => true,
      text: () => "Continue", onSending: () => sending.push("sending") })
    await ready
    if (stage === "hydration") while (!state.hydrate.length) await new Promise<void>(resolve => setImmediate(resolve))
    detach(); release()
    assert.deepEqual(await result, { state: "error" })
    assert.deepEqual(state.sends, []); assert.deepEqual(sending, [])
    if (stage === "admission") assert.deepEqual(state.hydrate, [])
  }
  state.pending = undefined
})
