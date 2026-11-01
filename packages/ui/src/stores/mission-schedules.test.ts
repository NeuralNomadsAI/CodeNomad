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
   detail: async (_id: string, _signal: AbortSignal, _input?: { requestID?: string }): Promise<MissionScheduleRead> => { throw new Error("unconfigured") },
   control: async (_instance: string, _id: string, _input: any): Promise<MissionScheduleRead> => { throw new Error("unconfigured") },
   settings: async (_instance: string, _id: string, _input: any, _write?: boolean): Promise<any> => { throw new Error("unconfigured") },
   client: () => ({}), generation: () => 0, enabled: true }
;(globalThis as any).__missionSchedulesTest = fixture
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "solid-js") return next("solid-js/dist/solid.js", context)
  const sources: Record<string, string> = {
    "../lib/api-client": `const f = globalThis.__missionSchedulesTest; export const serverApi = {
       fetchMissionSchedules: () => f.list(), fetchMissionSchedule: (_instance, id, input, signal) => f.detail(id, signal, input),
       controlMissionSchedule: (...args) => f.control(...args), missionScheduleSettings: (...args) => f.settings(...args),
       fetchMissionScheduleCapability: async () => ({ api: { available: true }, enabled: f.enabled, activation: { available: true, targets: [] } }) };`,
     "../lib/i18n": "export const useI18n = () => ({ t: key => key });",
     "../stores/alerts": "export const showConfirmDialog = async () => true;",
     "../stores/instances": "export const instances = () => new Map([['instance', { client: globalThis.__missionSchedulesTest.client() }]]);",
     "../stores/opencode-data": "export const getOpenCodeInstanceGeneration = () => globalThis.__missionSchedulesTest.generation();",
    "../lib/server-events": "export const serverEvents = { on: () => () => {}, onOpen: () => () => {} };",
    "./instances": "export const instances = () => new Map([['instance', { client: globalThis.__missionSchedulesTest.client() }]]);",
    "./opencode-data": "export const getOpenCodeInstanceGeneration = () => globalThis.__missionSchedulesTest.generation();",
    "./session-list-restoration": "export const sessionListRestored = () => true;",
    "./missions": "export const isMissionActivityEvent = () => false;",
  }
   if ((context.parentURL?.endsWith("/mission-schedules.ts") || context.parentURL?.endsWith("/mission-schedule-controls.ts")) && sources[specifier])
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(sources[specifier])}` }
  return next(specifier, context)
} })
after(() => { hooks.deregister(); delete (globalThis as any).__missionSchedulesTest })
const { createRoot, createSignal, createEffect, createMemo, untrack } = await import("solid-js")
const { useMissionSchedules, unifiedScheduleHolds: holds, changedUnifiedScheduleHolds: bump } = await import("./mission-schedules")
const { createMissionScheduleControls } = await import("../components/mission-schedule-controls")
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
  fixture.enabled = true
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
   const [client, setClient] = createSignal({}), [generation, setGeneration] = createSignal(0), [refresh, setRefresh] = createSignal(0)
  fixture.client = client; fixture.generation = generation
  const calls = { list: 0, detail: [] as string[] }
  fixture.list = async () => { calls.list++; return list ? list() : { version: 1, projectID: project(), schedules: page, next: "aaa_7" } }
  fixture.detail = async id => { calls.detail.push(id); throw partial(id) }
  let dispose!: () => void
  const store = createRoot(cleanup => { dispose = cleanup; return useMissionSchedules({ instanceId: () => "instance", projectID: project,
     directory, active, selected: selection, refresh }) })
   return { store, calls, hold, select, selection, project, directory, active, refresh,
     requestRefresh: () => setRefresh(value => value + 1), setProject, setDirectory, setActive, setClient, setGeneration, dispose }
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

// Mirror the list's keyed selected owner: dropping its sole held row disposes
// the real controls synchronously, while refresh belongs to the surviving list.
function controlsFor(h: ReturnType<typeof setup>) {
  let dispose!: () => void
  const [controls, setControls] = createSignal<ReturnType<typeof createMissionScheduleControls>>()
  const calls = { refresh: 0, deleted: 0 }
  createRoot(cleanup => {
    dispose = cleanup
    const shown = createMemo(() => h.store.rows().some(row => row.id === h.selection()) ? h.selection() : undefined)
    createEffect(() => {
      const id = shown()
      untrack(() => {
        if (!id) { setControls(undefined); return }
        const doc = createMemo<typeof selected>(previous => h.store.rows().find(row => row.id === id) ?? previous!)
        setControls(createMissionScheduleControls({ instanceId: "instance", get projectID() { return h.project() },
          get directory() { return h.directory() }, document: doc, active: h.active,
          enabled: () => h.store.fresh(id), refreshVersion: h.refresh,
          refresh: () => { calls.refresh++; h.requestRefresh() },
          onDeleted: () => { calls.deleted++; h.select(undefined) } }))
      })
    })
  })
  return { controls, calls, dispose }
}
const running = { ...selected, state: "running" as const, availableActions: ["pause", "stop", "configure", "delete"] as typeof selected.availableActions }
const confirmed = (hold: ReturnType<typeof setup>["hold"]): MissionScheduleRead => ({ pending: false,
  document: { ...running, control: { action: hold.action, requestID: hold.requestID, expectedRevision: hold.expectedRevision, pending: false } } })

test("a native pre-write refusal releases only the matching UI control and keeps Stop available", async () => {
  for (const exact of [true, false]) {
    const h = setup(false), c = controlsFor(h), doc = { ...selected, availableActions: ["play", "stop"] as typeof selected.availableActions }
    try {
      fixture.detail = async () => ({ pending: false, document: doc })
      await until(() => h.store.fresh(selected.id) && c.controls()?.capability() === "available")
      fixture.control = async (_instance, id, input) => {
        throw new HttpResponseError("refused", 409, null, "schedule-refused", { pending: false,
          refusal: { missionID: id, action: input.action, requestID: exact ? input.requestID : "different_request", expectedRevision: input.expectedRevision } })
      }
      await c.controls()!.act("play")
      assert.equal(holds.has(key()), !exact)
      assert.equal(c.controls()!.capable("stop"), exact)
      assert.equal(c.calls.deleted, 0)
    } finally { c.dispose(); h.dispose() }
  }
})

for (const negativeFirst of [false, true]) test(`${negativeFirst ? "negative then positive" : "FIRST positive"} cold receipt refreshes the real store after its selected controller disposes`, async () => {
  const h = setup(), c = controlsFor(h), requests: string[] = []
  try {
    await until(() => !h.store.loading())
    assert.equal(h.store.selectionError(), "pending"); assert.equal(h.store.fresh(selected.id), false)
    const original = h.hold
    fixture.detail = async (_id, _signal, input) => {
      if (input?.requestID) { requests.push(input.requestID); return negativeFirst && requests.length === 1 ? { pending: true, document: null } : confirmed(original) }
      return { pending: false, document: running }
    }
    if (negativeFirst) { await c.controls()!.reconcile(); assert.equal(holds.get(key()), original) }
    const owner = c.controls()!
    await owner.reconcile()
    assert.ok(c.calls.refresh > 0, "the live parent is invalidated before removing the sole selected display owner")
    await until(() => h.store.fresh(selected.id) && c.controls()?.capability() === "available")
    assert.notEqual(c.controls(), owner, "the old hold-only detail really was disposed")
    assert.equal(holds.has(key()), false); assert.equal(c.controls()!.capable("pause"), true)
    assert.equal(h.store.selectionError(), undefined); assert.equal(h.store.next(), "aaa_7"); assert.equal(h.store.rows().length, 10)
    assert.deepEqual(requests, Array(negativeFirst ? 2 : 1).fill("original_request"))
    assert.equal(original.expectedRevision, 7); assert.ok(c.calls.refresh > 0)
  } finally { c.dispose(); h.dispose() }
})

for (const positive of [false, true]) for (const change of ["selection", "selection ABA", "scope", "scope ABA", "client", "generation", "hide", "dispose"] as const)
test(`late ${positive ? "positive" : "negative"} receipt after ${change} only settles exact bookkeeping`, async () => {
  const h = setup(), c = controlsFor(h), gate = deferred<MissionScheduleRead>(), started = deferred()
  try {
    await until(() => !h.store.loading())
    fixture.detail = async (_id, _signal, input) => {
      if (input?.requestID) { started.resolve(); return gate.promise }
      return { pending: false, document: running }
    }
    const owner = c.controls()!, read = owner.reconcile()
    await started.promise
    if (change.startsWith("selection")) { h.select("retained_other"); if (change.endsWith("ABA")) h.select(selected.id) }
    if (change.startsWith("scope")) { h.setDirectory("/other"); if (change.endsWith("ABA")) h.setDirectory("/repo") }
    if (change === "client") h.setClient({})
    if (change === "generation") h.setGeneration(1)
    if (change === "hide") h.setActive(false)
    if (change === "dispose") c.dispose()
    const before = { ...c.calls }
    gate.resolve(positive ? confirmed(h.hold) : { pending: true, document: null }); await read
    assert.deepEqual(c.calls, before, "old receipt never refreshes or navigates the destination")
    assert.equal(holds.has(key()), !positive)
  } finally { c.dispose(); h.dispose() }
})

test("a cold chained Check reads the original identity before releasing its sole selected owner", async () => {
  const h = setup(), original = h.hold, check = { ...original, action: "check" as const, requestID: "check_request", original }
  holds.set(key(), check); bump()
  const c = controlsFor(h), requests: string[] = []
  try {
    await until(() => !h.store.loading())
    fixture.detail = async (_id, _signal, input) => {
      if (!input?.requestID) return { pending: false, document: running }
      requests.push(input.requestID)
      return { pending: false, document: { ...running, control: { action: input.requestID === check.requestID ? "check" : "play",
        requestID: input.requestID, expectedRevision: 7, pending: false } } }
    }
    await c.controls()!.reconcile(); await until(() => h.store.fresh(selected.id))
    assert.deepEqual(requests, [check.requestID, original.requestID]); assert.equal(holds.has(key()), false)
    assert.equal(c.controls()!.capable("pause"), true); assert.equal(h.store.next(), "aaa_7")
  } finally { c.dispose(); h.dispose() }
})

for (const replaced of [false, true]) test(`a stale chained positive Check ${replaced ? "preserves a newer hold" : "retains its original without dispatching a new read"}`, async () => {
  const h = setup(), original = h.hold, check = { ...original, action: "check" as const, requestID: "check_request", original }
  holds.set(key(), check); bump()
  const c = controlsFor(h), gate = deferred<MissionScheduleRead>(), started = deferred()
  let requests = 0
  try {
    await until(() => !h.store.loading())
    fixture.detail = async () => { requests++; started.resolve(); return gate.promise }
    const read = c.controls()!.reconcile(); await started.promise
    c.dispose()
    const newer = { ...original, requestID: "newer_request" }
    if (replaced) { holds.set(key(), newer); bump() }
    gate.resolve({ pending: false, document: { ...running, control: { action: "check", requestID: check.requestID, expectedRevision: 7, pending: false } } })
    await read
    assert.equal(holds.get(key()), replaced ? newer : original); assert.equal(requests, 1); assert.equal(c.calls.refresh, 0)
  } finally { c.dispose(); h.dispose() }
})

for (const action of ["activation", "delete"] as const) test(`cold first-positive ${action} settles before its sole display owner disposes`, async () => {
  const h = setup(), hold = { ...h.hold, phase: action === "activation" ? "activation" as const : "control" as const,
    action: action === "activation" ? "play" as const : "delete" as const }
  holds.set(key(), hold); bump()
  const c = controlsFor(h)
  try {
    await until(() => !h.store.loading())
    fixture.settings = async (_instance, id, input, write) => {
      assert.equal(id, selected.id); assert.deepEqual(input, { requestID: "original_request", expectedDocumentRevision: 7 }); assert.equal(write, undefined)
      return { document: { scheduleActivation: { requestID: hold.requestID, expectedRevision: 7, state: "ready" } } }
    }
    fixture.detail = async (_id, _signal, input) => input?.requestID
      ? { pending: false, document: null, deleted: true, deletionReceipt: { id: selected.id, requestID: hold.requestID, expectedRevision: 7, deleteManagedSessions: false } }
      : action === "delete" ? { pending: false, document: null } : { pending: false, document: selected }
    await c.controls()!.reconcile()
    assert.equal(holds.has(key()), false); assert.ok(c.calls.refresh > 0)
    assert.equal(c.calls.deleted, action === "delete" ? 1 : 0)
    if (action === "activation") await until(() => h.store.fresh(selected.id))
    else assert.equal(h.selection(), undefined)
  } finally { c.dispose(); h.dispose() }
})

for (const action of ["activation", "delete"] as const) for (const positive of [false, true])
for (const change of ["selection", "scope ABA", "client", "dispose"] as const)
test(`late ${positive ? "positive" : "negative"} ${action} confirmation after ${change} keeps the destination untouched`, async () => {
  const h = setup(), hold = { ...h.hold, phase: action === "activation" ? "activation" as const : "control" as const,
    action: action === "activation" ? "play" as const : "delete" as const }
  holds.set(key(), hold); bump()
  const c = controlsFor(h), gate = deferred<any>(), started = deferred()
  try {
    await until(() => !h.store.loading())
    fixture.settings = async () => { started.resolve(); return gate.promise }
    fixture.detail = async (_id, _signal, input) => {
      if (input?.requestID) { started.resolve(); return gate.promise }
      return { pending: false, document: running }
    }
    const read = c.controls()!.reconcile(); await started.promise
    if (change === "selection") h.select("retained_other")
    if (change === "scope ABA") { h.setDirectory("/other"); h.setDirectory("/repo") }
    if (change === "client") h.setClient({})
    if (change === "dispose") c.dispose()
    const before = { ...c.calls }
    gate.resolve(action === "activation" ? { document: { scheduleActivation: { requestID: hold.requestID, expectedRevision: 7, state: positive ? "ready" : "pending" } } }
      : { pending: !positive, document: null, deleted: positive, ...(positive ? { deletionReceipt: { id: selected.id,
        requestID: hold.requestID, expectedRevision: 7, deleteManagedSessions: false } } : {}) })
    await read
    assert.deepEqual(c.calls, before); assert.equal(holds.has(key()), !positive)
  } finally { c.dispose(); h.dispose() }
})

for (const action of ["pause", "check", "activation"] as const) for (const positive of [false, true])
test(`late ${positive ? "positive" : "negative"} ${action} POST cannot start receipt reads or another control on a replaced client`, async () => {
  const h = setup(action === "check"), c = controlsFor(h), gate = deferred<any>(), started = deferred()
  const calls = { control: 0, settings: 0, detail: 0 }
  try {
    fixture.detail = async () => ({ pending: false, document: action === "pause" ? running : { ...selected, availableActions: ["play", "check"] } })
    await until(() => h.store.fresh(selected.id) && c.controls()?.capability() === "available")
    if (action === "activation") fixture.enabled = false
    fixture.detail = async () => { calls.detail++; return { pending: false, document: action === "pause" ? running : { ...selected, availableActions: ["play", "check"] } } }
    fixture.control = async () => { calls.control++; started.resolve(); return gate.promise }
    fixture.settings = async (_instance, _id, _input, write) => { assert.equal(write, true); calls.settings++; started.resolve(); return gate.promise }
    const pending = c.controls()!.act(action === "activation" ? "play" : action)
    await started.promise
    const request = holds.get(key())!
    h.setClient({})
    // Replacement-client inventory reconciliation is independent of the old POST.
    await until(() => !h.store.loading())
    const before = { ...calls }, effects = { ...c.calls }
    gate.resolve(action === "activation" ? { document: { revision: 2, scheduleActivation: { requestID: request.requestID, expectedRevision: request.expectedRevision,
      state: positive ? "ready" : "pending" } } }
      : { pending: !positive, document: { ...running, control: { action, requestID: request.requestID, expectedRevision: request.expectedRevision, pending: !positive } } })
    await pending
    assert.deepEqual(calls, before); assert.deepEqual(c.calls, effects)
    assert.equal(calls.control, action === "activation" ? 0 : 1); assert.equal(calls.settings, action === "activation" ? 1 : 0)
    assert.equal(holds.has(key()), !(positive && action !== "check"))
  } finally { c.dispose(); h.dispose() }
})
