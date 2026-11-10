import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import ts from "typescript"
import { createEffect, createMemo, createRoot, createSignal, mapArray, on, onCleanup, untrack } from "solid-js"

// Run production consumer bodies/effects, with transport and view owners injected.
// Local and remote transports are deliberately distinct: reverting a consumer to
// the singleton fails at dispatch, even when the API layer itself still routes.
function production(path: string, name: string, scope: Record<string, any>, marker?: string) {
  const file = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found: ts.Node | undefined
  const visit = (node: ts.Node) => {
    if (!marker && ts.isFunctionDeclaration(node) && node.name?.text === name) found = node
    if (!marker && ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer) found = node.initializer
    if (marker && ts.isCallExpression(node) && node.expression.getText(file) === name
      && node.arguments[0]?.getText(file).includes(marker)) found = node.arguments[0]
    ts.forEachChild(node, visit)
  }
  visit(file); assert.ok(found, `${path}: ${name}`)
  const text = found.getText(file).replace(/^export\s+/, "")
  const code = ts.transpileModule(`(${text})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function("scope", `with (scope) { return ${code} }`)(scope)
}
function deferred() {
  let resolve!: (value?: any) => void
  const promise = new Promise<any>(accept => { resolve = accept })
  return { promise, resolve }
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const solid = { createEffect, createMemo, createSignal, mapArray, on, onCleanup, untrack }
const id = "remote~same"
function fixture(api: Record<string, any>) {
  let controller = new AbortController()
  const [signal, setSignal] = createSignal(controller.signal)
  const owners: string[] = [], localCalls: string[] = []
  return { ...solid, owners, localCalls,
    backendOf: (owner: string) => { assert.equal(owner, id); owners.push(owner); return { api } },
    serverApi: new Proxy({}, { get: (_target, method) => () => { localCalls.push(String(method)); assert.fail("local singleton reached") } }),
    captureBackendOperation: (owner: string, parent?: AbortSignal, owns = () => true) => {
      assert.equal(owner, id)
      const captured = parent ? AbortSignal.any([signal(), parent]) : signal()
      return { signal: captured, current: () => !captured.aborted && owns() }
    },
    replace: () => { controller.abort(); controller = new AbortController(); setSignal(controller.signal) },
    revoke: () => controller.abort(),
  }
}

test("playbook routes by instance; late A never replaces B", async () => {
  const reads: ReturnType<typeof deferred>[] = [], env = fixture({ fetchMissionPlaybooks: () => {
    const read = deferred(); reads.push(read); return read.promise
  } })
  let details: any, dispose!: () => void
  const effect = production("./mission-playbook-reader.tsx", "createEffect", { ...env,
    props: { instanceId: id, taskMode: "native" }, attempt: () => 0, setFailed: () => {}, setDetails: (value: any) => { details = value },
  }, "fetchMissionPlaybooks")
  createRoot(close => { dispose = close; createEffect(effect) })
  assert.equal(env.owners.length, 1)
  env.replace(); reads[1].resolve({ source: "B" }); await flush()
  reads[0].resolve({ source: "A" }); await flush()
  assert.deepEqual(details, { source: "B" }); dispose()
})

test("lifecycle control uses remote owner; revoked ACK cannot refresh", async () => {
  const read = deferred(), env = fixture({ controlMission: () => read.promise }), mission = { id: "m", revision: 1 }
  let refreshes = 0
  const run = production("./mission-lifecycle-controls.tsx", "act", { ...env,
    props: { instanceId: id, mission }, identity: () => "scope", location: () => ({}), epoch: 0, alive: true, attempt: 0,
    active: () => true, busy: () => false, retry: () => false, pending: () => false, full: () => false,
    missionLifecycleIntents: { reserve: (_scope: string, _mission: string, input: any) => ({ input }), start: () => true, finish: () => true },
    missionLifecycleSource: () => "scope", missionStore: { refresh: async () => { refreshes++ } }, setRefreshing: () => {},
  })
  const pending = run("pause"); assert.equal(env.owners.length, 1)
  env.replace(); read.resolve({ mission }); await pending; assert.equal(refreshes, 0)
})

test("recovery admission is remote; detached completion cannot notify the view", async () => {
  const read = deferred(), env = fixture({ recoverMission: () => read.promise })
  let publications = 0
  const run = production("./mission-recovery-button.tsx", "recover", { ...env,
    props: { instanceId: id, mission: { id: "m", revision: 1 }, target: "coordinator", onAdmitted: () => { publications++ } },
    eligible: () => true, state: () => undefined, key: () => "request", disposed: false,
    markAttempt: () => {}, setError: () => {},
  })
  const pending = run(); assert.equal(env.owners.length, 1)
  env.replace(); read.resolve({ admitted: true }); await pending; assert.equal(publications, 0)
})

test("cleanup remote preflight cannot delete after detachment", async () => {
  const read = deferred(); let deletes = 0, refreshes = 0
  const env = fixture({ fetchMission: () => read.promise, deleteMission: async () => { deletes++ } })
  const saved = { missionID: "m", deletionID: "d", requestID: "r", expectedRevision: 1, deleteManagedSessions: false }
  const run = production("./mission-cleanup.tsx", "retry", { ...env,
    props: { instanceId: id, active: true, disabled: false, refresh: () => { refreshes++ } },
    pending: () => "", rows: () => new Map([["row", saved]]), missionCleanupPending: () => true,
    captureView: () => () => true, attempt: 0, alive: true, setPending: () => {}, setError: () => {},
  })
  const pending = run("row"); assert.equal(env.owners.length, 1)
  env.replace(); read.resolve({ available: true, cleanups: [saved] }); await pending
  assert.equal(deletes, 0); assert.equal(refreshes, 0)
})

// These routing cases opt out of automatic start; either unexpected opt-in or continuation fails.
const editorStart = { startOnCreation: () => false, captureStart: (requested: boolean) => {
  if (requested) throw new Error("Unexpected automatic start opt-in")
  return async () => { throw new Error("Unexpected automatic start continuation") }
} }

test("editor creation dispatch is remote; stale completion preserves the current view", async () => {
  const read = deferred(), env = fixture({ createMission: () => read.promise }), action = {}
  const run = production("./mission-editor.tsx", "save", { ...env, ...editorStart, kind: "create", action, lastPayload: "", requestId: "r",
    props: { instanceId: id, action, onSaved: () => assert.fail("stale editor publication") },
    locked: () => false, isActive: () => true, setFieldError: () => {}, structuralLocked: () => true,
    immediateCreationFollowed: () => false, mode: () => "once", schedule: { unified: false },
    uncertainRecurrence: () => undefined, missionCreationHold: () => undefined, identity: () => "view",
    captureView: () => env.captureBackendOperation(id).current, objective: () => "draft", notes: () => "", template: () => "custom",
    taskMode: () => undefined, effectiveProfiles: () => undefined, submittedTitle: () => "title", selectedModel: () => undefined,
    missionCreationPayloadIdentity: JSON.stringify, holdMissionCreation: () => true, setShownRequestId: () => {}, setAdopted: () => {},
    setPending: () => {}, setError: () => {}, releaseMissionCreation: () => {},
  })
  const pending = run({ preventDefault() {} }); assert.equal(env.owners.length, 1)
  env.replace(); read.resolve({ mission: {} }); await pending
})

test("editor schedule preflight is remote; detachment blocks configure dispatch", async () => {
  const read = deferred(); let writes = 0
  const env = fixture({ fetchMissionSchedule: () => read.promise, saveMissionSchedule: () => { writes++ } })
  const run = production("./mission-editor-schedule.ts", "save", { ...env,
    props: { instanceId: id, directory: "/repo", scope: () => "scope" }, held: () => undefined, unified: true, target: "m",
    capture: () => env.captureBackendOperation(id).current, document: () => ({ revision: 1 }),
  })
  const pending = run({}, "request"); assert.equal(env.owners.length, 1)
  env.replace(); read.resolve({ document: { id: "m", revision: 1 } }); assert.equal(await pending, "stale"); assert.equal(writes, 0)
})

test("schedule controls never advance a detached preflight into confirmation or write", async () => {
  const read = deferred(); let writes = 0
  const env = fixture({ fetchMissionSchedule: () => read.promise, controlMissionSchedule: () => { writes++ } })
  const run = production("./mission-schedule-controls.ts", "act", { ...env,
    props: { instanceId: id, directory: "/repo", document: () => ({ id: "m", revision: 1 }), refresh: () => assert.fail("stale refresh") },
    capable: () => true, capture: () => env.captureBackendOperation(id).current, identity: () => "scope", held: () => undefined,
    setBusy: () => {}, setFeedback: () => {},
  })
  const pending = run("stop"); assert.equal(env.owners.length, 1)
  env.replace(); read.resolve({ document: { id: "m", revision: 1 } }); await pending; assert.equal(writes, 0)
})

for (const kind of ["schedule-success", "mission-completed", "branch-commits"] as const) {
  test(`editor source ${kind} uses remote API and rejects late source rows`, async () => {
    const read = deferred(), env = fixture({ fetchMissionSchedules: () => read.promise, fetchLocalGitBranches: () => read.promise })
    let dispose!: () => void
    const timers = new Map<number, () => void>()
    let timerId = 0
    const create = production("./mission-editor-sources.ts", "createMissionEditorSources", { ...env, getOpenCodeInstanceGeneration: () => 1,
      setTimeout: (callback: () => void) => { const key = ++timerId; timers.set(key, callback); return key },
      clearTimeout: (key: number) => timers.delete(key),
    })
    const reader = createRoot(close => { dispose = close; return create({ instanceId: id, projectID: "p", directory: () => "/repo",
      kinds: () => [kind], selected: () => [], active: () => true, captureView: () => () => true }) })
    for (const [key, timer] of timers) { timers.delete(key); timer() }
    reader.loading(); assert.equal(env.owners.length, 1)
    env.revoke(); read.resolve({ projectID: "p", schedules: [{ id: "source", kind: "schedule", configuration: { title: "source" } }], branches: ["refs/heads/dev"] })
    await flush(); assert.deepEqual(reader.sources(), {}); dispose()
  })
}

test("daily recurrence controls route remotely and reject stale view effects", async () => {
  const read = deferred(), env = fixture({ controlMissionRecurrence: () => read.promise })
  const run = production("./mission-recurrence-list.tsx", "act", { ...env,
    props: { instanceId: id, schedule: { id: "s", revision: 1 }, directory: "/repo" }, generation: 1,
    retryCapable: () => true, capable: () => true, key: () => "scope", createRecurrenceControlIntent: () => ({ requestID: "r", scheduleID: "s" }),
    unresolved: new Map(), setHeld: () => {}, setBusy: () => {}, setRefusal: () => {}, finish: () => assert.fail("stale recurrence publication"),
  })
  const pending = run("pause"); assert.equal(env.owners.length, 1)
  env.replace(); read.resolve({}); await pending
})

test("current passage content dispatches remotely and fences detached prose", async () => {
  const read = deferred(), env = fixture({ fetchMissionCurrentContent: () => read.promise }), instance = { folder: "/repo", client: {} }
  let publications = 0, dispose!: () => void
  const effect = production("./mission-passage-section.tsx", "createEffect", { ...env,
    props: { instanceId: id, source: { projectID: "p", missionID: "m" }, page: 0, onPageCount: () => { publications++ } },
    instances: () => new Map([[id, instance]]), getOpenCodeInstanceGeneration: () => 1,
    cache: new Map(), setValue: () => {}, setError: () => {},
  }, "fetchMissionCurrentContent")
  createRoot(close => { dispose = close; createEffect(effect) }); assert.equal(env.owners.length, 1)
  env.revoke(); read.resolve({}); await flush(); assert.equal(publications, 0); dispose()
})

test("archive passage dispatches remotely and fences detached prose", async () => {
  const read = deferred(), env = fixture({ fetchMissionRecurrencePassagePage: () => read.promise }), client = {}
  const [value, setValue] = createSignal<any>(); let dispose!: () => void
  const effect = production("./mission-recurrence-passage-reader.tsx", "createEffect", { ...env,
    props: { instanceId: id, projectID: "p", scheduleID: "s", receipt: {} },
    binding: () => "identity", section: () => 0, page: () => 0, refresh: () => 0, previousRefresh: 0,
    previous: "", previousClient: undefined, previousGeneration: undefined, previousSignal: undefined,
    connection: () => ({ client, generation: 1, signal: env.captureBackendOperation(id).signal }),
    instances: () => new Map([[id, { folder: "/repo", client, metadata: { project: { id: "p" } } }]]),
    getOpenCodeInstanceGeneration: () => 1, cache: new Map(), value, setValue, setError: () => {}, setLoading: () => {},
  }, "fetchMissionRecurrencePassagePage")
  createRoot(close => { dispose = close; createEffect(effect) }); assert.equal(env.owners.length, 1)
  env.revoke(); read.resolve({}); await flush(); assert.equal(value(), undefined); dispose()
})

test("depth setting reads remotely; detached response cannot adopt the new depth", async () => {
  const read = deferred(), env = fixture({ getSubagentDepth: () => read.promise }), client = {}
  let state: any = { draft: "2", phase: "ready", dirty: false }, adopted = 0
  const target = { request: 0, state: [() => state, (value: any) => { state = value; if (value.snapshot) adopted++ }] }
  const run = production("./mission-subagent-depth.tsx", "read", { ...env,
    props: { instanceId: id, directory: "/repo", active: () => true }, entry: () => target, busy: () => false,
    capture: () => env.captureBackendOperation(id).current, readEpoch: 0, controller: undefined,
    instances: () => new Map([[id, { client }]]), getOpenCodeInstanceGeneration: () => 1,
  })
  const pending = run(false); assert.equal(env.owners.length, 1)
  env.replace(); read.resolve({ location: { directory: "/repo" }, capability: {}, project: { depth: 3 } }); await pending
  assert.equal(adopted, 0)
})

test("depth writes stay on their owner and a detached acknowledgement never starts another read", async () => {
  const write = deferred(), env = fixture({ setSubagentDepth: () => write.promise }), client = {}
  let state: any = { draft: "3", dirty: true, phase: "ready", snapshot: { location: { directory: "/repo" }, project: { expectation: "expected" } } }
  let reads = 0
  const target = { request: 0, state: [() => state, (value: any) => { state = value }] }
  const run = production("./mission-subagent-depth.tsx", "save", { ...env,
    props: { instanceId: id }, disabled: () => false, locked: () => false, state: () => state, valid: () => true,
    entry: () => target, depth: () => 3, capture: () => env.captureBackendOperation(id).current,
    instances: () => new Map([[id, { client }]]), getOpenCodeInstanceGeneration: () => 1, read: () => { reads++ },
  })
  const pending = run(); assert.equal(env.owners.length, 1)
  env.revoke(); write.resolve(); await pending
  assert.equal(reads, 0); assert.equal(state.phase, "uncertain")
})

test("native profile catalogue uses the instance root and cannot publish after detach", async () => {
  const read = deferred(), env = fixture({}), client = {}, owners: string[] = [], timers: (() => Promise<void>)[] = []
  let published = 0, dispose!: () => void
  const effect = production("./mission-profile-controls.tsx", "createEffect", { ...env,
    props: { instanceId: id, directory: "/repo" }, refresh: () => 0, identity: () => "identity", instanceClient: () => client, demanded: () => true,
    getOpenCodeInstanceGeneration: () => 1, instances: () => new Map([[id, { client }]]),
    createRequestLocation: (directory: string) => ({ directory }), toRequestLocation: (value: any) => value, requestLocationOptions: () => ({}),
    setTimeout: (callback: () => Promise<void>) => { timers.push(callback); return 1 }, clearTimeout: () => {},
    setLoading: () => {}, setFailed: () => {}, setFailure: () => {}, setCatalog: () => { published++ },
    catalogModelKey: (provider: string, model: string) => `${provider}/${model}`, buildProviderCatalog: () => ({}), catalogModels: () => [],
    rememberModelNames: (owner: string) => { assert.equal(owner, id) },
    getRootClient: (owner: string) => { owners.push(owner); return {
      agent: { list: () => read.promise }, model: { list: () => read.promise }, provider: { list: () => read.promise },
    } },
  }, "native.agent.list")
  createRoot(close => { dispose = close; createEffect(effect) })
  const pending = timers[0](); assert.deepEqual(owners, [id])
  env.revoke(); read.resolve({ data: [] }); await pending
  assert.equal(published, 0); dispose()
})

function scheduleScope(api: Record<string, any>) {
  const env = fixture(api), accepted: any[] = [], released: string[] = []
  const mission = { id: "m", revision: 1 }
  const configuration = { objective: "objective", notes: "notes" }
  const doc = { id: "m", revision: 1, kind: "one-time", configuration, edit: { reason: null }, observation: { state: "complete" } }
  const scope: Record<string, any> = { ...env, accepted, released, doc, mission, target: "m", unified: true,
    props: { instanceId: id, directory: "/repo", action: {}, active: () => true, scope: () => "scope",
      captureDraft: () => ({}), onSaved: (...args: any[]) => accepted.push(args), onLoad: (value: any) => accepted.push(value) },
    capture: () => env.captureBackendOperation(id).current, held: () => undefined, reading: () => false, retryable: () => true,
    document: () => doc, journal: () => mission, holdMissionScheduleEditor: () => true,
    releaseMissionScheduleEditor: (_scope: string, request: string) => released.push(request), retainMissionScheduleEditor: () => {},
    exactMissionScheduleEditorReceipt: () => true, refusedMissionScheduleReceipt: () => false,
    HttpResponseError: class extends Error {}, MissionMutationError: class extends Error {},
    setReading: () => {}, setRetryable: () => {}, setFailed: () => {}, setReady: () => {}, setConflict: () => {}, setDocument: () => {},
    setPreviousDraft: () => {}, comparison: () => "draft", setJournal: () => {}, adopt: (value: any) => accepted.push(value),
    readText: async () => configuration,
    readBody: async (_mission: any, selector: any) => ({ after: selector.field === "objective" ? "objective" : "notes" }),
    partialPreparation: () => true,
  }
  return scope
}

test("schedule journal edit dispatches its exact remote mutation", async () => {
  const calls: any[] = []
  const scope = scheduleScope({ editMission: async (...args: any[]) => { calls.push(args); return { mission: { id: "m" } } } })
  const run = production("./mission-editor-schedule.ts", "saveJournalEdit", scope)
  await run({ objective: "objective", notes: "notes", requestID: "r" })
  assert.deepEqual(calls, [[id, "m", { objective: "objective", notes: "notes", requestId: "r", expectedRevision: 1 }]])
  assert.deepEqual(scope.released, ["r"]); assert.equal(scope.accepted.length, 1)
})

for (const unified of [false, true]) {
  test(`schedule save ${unified ? "configure" : "create"} reaches the remote write after preflight`, async () => {
    const calls: any[] = []
    const scope = scheduleScope({
      fetchMissionSchedule: async (...args: any[]) => { calls.push(["read", ...args]); return { document: scope.doc } },
      saveMissionSchedule: async (...args: any[]) => { calls.push(["write", ...args]); return { document: scope.doc } },
    })
    scope.unified = unified
    const run = production("./mission-editor-schedule.ts", "save", scope)
    assert.equal(await run({ objective: "draft" }, "r"), "saved")
    assert.deepEqual(calls.map(call => call[0]), unified ? ["read", "write"] : ["write"])
    const write = calls.at(-1)!
    assert.equal(write[1], id); assert.equal(write[2].action, unified ? "configure" : "create")
    assert.equal(write[2].requestID, "r"); assert.deepEqual(scope.released, ["r"])
    assert.equal(scope.accepted.length, 1)
  })
}

for (const representation of ["journal", "unified-journal", "schedule"] as const) {
  test(`schedule reload ${representation} executes each owning read`, async () => {
    const calls: string[] = []
    const scope = scheduleScope({
      fetchMission: async (owner: string) => { assert.equal(owner, id); calls.push("journal"); return { available: true, mission: scope.mission } },
      fetchMissionSchedule: async (owner: string) => { assert.equal(owner, id); calls.push("document"); return { document: scope.doc } },
    })
    scope.unified = representation !== "journal"
    if (representation === "schedule") scope.props.action.scheduleID = "m"
    await production("./mission-editor-schedule.ts", "reload", scope)()
    assert.deepEqual(calls, representation === "journal" ? ["journal"] : representation === "schedule" ? ["document"] : ["journal", "document"])
    assert.equal(scope.accepted.length, 1)
  })
}

test("schedule editor body callback reads remote content and returns its slice", async () => {
  const calls: any[] = [], scope = scheduleScope({ fetchMissionContent: async (...args: any[]) => { calls.push(args); return { text: "body" } } })
  scope.readMissionEditorBody = (_mission: any, selector: any, read: (query: any) => Promise<any>) => read(selector)
  const selector = { kind: "mission", field: "objective", offset: 0 }
  const result = await production("./mission-editor-schedule.ts", "readBody", scope)(scope.mission, selector, () => true)
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].slice(0, 3), [id, "m", selector]); assert.deepEqual(result, { text: "body" })
})

for (const kind of ["journal", "unified-journal", "configure", "create"] as const) {
  test(`schedule reconcile ${kind} reaches its own receipt endpoint`, async () => {
    const calls: string[] = [], request = kind.endsWith("journal")
      ? { missionID: "m", requestID: "r", expectedRevision: 1, objective: "objective", notes: "notes" }
      : { action: kind, requestID: "r", expectedRevision: 1, directory: "/repo", ...(kind === "configure" ? { missionID: "m" } : {}) }
    const scope = scheduleScope({
      fetchMission: async (owner: string) => { assert.equal(owner, id); calls.push("journal"); return { available: true, mission: {
        id: "m", document: kind === "unified-journal" ? {} : undefined, history: [{ source: "user", requestID: "r", revision: 2 }],
      } } },
      fetchMissionSchedule: async (owner: string) => { assert.equal(owner, id); calls.push("document"); return { document: scope.doc } },
      fetchMissionScheduleCreation: async (owner: string, requestID: string) => { assert.equal(owner, id); assert.equal(requestID, "r"); calls.push("creation"); return { document: scope.doc } },
    })
    scope.held = () => ({ payload: JSON.stringify(request) })
    await production("./mission-editor-schedule.ts", "reconcile", scope)()
    assert.deepEqual(calls, kind === "unified-journal" ? ["journal", "document"] : kind === "journal" ? ["journal"] : kind === "create" ? ["creation"] : ["document"])
    assert.deepEqual(scope.released, ["r"]); assert.equal(scope.accepted.length, 1)
  })
}

test("schedule retry preparation reads the original receipt then dispatches the original remote retry", async () => {
  const calls: any[] = [], request = { action: "configure", missionID: "m", requestID: "r", expectedRevision: 1, directory: "/repo" }
  const scope = scheduleScope({
    fetchMissionSchedule: async (...args: any[]) => { calls.push(["read", ...args]); return { document: scope.doc } },
    saveMissionSchedule: async (...args: any[]) => { calls.push(["retry", ...args]); return { document: scope.doc } },
  })
  const hold = { payload: JSON.stringify(request) }; scope.held = () => hold
  await production("./mission-editor-schedule.ts", "retryPreparation", scope)()
  assert.deepEqual(calls.map(call => call[0]), ["read", "retry"])
  assert.deepEqual(calls[0].slice(1), [id, "m", { directory: "/repo", requestID: "r" }])
  assert.deepEqual(calls[1].slice(1), [id, { ...request, retry: true }]); assert.deepEqual(scope.released, ["r"])
})

function editorScope(api: Record<string, any>, kind: "edit" | "delete") {
  const env = fixture(api), action = {}, saved: any[] = [], errors: string[] = []
  const scope: Record<string, any> = { ...env, ...editorStart, kind, action, original: { id: "m", revision: 1 }, lastPayload: "", requestId: "r",
    props: { instanceId: id, directory: "/repo", action, onSaved: (...args: any[]) => saved.push(args) }, saved, errors,
    locked: () => false, isActive: () => true, structuralLocked: () => true, textLocked: () => false,
    immediateCreationFollowed: () => false, mode: () => "once", captureView: () => env.captureBackendOperation(id).current,
    objective: () => "objective", notes: () => "notes", template: () => "custom", identity: () => "scope",
    schedule: { unified: false, journal: () => ({ revision: 1 }) }, selectedModel: () => undefined,
    deleteManagedSessions: () => false, deleteAttempted: () => false, setDeleteAttempted: () => {},
    setPending: () => {}, setError: (error: string) => errors.push(error), setFieldError: () => {},
    missionCleanupPending: () => false, deletionErrorKey: () => "deletion-error", t: (key: string) => key,
    MissionDeletionError: class extends Error {}, missionStore: { refresh: async () => {} },
  }
  return scope
}

test("editor Edit continues through the real journal-edit consumer", async () => {
  const calls: any[] = [], editor = editorScope({}, "edit")
  const schedule = scheduleScope({ editMission: async (...args: any[]) => { calls.push(args); return { mission: { id: "m" } } } })
  editor.schedule.saveJournalEdit = production("./mission-editor-schedule.ts", "saveJournalEdit", schedule)
  await production("./mission-editor.tsx", "save", editor)({ preventDefault() {} })
  assert.equal(calls.length, 1); assert.equal(calls[0][0], id); assert.deepEqual(schedule.released, ["r"])
})

for (const path of ["first-delete", "retry-preflight", "lost-ack-reconciliation"] as const) {
  test(`editor ${path} executes its distinct remote delete/read continuation`, async () => {
    const calls: string[] = [], cleanup = { missionID: "m", requestID: "r", expectedRevision: 1, deleteManagedSessions: false }
    const scope = editorScope({
      deleteMission: async (owner: string) => { assert.equal(owner, id); calls.push("delete"); if (path === "lost-ack-reconciliation") throw new Error("ACK lost") },
      fetchMission: async (owner: string) => { assert.equal(owner, id); calls.push("read"); return { available: true, cleanups: [cleanup] } },
    }, "delete")
    scope.deleteAttempted = () => path === "retry-preflight"
    // Preflight's positive receipt settles without another delete; lost ACK uses
    // the separate catch-path point read, never a replay.
    await production("./mission-editor.tsx", "save", scope)({ preventDefault() {} })
    assert.deepEqual(calls, path === "first-delete" ? ["delete"] : path === "retry-preflight" ? ["read"] : ["delete", "read"])
    assert.deepEqual(scope.localCalls, []) // A swallowed preflight failure must not masquerade as catch-path reconciliation.
    assert.equal(scope.saved.length, 1); assert.deepEqual(scope.errors, [""])
  })
}

test("cleanup retry reaches remote deletion after its positive intent read", async () => {
  const calls: string[] = [], saved = { missionID: "m", deletionID: "d", requestID: "r", expectedRevision: 1, deleteManagedSessions: false }
  const env = fixture({ fetchMission: async () => { calls.push("read"); return { available: true, cleanups: [saved] } },
    deleteMission: async (owner: string, mission: string, input: any) => {
      assert.equal(owner, id); assert.equal(mission, "m"); assert.equal(input.requestId, "r"); calls.push("delete")
    } })
  await production("./mission-cleanup.tsx", "retry", { ...env,
    props: { instanceId: id, active: true, disabled: false, refresh: () => calls.push("refresh") },
    pending: () => "", rows: () => new Map([["row", saved]]), missionCleanupPending: () => true,
    captureView: () => () => true, attempt: 0, alive: true, setPending: () => {}, setError: () => {},
  })("row")
  assert.deepEqual(calls, ["read", "delete", "refresh"])
})

for (const action of ["run-now", "pause"] as const) {
  test(`recurrence ${action} dispatch and explicit status each reach their remote sibling endpoint`, async () => {
    const calls: any[] = [], intent = { scheduleID: "s", requestID: "r", action, expectedRevision: 1 }, settled: string[] = []
    const api = Object.fromEntries(["runMissionRecurrenceNow", "controlMissionRecurrence", "missionRecurrenceRunNowStatus", "missionRecurrenceControlStatus"]
      .map(method => [method, async (...args: any[]) => { calls.push([method, ...args]); return {} }]))
    const env = fixture(api), scope = { ...env,
      props: { instanceId: id, schedule: { id: "s", revision: 1 }, directory: "/repo", enabled: () => true, retryEnabled: () => true }, generation: 1,
      retryCapable: () => true, capable: () => true, key: () => "scope", createRecurrenceControlIntent: () => intent,
      unresolved: new Map(), setHeld: () => {}, setBusy: () => {}, setRefusal: () => {}, busy: () => false,
      completedRecurrenceManual: () => true, rejectedRecurrenceControl: () => undefined, partialRecurrenceControl: () => false,
      finish: () => settled.push("control"), settle: () => settled.push("manual"), heldIntent: () => intent, witness: undefined,
    }
    await production("./mission-recurrence-list.tsx", "act", scope)(action)
    await production("./mission-recurrence-list.tsx", "check", scope)()
    assert.deepEqual(calls.map(call => call[0]), action === "run-now"
      ? ["runMissionRecurrenceNow", "missionRecurrenceRunNowStatus"] : ["controlMissionRecurrence", "missionRecurrenceControlStatus"])
    assert.ok(calls.every(call => call[1] === id)); assert.equal(settled.length, 2)
  })
}

test("lifecycle reconcile authorizes only its exact request after its own read", async () => {
  const env = fixture({}), read = deferred(), input = { requestId: "r", action: "pause", expectedRevision: 1 }
  const scope = { ...env, props: { instanceId: id }, identity: () => "scope", epoch: 1, alive: true,
    durableRequest: () => input, retry: () => undefined, retryable: () => true, missionStore: { state: () => ({ status: "ready" }) } }
  const reconcile = production("./mission-lifecycle-controls.tsx", "reconcile", scope)
  const pending = reconcile(read.promise); env.revoke(); read.resolve(); assert.equal(await pending, false)
  env.replace(); assert.equal(await reconcile(Promise.resolve()), true)
})

for (const method of ["readCapability", "readDocument"] as const) {
  test(`schedule editor passive ${method} reaches its distinct remote read`, async () => {
    const calls: string[] = [], capability: string[] = []
    const scope = scheduleScope({
      fetchMissionScheduleCapability: async () => { calls.push("capability"); return { api: { available: true }, enabled: true } },
      fetchMissionSchedule: async () => { calls.push("document"); return { document: { id: "m", configuration: {}, edit: {} } } },
    })
    Object.assign(scope, { capabilityRead: undefined, documentRead: undefined, captureOwner: () => () => true,
      owner: () => ({ signal: new AbortController().signal }), setCapabilityReading: () => {}, setDocumentReading: () => {},
      setDirectory: () => {}, setCapability: (value: string) => capability.push(value), document: () => undefined,
    })
    production("./mission-editor-schedule.ts", method, scope)(); await flush()
    assert.deepEqual(calls, method === "readCapability" ? ["capability"] : ["document"])
    if (method === "readCapability") assert.deepEqual(capability, ["available"])
    else assert.equal(scope.accepted.length, 1)
  })
}

function controlScope(api: Record<string, any>) {
  const env = fixture(api), holds = new Map<string, any>(), refreshed: string[] = []
  const doc = { id: "m", revision: 1, configuration: { title: "Title", launch: {} } }
  const scope: Record<string, any> = { ...env, holds, refreshed, doc,
    props: { instanceId: id, directory: "/repo", document: () => doc, active: () => true, refresh: () => refreshed.push("refresh") },
    capable: () => true, capture: () => env.captureBackendOperation(id).current, identity: () => "scope", held: () => undefined,
    setBusy: () => {}, setFeedback: () => {}, bump: () => {}, label: () => "Play", t: (key: string) => key,
    requiresMissionCalendar: () => true, showConfirmDialog: async () => true,
    partialReceipt: () => undefined, exactMissionScheduleControl: () => true, refusedMissionScheduleReceipt: () => false,
    settle: (_key: string, hold: any) => { holds.delete("scope"); refreshed.push(hold.phase) },
    receipt: () => assert.fail("direct complete ACK must settle without another read"),
  }
  return scope
}

for (const enabled of [false, true]) {
  test(`schedule Play ${enabled ? "enabled" : "activation"} reaches every remote continuation`, async () => {
    const calls: string[] = [], scope = controlScope({
      fetchMissionSchedule: async () => { calls.push("preflight"); return { document: scope.doc } },
      fetchMissionScheduleCapability: async () => { calls.push("capability"); return { api: { available: true }, enabled,
        activation: { available: true, targets: [{ path: "/config" }] } } },
      missionScheduleSettings: async (_owner: string, _mission: string, input: any, activate: boolean) => {
        assert.equal(activate, true); calls.push("activation"); return { document: { revision: 2,
          scheduleActivation: { requestID: input.requestID, expectedRevision: 1, state: "ready" } } }
      },
      controlMissionSchedule: async (_owner: string, _mission: string, input: any) => {
        calls.push("play"); assert.equal(input.expectedRevision, enabled ? 1 : 2); return { document: { revision: enabled ? 2 : 3 } }
      },
    })
    await production("./mission-schedule-controls.ts", "act", scope)("play")
    assert.deepEqual(calls, enabled ? ["preflight", "capability", "play"] : ["preflight", "capability", "activation", "play"])
    assert.ok(scope.refreshed.includes("control"))
  })
}

test("schedule activation reconciliation uses the read-only settings endpoint", async () => {
  const calls: any[] = [], hold = { phase: "activation", requestID: "r", expectedRevision: 1 }
  const scope = controlScope({ missionScheduleSettings: async (...args: any[]) => {
    calls.push(args); return { document: { revision: 2, scheduleActivation: { requestID: "r", expectedRevision: 1, state: "ready" } } }
  } })
  Object.assign(scope, { held: () => hold, busy: () => false }); scope.holds.set("scope", hold)
  await production("./mission-schedule-controls.ts", "reconcile", scope)()
  assert.deepEqual(calls, [[id, "m", { requestID: "r", expectedDocumentRevision: 1 }]])
  assert.ok(scope.refreshed.includes("activation"))
})

test("schedule control receipt explicitly reads the original request and settles it", async () => {
  const calls: any[] = [], hold = { phase: "control", requestID: "r", expectedRevision: 1, action: "pause" }
  const scope = controlScope({ fetchMissionSchedule: async (...args: any[]) => { calls.push(args); return { document: { revision: 2 } } } })
  scope.holds.set("scope", hold)
  await production("./mission-schedule-controls.ts", "receipt", scope)("scope", hold, () => true)
  assert.deepEqual(calls, [[id, "m", { directory: "/repo", requestID: "r" }]])
  assert.ok(scope.refreshed.includes("control"))
})

test("schedule control passive capability display is owner routed", async () => {
  const calls: string[] = [], env = fixture({ fetchMissionScheduleCapability: async () => { calls.push("capability"); return { api: { available: true }, enabled: true } } })
  let published: string | undefined, dispose!: () => void
  const effect = production("./mission-schedule-controls.ts", "createEffect", { ...env,
    props: { instanceId: id, directory: "/repo", refreshVersion: () => 0, active: () => true },
    capabilityOwner: () => ({ signal: new AbortController().signal }), previousOwner: undefined,
    capture: () => env.captureBackendOperation(id).current, setBusy: () => {}, setCapability: (value: string) => { published = value },
  }, "fetchMissionScheduleCapability")
  createRoot(close => { dispose = close; createEffect(effect) }); await flush()
  assert.deepEqual(calls, ["capability"]); assert.equal(published, "available"); dispose()
})
