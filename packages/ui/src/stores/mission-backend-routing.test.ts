import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { after, test } from "node:test"
import type { MissionBodyRef } from "./mission-content-store"

// Replace only connection/transport boundaries; use the real reactive read stores.
const fixture = {
  inventories: [] as any[], calls: [] as { backend: string; method: string; args: any[] }[],
  signals: new Map<string, AbortSignal>(), instances: new Map<string, any>(),
  read: async (_backend: string, _method: string, _args: any[]): Promise<any> => ({ available: false }),
}
;(globalThis as any).__missionRouting = fixture
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "solid-js") return next("solid-js/dist/solid.js", context)
  if (!context.parentURL?.match(/\/(missions|mission-content)\.ts$/)) return next(specifier, context)
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
await import("./missions")
const { missionContent } = await import("./mission-content")
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const setup = (id: string) => {
  const attachment = new AbortController()
  fixture.signals.set(id, attachment.signal)
  fixture.instances.set(id, { folder: "/repo", client: {}, metadata: { project: { id: "project" } } })
  return attachment
}

test("every Mission store adapter selects the owning backend and sends only the raw workspace id", async () => {
  fixture.calls = []
  for (const id of ["workspace", "east~workspace", "west~workspace"]) {
    setup(id)
    const panel = fixture.inventories[0], scope = { signal: fixture.signals.get(id), current: () => true, deadline: Infinity }
    await panel.read(id, { source: "summaries" }, scope)
    await panel.tasks(id, "mission", { offset: 0 }, scope)
    const ref: MissionBodyRef = { instanceId: id, projectID: "project", missionID: "mission", selector: { kind: "mission", field: "objective" } }
    const ordinary = missionContent.use(ref, "connection")
    await flush()
    ordinary.release()
  }
  for (const backend of ["local", "east", "west"]) {
    const calls = fixture.calls.filter(call => call.backend === backend)
    assert.deepEqual(new Set(calls.map(call => call.method)), new Set(["fetchMissionPanel", "fetchMissionTasks", "fetchMissionContent"]))
    for (const call of calls) assert.equal(call.args[0], "workspace", `${backend}/${call.method}`)
  }
})

test("an unknown owner fails closed without dispatching to another backend", () => {
  setup("missing~workspace")
  const before = fixture.calls.length
  assert.throws(() => fixture.inventories[0].read("missing~workspace", { source: "summaries" }, { current: () => true }), /Backend unavailable/)
  assert.equal(fixture.calls.length, before)
})
