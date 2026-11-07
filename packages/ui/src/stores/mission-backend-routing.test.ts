import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { after, test } from "node:test"
import type { MissionBodyRef } from "./mission-content-store"

// Replace only connection/transport boundaries; use the real reactive read stores.
const fixture = {
  inventories: [] as any[], calls: [] as { backend: string; method: string; args: any[] }[],
  signals: new Map<string, AbortSignal>(), instances: new Map<string, any>(),
  read: async (_backend: string, method: string, _args: any[]): Promise<any> => {
    if (method === "fetchMissionSchedules" || method === "fetchMissionRecurrence") return { version: 1, projectID: "project", schedules: [] }
    if (method === "fetchMissionSchedule") return { pending: false, document: null }
    if (method === "fetchMissionCurrentPassage") return { version: 1, projectID: "project", scheduleID: "schedule", passageID: "passage", source: { missionID: "execution" } }
    return { available: false }
  },
}
;(globalThis as any).__missionRouting = fixture
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "solid-js") return next("solid-js/dist/solid.js", context)
  if (!context.parentURL?.match(/\/(missions|mission-content|mission-schedules|mission-recurrence)\.ts$/)) return next(specifier, context)
  const sources: Record<string, string> = {
    "../lib/backend-client": `const f = globalThis.__missionRouting; export function backendOf(id) {
      const backend = id.includes('~') ? id.split('~')[0] : 'local';
      if (!['local', 'east', 'west'].includes(backend)) throw new Error('Backend unavailable');
      return { api: new Proxy({}, { get: (_, method) => (...args) => {
        f.calls.push({ backend, method, args }); return f.read(backend, method, args);
      } }) };
    }`,
    "../lib/backend-operation": `export function captureBackendOperation(id, parent) {
      const attachment = globalThis.__missionRouting.signals.get(id);
      const signal = parent ? AbortSignal.any([attachment, parent]) : attachment;
      return { signal, current: () => !signal.aborted };
    }`,
    "../lib/server-events": `export const backendEvents = {
      on: () => () => {}, onOpen: () => () => {}, forInstance: () => ({ onOpen: () => () => {} })
    };`,
    "./instances": "export const instances = () => globalThis.__missionRouting.instances;",
    "./opencode-data": "export const getOpenCodeInstanceGeneration = () => 0;",
    "./session-list-restoration": "export const sessionListRestored = () => true;",
    "./mission-panel-inventory": `export function createMissionPanelInventory(input) {
      globalThis.__missionRouting.inventories.push(input);
      return { trackedInstanceIds: () => [], clear() {}, setDemand() {}, want() {},
        ensure: async () => {}, refresh: async () => {}, state: () => ({ status: 'ready', missions: [] }) };
    }`,
  }
  return sources[specifier] ? { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(sources[specifier])}` } : next(specifier, context)
} })
after(() => { hooks.deregister(); delete (globalThis as any).__missionRouting })
const { createRoot } = await import("solid-js")
await import("./missions")
const { missionContent } = await import("./mission-content")
const { useMissionSchedules } = await import("./mission-schedules")
const { useMissionRecurrence, useMissionCurrentPassage } = await import("./mission-recurrence")
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const setup = (id: string) => {
  const attachment = new AbortController()
  fixture.signals.set(id, attachment.signal)
  fixture.instances.set(id, { folder: "/repo", client: {}, metadata: { project: { id: "project" } } })
  return attachment
}
const props = (id: string) => ({ instanceId: () => id, projectID: () => "project", directory: () => "/repo", active: () => true, refresh: () => 0, selected: () => undefined })

test("every Mission store adapter selects the owning backend and sends only the raw workspace id", async () => {
  fixture.calls = []
  for (const id of ["workspace", "east~workspace", "west~workspace"]) {
    setup(id)
    const panel = fixture.inventories[0], scope = { signal: fixture.signals.get(id), current: () => true, deadline: Infinity }
    await panel.read(id, { source: "summaries" }, scope)
    await panel.tasks(id, "mission", { offset: 0 }, scope)
    const ref: MissionBodyRef = { instanceId: id, projectID: "project", missionID: "mission", selector: { kind: "mission", field: "objective" } }
    const ordinary = missionContent.use(ref, "connection"), current = missionContent.use({ ...ref, passage: { owner: "scheduled" } as any }, "connection")
    let dispose!: () => void
    createRoot(cleanup => {
      dispose = cleanup
      useMissionSchedules({ ...props(id), selected: () => "selected" }); useMissionRecurrence(props(id))
      useMissionCurrentPassage({ ...props(id), scheduleID: () => "schedule" })
    })
    await flush()
    const passage = fixture.inventories.at(-1)
    await passage.read(id, { source: "mission", missionID: "execution", header: true }, scope)
    await passage.tasks(id, "execution", { offset: 0 }, scope)
    ordinary.release(); current.release(); dispose()
  }
  for (const backend of ["local", "east", "west"]) {
    const calls = fixture.calls.filter(call => call.backend === backend)
    assert.deepEqual(new Set(calls.map(call => call.method)), new Set([
      "fetchMissionPanel", "fetchMissionTasks", "fetchMissionContent", "fetchMissionCurrentBody",
      "fetchMissionSchedules", "fetchMissionSchedule", "fetchMissionRecurrence", "fetchMissionCurrentPassage",
      "fetchMissionCurrentPanel", "fetchMissionCurrentTasks",
    ]))
    for (const call of calls) assert.equal(call.args[0], "workspace", `${backend}/${call.method}`)
  }
})

test("an unknown owner fails closed without dispatching to another backend", async () => {
  setup("missing~workspace")
  const before = fixture.calls.length
  assert.throws(() => fixture.inventories[0].read("missing~workspace", { source: "summaries" }, { current: () => true }), /Backend unavailable/)
  let dispose!: () => void
  const stores = createRoot(cleanup => {
    dispose = cleanup
    return [useMissionSchedules(props("missing~workspace")), useMissionRecurrence(props("missing~workspace"))]
  })
  await flush()
  assert.ok(stores.every(store => store.error()))
  assert.equal(fixture.calls.length, before)
  dispose()
})

test("revocation after a list await fences detail follow-up, publication and busy cleanup", async () => {
  const id = "east~revoked", attachment = setup(id)
  let resolve!: (value: any) => void
  const previous = fixture.read
  fixture.read = async () => new Promise(done => { resolve = done })
  let dispose!: () => void
  const store = createRoot(cleanup => {
    dispose = cleanup
    return useMissionSchedules({ ...props(id), selected: () => "selected" })
  })
  const before = fixture.calls.length
  attachment.abort()
  resolve({ version: 1, projectID: "project", schedules: [{ id: "late" }] })
  await flush()
  assert.equal(store.loading(), false)
  assert.deepEqual(store.rows(), [])
  assert.equal(fixture.calls.length, before, "a revoked list cannot dispatch its selected point read")
  dispose(); fixture.read = previous
})
