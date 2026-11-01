import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { after, test } from "node:test"
import { NativeMissionDocumentStore } from "../../../server/src/missions/mission-document-store"
import { missionScheduleView } from "../../../server/src/missions/mission-schedule-view"
import type { MissionJsonValue } from "../../../server/src/missions/model"
import type { MissionScheduleRead, MissionScheduleList } from "../../../server/src/api-types"
import { HttpResponseError } from "../lib/retryable-file-search"

// Stub only transport/connection boundaries; execute the real store, scheduler
// and client Solid runtime. Native documents supply the actual public projection.
const fixture = { list: async (): Promise<MissionScheduleList> => { throw new Error("unconfigured") },
  detail: async (_id: string, _signal: AbortSignal): Promise<MissionScheduleRead> => { throw new Error("unconfigured") },
  client: () => ({}), generation: () => 0 }
;(globalThis as any).__missionSchedulesTest = fixture
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "solid-js") return next("solid-js/dist/solid.js", context)
  const sources: Record<string, string> = {
    "../lib/api-client": `const f = globalThis.__missionSchedulesTest; export const serverApi = {
      fetchMissionSchedules: () => f.list(), fetchMissionSchedule: (_instance, id, _input, signal) => f.detail(id, signal) };`,
    "../lib/server-events": "export const serverEvents = { on: () => () => {}, onOpen: () => () => {} };",
    "./instances": "export const instances = () => new Map([['instance', { client: globalThis.__missionSchedulesTest.client() }]]);",
    "./opencode-data": "export const getOpenCodeInstanceGeneration = () => globalThis.__missionSchedulesTest.generation();",
    "./session-list-restoration": "export const sessionListRestored = () => true;",
    "./missions": "export const isMissionActivityEvent = () => false;",
  }
  if (context.parentURL?.endsWith("/mission-schedules.ts") && sources[specifier])
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(sources[specifier])}` }
  return next(specifier, context)
} })
after(() => { hooks.deregister(); delete (globalThis as any).__missionSchedulesTest })
const { createRoot, createSignal, createEffect } = await import("solid-js")
const { useMissionSchedules, unifiedScheduleHolds: holds, changedUnifiedScheduleHolds: bump } = await import("./mission-schedules")
const deferred = <T = void>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const until = (predicate: () => boolean) => new Promise<void>(resolve => createRoot(dispose => {
  createEffect(() => { if (predicate()) { dispose(); resolve() } })
}))
const values = new Map<string, MissionJsonValue>()
const native = new NativeMissionDocumentStore({ get: async key => values.get(key),
  compareAndSet: async (key, value) => { values.set(key, structuredClone(value)) } }, "project", "/repo")
const configuration = { title: "Selected", objective: "Inspect", template: "custom" as const, taskMode: "native" as const,
  profiles: { coordinator: { agent: "coordinator", model: { providerID: "p", id: "m" } },
    roles: { specialist: { agent: "specialist", model: { providerID: "p", id: "m" } } } },
  profileID: "profile", executionHost: "local", roots: [{ mode: "directory-only" as const, directory: "/repo" }], watchedConversationIDs: [],
  launch: { timing: { kind: "every" as const, intervalMs: 900_000 }, condition: null, ends: { maxLaunches: null, at: null, afterMs: null } } }
const selected = missionScheduleView(await native.create("zzz_selected", configuration, 1, () => true)).document!
const page = await Promise.all(Array.from({ length: 8 }, async (_, i) =>
  missionScheduleView(await native.create(`aaa_${i}`, { ...configuration, title: `Row ${i}` }, 1, () => true)).document!))
const partial = (documentID = selected.id, control: object = {}) => new HttpResponseError("pending", 503, null, "schedule-pending",
  { pending: true, document: { ...selected, id: documentID,
    control: { requestID: "original_request", expectedRevision: 7, action: "play", pending: true, ...control } } })
const key = (id = selected.id, project = "project", directory = "/repo") => JSON.stringify(["instance", project, directory, id])
function setup(retain = true, list?: () => Promise<MissionScheduleList>) {
  holds.clear()
  const hold = { phase: "control" as const, action: "play" as const, requestID: "original_request", expectedRevision: 7, partial: true, document: selected }
  if (retain) {
    holds.set(key(), hold)
    holds.set(key("retained_other"), { ...hold, requestID: "other_request", document: { ...selected, id: "retained_other" } })
  }
  // Neither a foreign project/directory nor a key naming another document leaks.
  holds.set(key("foreign", "other"), { ...hold, document: { ...selected, id: "foreign" } })
  holds.set(key("foreign", "project", "/other"), { ...hold, document: { ...selected, id: "foreign" } })
  holds.set(key("wrong_id"), { ...hold, document: { ...selected, id: "foreign" } })
  bump()
  const [selection, select] = createSignal<string | undefined>(selected.id), [project, setProject] = createSignal("project")
  const [directory, setDirectory] = createSignal("/repo"), [active, setActive] = createSignal(true)
  const [client, setClient] = createSignal({}), [generation, setGeneration] = createSignal(0)
  fixture.client = client; fixture.generation = generation
  const calls = { list: 0, detail: [] as string[] }
  fixture.list = async () => { calls.list++; return list ? list() : { version: 1, projectID: project(), schedules: page, next: "aaa_7" } }
  fixture.detail = async id => { calls.detail.push(id); throw partial(id) }
  let dispose!: () => void
  const store = createRoot(cleanup => { dispose = cleanup; return useMissionSchedules({ instanceId: () => "instance", projectID: project,
    directory, active, selected: selection, refresh: () => 0 }) })
  return { store, calls, hold, select, setProject, setDirectory, setActive, setClient, setGeneration, dispose }
}

test("cold first-page success publishes rows/cursor and scoped holds before a selected partial 503 settles", async () => {
  const gate = deferred<MissionScheduleRead>(), started = deferred(), h = setup()
  fixture.detail = async id => { h.calls.detail.push(id); started.resolve(); return gate.promise }
  try {
    await started.promise
    assert.equal(h.store.rows().length, 10); assert.equal(h.store.next(), "aaa_7")
    assert.equal(h.store.loading(), true); assert.equal(h.store.fresh(selected.id), false)
    gate.reject(partial()); await until(() => !h.store.loading())
    assert.equal(h.store.error(), false); assert.equal(h.store.selectionError(), "pending")
    assert.equal(h.store.rows().length, 10); assert.equal(h.store.fresh("aaa_0"), true)
    assert.equal(h.store.fresh("retained_other"), false)
    assert.equal(holds.get(key()), h.hold); assert.equal(h.hold.requestID, "original_request"); assert.equal(h.hold.expectedRevision, 7)
    assert.deepEqual(h.calls, { list: 1, detail: [selected.id] })
    fixture.detail = async id => { h.calls.detail.push(id); return { document: selected, pending: false } }
    h.store.refresh(); await until(() => h.store.fresh(selected.id))
    assert.equal(h.store.selectionError(), undefined); assert.equal(h.store.rows().length, 10)
    assert.equal(holds.get(key()), h.hold, "display reads never settle or replace an original control")
  } finally { h.dispose() }
})

for (const [name, error, expected] of [
  ["expected partial without local hold", partial(), "pending"],
  ["foreign document proof", partial("foreign_document"), "failed"],
  ["malformed revision proof", partial(selected.id, { expectedRevision: -1 }), "failed"],
  ["malformed request proof", partial(selected.id, { requestID: "" }), "failed"],
  ["generic failure", new Error("offline"), "failed"],
] as const) test(`${name} preserves inventory without granting selected authority`, async () => {
  const h = setup(false)
  fixture.detail = async () => { throw error }
  try {
    await until(() => !h.store.loading())
    assert.equal(h.store.error(), false); assert.equal(h.store.selectionError(), expected)
    assert.equal(h.store.rows().length, 8); assert.equal(h.store.next(), "aaa_7"); assert.equal(h.store.fresh(selected.id), false)
    assert.equal(holds.has(key()), false, "error response metadata never manufactures a control hold or fresh document")
  } finally { h.dispose() }
})

test("inventory failure retains its last frontier and holds, separately from detail failure", async () => {
  const h = setup()
  try {
    await until(() => !h.store.loading())
    fixture.list = async () => { h.calls.list++; throw new Error("offline") }
    h.store.refresh(); await until(() => h.store.error())
    assert.equal(h.store.rows().length, 10); assert.equal(h.store.next(), "aaa_7")
    assert.equal(h.store.selectionError(), "pending"); assert.equal(h.calls.detail.length, 1)
  } finally { h.dispose() }
})

for (const change of ["selection ABA", "scope ABA", "connection", "generation", "hide", "dispose"] as const)
test(`a late selected failure is fenced after ${change}`, async () => {
  const h = setup(), gate = deferred<MissionScheduleRead>(), started = deferred()
  fixture.detail = async id => { h.calls.detail.push(id); started.resolve(); return gate.promise }
  try {
    await started.promise
    const errors: unknown[] = []
    let stop!: () => void
    createRoot(dispose => { stop = dispose; createEffect(() => { if (h.store.selectionError()) errors.push(h.store.selectionError()) }) })
    fixture.detail = async id => { h.calls.detail.push(id); return { document: selected, pending: false } }
    if (change === "selection ABA") { h.select("other_selected"); h.select(selected.id) }
    if (change === "scope ABA") { h.setDirectory("/other"); h.setProject("other"); h.setDirectory("/repo"); h.setProject("project") }
    if (change === "connection") h.setClient({})
    if (change === "generation") h.setGeneration(1)
    if (change === "hide") h.setActive(false)
    if (change === "dispose") h.dispose()
    gate.reject(partial())
    if (change !== "dispose") await until(() => !h.store.loading() && (change === "hide" || h.store.fresh(selected.id)))
    else await gate.promise.catch(() => undefined)
    assert.deepEqual(errors, []); assert.equal(holds.get(key()), h.hold)
    stop()
  } finally { h.dispose() }
})

test("a foreign inventory never publishes a cursor or makes retained rows fresh", async () => {
  const h = setup(true, async () => ({ version: 1, projectID: "foreign", schedules: page, next: "foreign_cursor" }))
  try {
    await until(() => !h.store.loading())
    assert.equal(h.store.error(), true); assert.equal(h.store.next(), undefined)
    assert.deepEqual(h.store.rows().map(row => row.id), [selected.id, "retained_other"]); assert.equal(h.store.fresh(selected.id), false)
  } finally { h.dispose() }
})

test("a failed point refresh keeps the selected last-good display while revoking its fresh claim", async () => {
  const h = setup(false)
  fixture.detail = async () => ({ document: selected, pending: false })
  try {
    await until(() => h.store.fresh(selected.id))
    fixture.detail = async () => { throw new Error("offline") }
    h.store.refresh(); await until(() => h.store.selectionError() === "failed")
    assert.equal(h.store.rows().find(row => row.id === selected.id), selected)
    assert.equal(h.store.fresh(selected.id), false); assert.equal(h.store.error(), false)
    assert.equal(h.store.rows().length, 9); assert.equal(h.store.next(), "aaa_7")
  } finally { h.dispose() }
})

test("a successful HTTP response naming a foreign document never publishes the selected row", async () => {
  const h = setup(false)
  fixture.detail = async () => ({ document: { ...selected, id: "foreign_document" }, pending: false })
  try {
    await until(() => !h.store.loading())
    assert.equal(h.store.selectionError(), "failed"); assert.equal(h.store.rows().length, 8)
    assert.equal(h.store.fresh(selected.id), false); assert.equal(h.store.next(), "aaa_7")
  } finally { h.dispose() }
})
