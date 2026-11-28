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
    immediateCreationFollowed: () => false, mode: () => "once", conversation: undefined, replaces: undefined, removeReplaced: async () => {},
    uncertainRecurrence: () => undefined, missionCreationHold: () => undefined, identity: () => "view",
    captureView: () => env.captureBackendOperation(id).current, objective: () => "draft", notes: () => "", template: () => "custom",
    taskMode: () => undefined, effectiveProfiles: () => undefined, submittedTitle: () => "title", selectedModel: () => undefined, watchedIDs: () => [],
    missionCreationPayloadIdentity: JSON.stringify, holdMissionCreation: () => true, setShownRequestId: () => {}, setAdopted: () => {},
    setPending: () => {}, setError: () => {}, releaseMissionCreation: () => {},
  })
  const pending = run({ preventDefault() {} }); assert.equal(env.owners.length, 1)
  env.replace(); read.resolve({ mission: {} }); await pending
})

for (const kind of ["branch-commits"] as const) {
  test(`editor source ${kind} uses remote API and rejects late source rows`, async () => {
    const read = deferred(), env = fixture({ fetchLocalGitBranches: () => read.promise })
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
    env.revoke(); read.resolve({ branches: ["refs/heads/dev"] })
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

test("editor GitHub and coordinator payload reaches only its owning programmed Mission", async () => {
  for (const owner of ["A~same", "B~same"]) {
    const writes: any[] = []
    const env = fixture({ missionCalendars: async (...args: any[]) => { writes.push(args); return { calendars: [] } } }, owner), action = {}, coordinatorSessionID = () => "ses_same"
    const policy = () => ({ when: [{ kind: "github-issue", repository: "acme/repo", author: "alice" }] })
    const watchedIDs = () => []
    const run = production("./mission-editor.tsx", "save", { ...env, ...editorStart, kind: "create", action, lastPayload: "", requestId: "r",
      props: { instanceId: owner, directory: "/repo", action, onSaved: () => {} }, locked: () => false, isActive: () => true, setFieldError: () => {},
      structuralLocked: () => false, compareError: () => undefined, immediateCreationFollowed: () => false, mode: () => "recurring",
      coordinatorSessionID, coordinatorReady: production("./mission-editor.tsx", "coordinatorReady", { coordinatorSessionID, mode: () => "recurring",
        schedule: { scheduling: () => ({ criteria: [{ kind: "github-issue" }] }) },
        sourceChoices: { sources: () => ({ "coordinator-session": [{ id: "ses_same" }] }) } }),
      textLocked: () => false, policy, policyReady: () => true, calendarID: "cal", startOnCreation: () => false, removeReplaced: async () => {},
      objective: () => "objective", notes: () => "notes", template: () => "custom", taskMode: () => "native",
      uncertainRecurrence: () => undefined, missionCreationHold: () => undefined, identity: () => owner,
      copyMissionProfiles: (value: any) => structuredClone(value), effectiveProfiles: () => ({ coordinator: { agent: "worker", model: { providerID: "p", id: "m" } }, roles: {} }),
      missionProfileRoles: { custom: [] }, watchedIDs, watchedValid: production("./mission-editor.tsx", "watchedValid", { watchedIDs }),
      sourceLocationReady: () => true, sourceInputBudget: () => ({ sufficient: true }),
      submittedTitle: () => "title", captureView: () => env.captureBackendOperation(owner).current, setPending: () => {}, setError: () => {},
    })
    await run({ preventDefault() {} })
    assert.equal(writes.length, 1); assert.equal(writes[0][0], owner)
    assert.deepEqual([writes[0][1].directory, writes[0][1].calendar, writes[0][1].paused], ["/repo", "cal", true])
    assert.equal(writes[0][1].configuration.coordinatorSessionID, "ses_same")
    assert.deepEqual(writes[0][1].configuration.launch, policy())
    assert.deepEqual(env.localCalls, [])
  }
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
  const ownerValue = { signal: env.captureBackendOperation(id).signal }
  const scope: Record<string, any> = { ...env, accepted, released, mission, target: "m",
    props: { instanceId: id, directory: "/repo", action: {}, active: () => true, scope: () => "scope",
      captureDraft: () => ({}), onSaved: (...args: any[]) => accepted.push(args), onLoad: (value: any) => accepted.push(value) },
    capture: () => env.captureBackendOperation(id).current, held: () => undefined, reading: () => false,
    owner: () => ownerValue,
    captureOwner: (controller: AbortController) => () => !controller.signal.aborted,
    reconcileRead: undefined,
    journal: () => mission, holdMissionScheduleEditor: () => true,
    releaseMissionScheduleEditor: (_scope: string, request: string) => { released.push(request) }, retainMissionScheduleEditor: () => {},
    MissionMutationError: class extends Error {},
    setReading: () => {}, setFailed: () => {}, setReady: () => {}, setConflict: () => {},
    setPreviousDraft: () => {}, comparison: () => "draft", setJournal: () => {},
    readText: async () => configuration,
    readBody: async (_mission: any, selector: any) => ({ after: selector.field === "objective" ? "objective" : "notes" }),
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

{
  test("schedule reload executes its owning journal read", async () => {
    const calls: string[] = []
    const scope = scheduleScope({
      fetchMission: async (owner: string) => { assert.equal(owner, id); calls.push("journal"); return { available: true, mission: scope.mission } },
    })
    await production("./mission-editor-schedule.ts", "reload", scope)()
    assert.deepEqual(calls, ["journal"])
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

test("schedule reconcile reaches its journal receipt", async () => {
  const calls: string[] = [], request = { missionID: "m", requestID: "r", expectedRevision: 1, objective: "objective", notes: "notes" }
  const scope = scheduleScope({
    fetchMission: async (owner: string) => { assert.equal(owner, id); calls.push("journal"); return { available: true, mission: {
      id: "m", history: [{ source: "user", requestID: "r", revision: 2 }],
    } } },
  })
  scope.held = () => ({ payload: JSON.stringify(request), state: "uncertain" })
  await production("./mission-editor-schedule.ts", "reconcile", scope)()
  assert.deepEqual(calls, ["journal"])
  assert.deepEqual(scope.released, ["r"]); assert.equal(scope.accepted.length, 1)
})

function editorScope(api: Record<string, any>, kind: "edit" | "delete") {
  const env = fixture(api), action = {}, saved: any[] = [], errors: string[] = []
  const scope: Record<string, any> = { ...env, ...editorStart, kind, action, original: { id: "m", revision: 1 }, lastPayload: "", requestId: "r",
    props: { instanceId: id, directory: "/repo", action, onSaved: (...args: any[]) => saved.push(args) }, saved, errors,
    locked: () => false, isActive: () => true, structuralLocked: () => true, textLocked: () => false,
    immediateCreationFollowed: () => false, mode: () => "once", captureView: () => env.captureBackendOperation(id).current,
    objective: () => "objective", notes: () => "notes", template: () => "custom", identity: () => "scope",
    schedule: { journal: () => ({ revision: 1 }) }, selectedModel: () => undefined, conversation: undefined, replaces: undefined, removeReplaced: async () => {},
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
