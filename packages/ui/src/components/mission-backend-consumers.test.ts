import assert from "node:assert/strict"
import { test } from "node:test"
import { generateUUID } from "../lib/client-identity"
import { repositoryIdentitySchema } from "../../../server/src/missions/mission-repository-condition"
import { productionHandler } from "../../tests/test-support/production-ast"
import { deferred } from "../../tests/test-support/deferred"
import { isMissionPickerSource } from "./mission-scheduling-data"
import { isReservedMissionScheduleSessionID } from "../../../server/src/missions/mission-schedule-carrier-identity"
import { buildProjectSessionListOptions, normalizeSessionDirectory } from "../stores/session-list-options"
import { backgroundReads } from "../lib/background-read-queue"
import { recurrenceStartText } from "../../../server/src/missions/lifecycle-input"
import { HttpResponseError } from "../lib/retryable-file-search"
import { createEffect, createMemo, createRoot, createSignal, mapArray, on, onCleanup, untrack } from "solid-js"

// Run production consumer bodies/effects, with transport and view owners injected.
// Local and remote transports are deliberately distinct: reverting a consumer to
// the singleton fails at dispatch, even when the API layer itself still routes.
function production(path: string, name: string, scope: Record<string, any>, marker?: string) {
  return productionHandler(new URL(path, import.meta.url), name, scope, marker)
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const solid = { createEffect, createMemo, createSignal, mapArray, on, onCleanup, untrack }
const id = "remote~same"
function fixture(api: Record<string, any>, id = "remote~same") {
  let controller = new AbortController()
  const [signal, setSignal] = createSignal(controller.signal)
  const owners: string[] = [], localCalls: string[] = []
  return { ...solid, generateUUID, owners, localCalls,
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

test("repository discovery selects its backend and fences late replaced reads", async () => {
  const reads: ReturnType<typeof deferred>[] = []
  const env = fixture({ fetchRepositorySource: (owner: string, directory: string) => {
    assert.equal(owner, id); assert.equal(directory, "/repo")
    const read = deferred(); reads.push(read); return read.promise
  } })
  const create = production("./mission-editor-repository.ts", "createMissionEditorRepository", { ...env,
    backgroundReads, repositoryIdentitySchema, getOpenCodeInstanceGeneration: () => 1,
  })
  let dispose!: () => void
  const props = { instanceId: id, directory: () => "/repo", active: () => true, captureView: () => () => true }
  const state = createRoot(close => { dispose = close; return create(props) })
  await flush(); assert.equal(reads.length, 1)
  env.replace(); reads[0].resolve({ status: "unavailable", reason: "old_error" }); await flush()
  assert.equal(state().failed, false)
  state().retry(); await flush(); assert.equal(reads.length, 2)
  reads[1].resolve({ status: "unavailable", reason: "no_remote" }); await flush()
  assert.equal(state().failed, false); assert.equal(state().loading, false)
  assert.deepEqual(env.localCalls, []); dispose()
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

// These routing cases opt out of automatic start; either unexpected opt-in or continuation fails.
const editorStart = { startOnCreation: () => false, coordinatorGoal: () => false, captureStart: (requested: boolean) => {
  if (requested) throw new Error("Unexpected automatic start opt-in")
  return async () => { throw new Error("Unexpected automatic start continuation") }
}, coordinatorReady: production("./mission-editor.tsx", "coordinatorReady", { coordinatorSessionID: () => undefined }) }

test("editor creation dispatch is remote; stale completion preserves the current view", async () => {
  const read = deferred(), env = fixture({ createMission: () => read.promise }), action = {}
  const run = production("./mission-editor.tsx", "save", { ...env, ...editorStart, kind: "create", action, lastPayload: "", requestId: "r",
    props: { instanceId: id, action, onSaved: () => assert.fail("stale editor publication") },
    locked: () => false, isActive: () => true, setFieldError: () => {}, structuralLocked: () => true,
    immediateCreationFollowed: () => false, mode: () => "once", schedule: { unified: false },
    uncertainRecurrence: () => undefined, missionCreationHold: () => undefined, identity: () => "view",
    captureView: () => env.captureBackendOperation(id).current, objective: () => "draft", notes: () => "", template: () => "custom",
    taskMode: () => undefined, effectiveProfiles: () => undefined, submittedTitle: () => "title", selectedModel: () => undefined, watchedIDs: () => [],
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
    setBusy: () => {}, setPendingAction: () => {}, setRefusal: () => {}, setFeedback: () => {},
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
    const create = production("./mission-editor-sources.ts", "createMissionEditorSources", { ...env, isMissionPickerSource, getOpenCodeInstanceGeneration: () => 1,
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

test("coordinator sources keep same-ID roots on A/B, filter foreign rows and reject revoked publication", async () => {
  for (const owner of ["A~same", "B~same"]) {
    const env = fixture({}, owner), reads: any[] = [], pending = deferred(), pins: string[] = [], timers = new Map<number, () => void>()
    let timerID = 0
    const row = (id: string, extra = {}) => ({ id, title: `${owner}:${id}`, projectID: "p", location: { directory: "/repo" }, ...extra })
    const create = production("./mission-editor-sources.ts", "createMissionEditorSources", { ...env, isMissionPickerSource,
      isReservedMissionScheduleSessionID, buildProjectSessionListOptions, normalizeSessionDirectory, backgroundReads,
      conversationTitleQuery: production("./mission-editor-sources.ts", "conversationTitleQuery", {}),
      getOpenCodeInstanceGeneration: () => 1, setTimeout: (callback: () => void) => { const key = ++timerID; timers.set(key, callback); return key }, clearTimeout: (key: number) => timers.delete(key),
      getRootClient: (id: string) => { assert.equal(id, owner); return { session: {
        list: async (options: any, request: any) => { reads.push({ options, signal: request.signal }); return reads.length === 1
          ? { data: [row("ses_same"), row("ses_child", { parentID: "ses_parent" }), row("ses_foreign", { projectID: "other" }),
            row("ses_elsewhere", { location: { directory: "/other" } }), row("ses_cn_schedule_carrier")], cursor: { next: "page2" } }
          : pending.promise },
        get: async ({ sessionID }: any) => { pins.push(sessionID); throw new Error("Missing chosen root") },
      } } },
    })
    let dispose!: () => void
    const reader = createRoot(close => { dispose = close; return create({ instanceId: owner, projectID: "p", directory: () => "/repo",
      kinds: () => ["coordinator-session"], selected: () => [{ kind: "coordinator-session", id: "ses_missing" }],
      active: () => true, captureView: () => env.captureBackendOperation(owner).current }) })
    for (const [key, timer] of timers) { timers.delete(key); timer() }
    await flush()
    assert.deepEqual(reader.sources()["coordinator-session"], [{ id: "ses_same", label: `${owner}:ses_same` }])
    assert.deepEqual(reads[0].options, { directory: "/repo", parentID: null, order: "desc", limit: 200 })
    assert.deepEqual(pins, ["ses_missing"])
    assert.equal(reader.reader("coordinator-session", "ses_missing").lookupFailed(), true)
    reader.reader("coordinator-session").more()
    for (const [key, timer] of timers) { timers.delete(key); timer() }
    assert.deepEqual(reads[1].options, { cursor: "page2", limit: 200 })
    env.revoke(); assert.equal(reads[1].signal.aborted, true)
    pending.resolve({ data: [row("ses_late")], cursor: {} }); await flush()
    assert.deepEqual(reader.sources()["coordinator-session"], [{ id: "ses_same", label: `${owner}:ses_same` }])
    assert.deepEqual(env.localCalls, []); dispose()
  }
})

test("editor GitHub and coordinator payload reaches only its owning schedule consumer", async () => {
  for (const owner of ["A~same", "B~same"]) {
    const writes: any[] = [], scope = scheduleScope({})
    const env = fixture({ saveMissionSchedule: async (...args: any[]) => { writes.push(args); return { document: scope.doc } } }, owner), action = {}, coordinatorSessionID = () => "ses_same"
    Object.assign(scope, env, { unified: false }); scope.props.instanceId = owner
    const schedule = { unified: false, document: () => undefined, save: production("./mission-editor-schedule.ts", "save", scope) }
    const policy = () => ({ when: [{ kind: "github-issue", repository: "acme/repo", author: "alice" }] })
    const watchedIDs = () => []
    const run = production("./mission-editor.tsx", "save", { ...env, ...editorStart, kind: "create", action, lastPayload: "", requestId: "r",
      props: { instanceId: owner, action }, locked: () => false, isActive: () => true, setFieldError: () => {},
      structuralLocked: () => false, compareError: () => undefined, immediateCreationFollowed: () => false, mode: () => "recurring",
      coordinatorSessionID, coordinatorReady: production("./mission-editor.tsx", "coordinatorReady", { coordinatorSessionID, mode: () => "recurring",
        watchedIDs, schedule: { scheduling: () => ({ criteria: [{ kind: "github-issue" }] }) },
        sourceChoices: { sources: () => ({ "coordinator-session": [{ id: "ses_same" }] }) } }),
      schedule, textLocked: () => false, policy, policyReady: () => true, recurrenceStartText,
      objective: () => "objective", notes: () => "notes", template: () => "custom", taskMode: () => "native",
      uncertainRecurrence: () => undefined, missionCreationHold: () => undefined, identity: () => owner,
      copyMissionProfiles: (value: any) => structuredClone(value), effectiveProfiles: () => ({ coordinator: { agent: "worker", model: { providerID: "p", id: "m" } }, roles: {} }),
      missionProfileRoles: { custom: [] }, watchedIDs, watchedValid: production("./mission-editor.tsx", "watchedValid", { watchedIDs }),
      sourceLocationReady: () => true, sourceInputBudget: () => ({ sufficient: true }),
      submittedTitle: () => "title", captureView: () => env.captureBackendOperation(owner).current, setPending: () => {}, setError: () => {},
    })
    await run({ preventDefault() {} })
    assert.equal(writes.length, 1); assert.equal(writes[0][0], owner)
    assert.equal(writes[0][1].configuration.coordinatorSessionID, "ses_same")
    assert.deepEqual(writes[0][1].configuration.launch, policy())
    assert.deepEqual(env.localCalls, [])
  }
})

test("current passage content dispatches remotely and fences detached prose", async () => {
  const read = deferred(), env = fixture({ fetchMissionCurrentContent: () => read.promise }), instance = { folder: "/repo", client: {} }
  let publications = 0, dispose!: () => void
  const effect = production("./mission-passage-section.tsx", "createEffect", { ...env,
    attempt: () => 0,
    props: { instanceId: id, source: { projectID: "p", missionID: "m" }, page: 0, onPageCount: () => { publications++ } },
    instances: () => new Map([[id, instance]]), getOpenCodeInstanceGeneration: () => 1,
    cache: new Map(), setValue: () => {}, setError: () => {},
  }, "fetchMissionCurrentContent")
  createRoot(close => { dispose = close; createEffect(effect) }); assert.equal(env.owners.length, 1)
  env.revoke(); read.resolve({}); await flush(); assert.equal(publications, 0); dispose()
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
  env.revoke(); write.resolve(undefined); await pending
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
  const ownerValue = { signal: env.captureBackendOperation(id).signal }
  const scope: Record<string, any> = { ...env, accepted, released, doc, mission, target: "m", unified: true,
    props: { instanceId: id, directory: "/repo", action: {}, active: () => true, scope: () => "scope",
      captureDraft: () => ({}), onSaved: (...args: any[]) => accepted.push(args), onLoad: (value: any) => accepted.push(value) },
    capture: () => env.captureBackendOperation(id).current, held: () => undefined, reading: () => false,
    owner: () => ownerValue,
    captureOwner: (controller: AbortController) => () => !controller.signal.aborted,
    reconcileRead: undefined,
    document: () => doc, journal: () => mission, holdMissionScheduleEditor: () => true,
    releaseMissionScheduleEditor: (_scope: string, request: string) => { released.push(request); return false }, retainMissionScheduleEditor: () => {},
    resumeMissionScheduleEditor: () => true,
    exactMissionScheduleEditorReceipt: () => true, partialMissionScheduleReceipt: () => undefined, refusedMissionScheduleReceipt: () => false,
    HttpResponseError: class extends Error {}, MissionMutationError: class extends Error {},
    setReading: () => {}, setFailed: () => {}, setReady: () => {}, setConflict: () => {}, setDocument: () => {},
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
    scope.held = () => ({ payload: JSON.stringify(request), state: "uncertain" })
    await production("./mission-editor-schedule.ts", "reconcile", scope)()
    assert.deepEqual(calls, kind === "unified-journal" ? ["journal", "document"] : kind === "journal" ? ["journal"] : kind === "create" ? ["creation"] : ["document"])
    assert.deepEqual(scope.released, ["r"]); assert.equal(scope.accepted.length, 1)
  })
}

test("schedule reconcile automatically retries a positively recorded partial preparation once", async () => {
  const calls: any[] = [], request = { action: "configure", missionID: "m", requestID: "r", expectedRevision: 1, directory: "/repo" }
  const partial = { pending: true, document: { ...scopeDoc(), control: { action: "configure", requestID: "r", expectedRevision: 1, pending: true } } }
  const complete = { pending: false, document: { ...scopeDoc(), revision: 2, control: { action: "configure", requestID: "r", expectedRevision: 1, pending: false } } }
  function scopeDoc() { return { id: "m", revision: 1, kind: "one-time", configuration: { objective: "objective", notes: "notes" }, edit: { reason: null }, observation: { state: "complete" } } }
  const scope = scheduleScope({
    fetchMissionSchedule: async (...args: any[]) => { calls.push(["read", ...args]); return partial },
    saveMissionSchedule: async (...args: any[]) => { calls.push(["retry", ...args]); return complete },
  })
  let hold = { payload: JSON.stringify(request), state: "uncertain" as "pending" | "uncertain" }
  scope.held = () => hold
  scope.exactMissionScheduleEditorReceipt = (_request: any, result: any) => result === complete
  scope.resumeMissionScheduleEditor = () => { hold = { ...hold, state: "pending" }; return true }
  scope.retainMissionScheduleEditor = () => { hold = { ...hold, state: "uncertain" } }
  await production("./mission-editor-schedule.ts", "reconcile", scope)()
  assert.deepEqual(calls.map(call => call[0]), ["read", "retry"])
  assert.deepEqual(calls[0].slice(1, 4), [id, "m", { directory: "/repo", requestID: "r" }])
  assert.ok(calls[0][4] instanceof AbortSignal)
  assert.deepEqual(calls[1].slice(1, 3), [id, { ...request, retry: true }])
  assert.ok(calls[1][3] instanceof AbortSignal)
  assert.deepEqual(scope.released, ["r"])
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

test("lifecycle reconcile authorizes only its exact request after its own read", async () => {
  const env = fixture({}), read = deferred(), input = { requestId: "r", action: "pause", expectedRevision: 1 }
  const scope = { ...env, props: { instanceId: id }, identity: () => "scope", epoch: 1, alive: true,
    durableRequest: () => input, retry: () => undefined, retryable: () => true, missionStore: { state: () => ({ status: "ready" }) } }
  const reconcile = production("./mission-lifecycle-controls.tsx", "reconcile", scope)
  const pending = reconcile(read.promise); env.revoke(); read.resolve(undefined); assert.equal(await pending, false)
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
    capabilityOwner: () => ({ signal: env.captureBackendOperation(id).signal }), reconcileRead: undefined, stopReconcile: () => {},
    setBusy: () => {}, setPendingAction: () => {}, setRefusal: () => {}, setFeedback: () => {}, bump: () => {}, label: () => "Play", t: (key: string) => key,
    HttpResponseError,
    requiresMissionCalendar: () => true, showConfirmDialog: async () => true,
    partialReceipt: () => undefined, pendingMissionScheduleRevision: () => undefined, exactMissionScheduleControl: () => true, refusedMissionScheduleReceipt: () => false,
    notDispatchedMissionScheduleAttempt: () => false, undispatchedMissionScheduleCheck: () => false, validDeletionReceipt: () => false,
    settle: (_key: string, hold: any) => { holds.delete("scope"); refreshed.push(hold.phase) },
    receipt: () => assert.fail("direct complete ACK must settle without another read"),
  }
  return scope
}

for (const [enabled, prepared] of [[false, false], [true, false], [true, true]]) {
  test(`schedule Play ${!enabled ? "activation" : prepared ? "enabled and prepared" : "enabled without proof"} reaches every remote continuation`, async () => {
    const calls: string[] = [], scope = controlScope({
      fetchMissionSchedule: async () => { calls.push("preflight"); return { document: scope.doc } },
      fetchMissionScheduleCapability: async () => { calls.push("capability"); return { api: { available: true }, enabled,
        activation: { available: true, targets: [{ path: "/config" }] } } },
      missionScheduleSettings: async (_owner: string, _mission: string, input: any, activate: boolean) => {
        assert.equal(activate, true); calls.push("activation"); return { document: { revision: 2,
          scheduleActivation: { requestID: input.requestID, expectedRevision: 1, state: "ready" } } }
      },
      controlMissionSchedule: async (_owner: string, _mission: string, input: any) => {
        calls.push("play"); assert.equal(input.expectedRevision, prepared ? 1 : 2); return { document: { revision: prepared ? 2 : 3 } }
      },
    })
    if (prepared) scope.doc.scheduleActivation = { requestID: "prepared", expectedRevision: 1, state: "ready" }
    await production("./mission-schedule-controls.ts", "act", scope)("play")
    assert.deepEqual(calls, prepared ? ["preflight", "capability", "play"] : ["preflight", "capability", "activation", "play"])
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
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(0, 4), [id, "m", { requestID: "r", expectedDocumentRevision: 1 }, false])
  assert.ok(calls[0][4] instanceof AbortSignal)
  assert.ok(scope.refreshed.includes("activation"))
})

test("schedule control receipt explicitly reads the original request and settles it", async () => {
  const calls: any[] = [], hold = { phase: "control", requestID: "r", expectedRevision: 1, action: "pause" }
  const scope = controlScope({ fetchMissionSchedule: async (...args: any[]) => { calls.push(args); return { document: { revision: 2 } } } })
  scope.holds.set("scope", hold)
  await production("./mission-schedule-controls.ts", "receipt", scope)("scope", hold, () => true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].length, 4)
  assert.deepEqual(calls[0].slice(0, 3), [id, "m", { directory: "/repo", requestID: "r" }])
  assert.ok(calls[0][3] instanceof AbortSignal)
  assert.equal(calls[0][3].aborted, false)
  assert.ok(scope.refreshed.includes("control"))
})

test("schedule control passive capability display is owner routed", async () => {
  const calls: string[] = [], env = fixture({ fetchMissionScheduleCapability: async () => { calls.push("capability"); return { api: { available: true }, enabled: true, activation: { available: true } } } })
  let published: string | undefined, dispose!: () => void
  const effect = production("./mission-schedule-controls.ts", "createEffect", { ...env,
    props: { instanceId: id, directory: "/repo", refreshVersion: () => 0, active: () => true },
    capabilityOwner: () => ({ signal: new AbortController().signal }), previousOwner: undefined, stopReconcile: () => {},
    capture: () => env.captureBackendOperation(id).current, setBusy: () => {}, setPendingAction: () => {}, setRefusal: () => {}, setFeedback: () => {},
    feedback: () => undefined, setCapability: (value: string) => { published = value },
  }, "fetchMissionScheduleCapability")
  createRoot(close => { dispose = close; createEffect(effect) }); await flush()
  assert.deepEqual(calls, ["capability"]); assert.equal(published, "available"); dispose()
})

test("schedule check label uses checkStatus and dispatches check without confirmation", async () => {
  const calls: any[] = [], confirms: string[] = []
  const doc = { id: "m", revision: 2, availableActions: ["check"], configuration: { title: "Sync", launch: { when: [] } } }
  const scope = controlScope({
    fetchMissionSchedule: async () => ({ document: doc }),
    controlMissionSchedule: async (...args: any[]) => {
      calls.push(args)
      return { document: { ...doc, revision: 3, control: { requestID: args[2].requestID, expectedRevision: 2, action: "check", pending: false } } }
    },
  })
  scope.props.document = () => doc
  scope.showConfirmDialog = async (message: string) => { confirms.push(message); return false }
  const label = production("./mission-schedule-controls.ts", "label", { t: (key: string) => key })
  assert.equal(label("check"), "missionsPanel.action.checkStatus")
  await production("./mission-schedule-controls.ts", "act", scope)("check")
  assert.deepEqual(confirms, [])
  assert.equal(calls.length, 1)
  assert.equal(calls[0][2].action, "check")
})

test("schedule check proceeds across 503 schedule-pending preflight reads, settles compacted deletions directly or via GET, handles undispatched/busy responses, and rejects malformed tombstones", async () => {
  const { HttpResponseError } = await import("../lib/retryable-file-search")
  const { notDispatchedMissionScheduleAttempt, pendingMissionScheduleRevision, refusedMissionScheduleReceipt, undispatchedMissionScheduleCheck } = await import("../lib/mission-schedule-receipt")
  const { exactMissionScheduleControl } = await import("./mission-schedule-controls")
  const calls: any[] = [], feedbacks: Array<string | undefined> = [], settled: Array<number | undefined> = []
  const doc = { id: "msn_stuck", revision: 21, availableActions: ["check", "pause", "play"], configuration: { title: "Sync", launch: { when: [] } } }
  const pending503 = (revision: number) => new HttpResponseError("pending", 503, null, "schedule-pending", {
    pending: true, code: "schedule-pending",
    document: { id: doc.id, revision, control: { requestID: "reconcile_20", expectedRevision: 20, action: "reconcile", pending: false } },
  })
  const makeTombstone = (checkRequestID: string) => ({
    pending: false, deleted: true, document: null,
    deletionReceipt: { id: doc.id, requestID: "delete_orig", expectedRevision: 5, deleteManagedSessions: false },
    checkReceipt: { id: doc.id, requestID: checkRequestID, expectedRevision: 21, action: "check" as const },
  })
  const makeScope = (preflightRevision: number, overrides: Record<string, any> = {}) => {
    const scope = controlScope({
      fetchMissionSchedule: async (_owner: string, _id: string, input: any) => {
        if (input?.requestID) return makeTombstone(input.requestID)
        throw pending503(preflightRevision)
      },
      controlMissionSchedule: async (...args: any[]) => { calls.push(args); return makeTombstone(args[2].requestID) },
      ...overrides,
    })
    scope.props.document = () => doc
    scope.pendingMissionScheduleRevision = pendingMissionScheduleRevision
    scope.refusedMissionScheduleReceipt = refusedMissionScheduleReceipt
    scope.notDispatchedMissionScheduleAttempt = notDispatchedMissionScheduleAttempt
    scope.undispatchedMissionScheduleCheck = undispatchedMissionScheduleCheck
    scope.exactMissionScheduleControl = exactMissionScheduleControl
    scope.setFeedback = (value?: string) => { feedbacks.push(value) }
    scope.settle = (_key: string, hold: any, _current: any, revision?: number) => {
      scope.holds.delete("scope"); settled.push(revision); scope.refreshed.push(hold.phase)
    }
    return scope
  }
  // Matching revision on 503 schedule-pending dispatches check and settles compacted tombstone with revision=undefined.
  await production("./mission-schedule-controls.ts", "act", makeScope(21))("check")
  assert.equal(calls.length, 1)
  assert.equal(calls[0][2].action, "check")
  assert.equal(calls[0][2].expectedRevision, 21)
  assert.deepEqual(settled, [undefined])
  // Lost POST response recovers via GET receipt() using persisted checkReceipt without another write.
  settled.length = 0
  const lostScope = makeScope(21, {
    controlMissionSchedule: async (...args: any[]) => { calls.push(args); throw new Error("network dropped") },
  })
  await production("./mission-schedule-controls.ts", "act", lostScope)("check")
  assert.equal(calls.length, 2)
  assert.equal(lostScope.holds.size, 1)
  const lostHold = lostScope.holds.get("scope")
  await production("./mission-schedule-controls.ts", "receipt", lostScope)("scope", lostHold, () => true)
  assert.equal(lostScope.holds.size, 0)
  assert.deepEqual(settled, [undefined])
  // Second-client Check clears fresh UI hold cleanly when backend reports notDispatched (original already settled).
  const undispatchedScope = makeScope(21, {
    controlMissionSchedule: async (...args: any[]) => ({
      pending: false,
      document: { id: doc.id, revision: 22, control: { requestID: "other_play", expectedRevision: 20, action: "play", pending: false } },
      notDispatched: { missionID: doc.id, requestID: args[2].requestID, expectedRevision: 21, action: "check" as const },
    }),
  })
  await production("./mission-schedule-controls.ts", "act", undispatchedScope)("check")
  assert.equal(undispatchedScope.holds.size, 0)
  // Lost 200 on an undispatched Check recovers via GET 409 schedule-busy (dispatched:false).
  const lostUndispatched = makeScope(21, {
    fetchMissionSchedule: async (_owner: string, _id: string, input: any) => {
      if (input?.requestID) throw new HttpResponseError("busy", 409, null, "schedule-busy", {
        pending: true, dispatched: false, missionID: doc.id, requestID: input.requestID, expectedRevision: 21, action: "check",
      })
      throw pending503(21)
    },
    controlMissionSchedule: async () => { throw new Error("lost 200") },
  })
  await production("./mission-schedule-controls.ts", "act", lostUndispatched)("check")
  assert.equal(lostUndispatched.holds.size, 1)
  await production("./mission-schedule-controls.ts", "receipt", lostUndispatched)("scope", lostUndispatched.holds.get("scope"), () => true)
  assert.equal(lostUndispatched.holds.size, 0)
  // Second-client Pause hitting another client's backend hold receives per-attempt 409 schedule-busy (dispatched:false) and releases its fresh UI hold.
  feedbacks.length = 0
  const concurrentPause = makeScope(21, {
    controlMissionSchedule: async (...args: any[]) => {
      throw new HttpResponseError("busy", 409, null, "schedule-busy", {
        pending: true, dispatched: false, missionID: doc.id, requestID: args[2].requestID, expectedRevision: 21, action: "pause",
      })
    },
  })
  await production("./mission-schedule-controls.ts", "act", concurrentPause)("pause")
  assert.equal(concurrentPause.holds.size, 0)
  assert.ok(feedbacks.includes("missions.scheduleList.conflict"))
  // Stale revision on 503 schedule-pending reports conflict without dispatching.
  feedbacks.length = 0
  await production("./mission-schedule-controls.ts", "act", makeScope(22))("check")
  assert.equal(calls.length, 2)
  assert.ok(feedbacks.includes("missions.scheduleList.conflict"))
  // Non-recovery play still fails on 503 schedule-pending without dispatching.
  feedbacks.length = 0
  await production("./mission-schedule-controls.ts", "act", makeScope(21))("play")
  assert.equal(calls.length, 2)
  assert.ok(feedbacks.includes("missions.scheduleList.readFailed"))
  // Malformed tombstones and missing pending flag never satisfy exactMissionScheduleControl.
  const hold = { phase: "control" as const, action: "check" as const, requestID: "req_check_1", expectedRevision: 21, partial: false, pending: false, document: doc as any }
  const good = makeTombstone("req_check_1")
  assert.equal(exactMissionScheduleControl(good, hold, doc.id), true)
  assert.equal(exactMissionScheduleControl({ deleted: true, document: null, deletionReceipt: good.deletionReceipt, checkReceipt: good.checkReceipt } as any, hold, doc.id), false)
  assert.equal(exactMissionScheduleControl({ pending: false, deleted: true, document: null }, hold, doc.id), false)
  assert.equal(exactMissionScheduleControl({ ...good, deletionReceipt: { ...good.deletionReceipt, requestID: "" } }, hold, doc.id), false)
  assert.equal(exactMissionScheduleControl({ ...good, deletionReceipt: { ...good.deletionReceipt, expectedRevision: -1 } }, hold, doc.id), false)
  assert.equal(exactMissionScheduleControl({ ...good, checkReceipt: undefined }, hold, doc.id), false)
  assert.equal(exactMissionScheduleControl({ ...good, checkReceipt: { ...good.checkReceipt, requestID: "req_other" } }, hold, doc.id), false)
})
