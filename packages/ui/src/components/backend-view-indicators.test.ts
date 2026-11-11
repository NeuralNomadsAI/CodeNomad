import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import ts from "typescript"
import { isMissionGithubKind } from "../../../server/src/missions/mission-github-condition"
import { createEffect, createMemo, createRoot, createSignal, createUniqueId, mapArray, on, onCleanup, untrack } from "solid-js"

// Execute production AST, including the actual finally/cleanup branches. Imports
// and JSX are outside these indicator tests; request and view owners are explicit.
function source(path: string) {
  return ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}
function compile(text: string, scope: Record<string, any>) {
  scope.backendOf ??= () => ({ api: scope.serverApi })
  const code = ts.transpileModule(`(${text})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function("scope", `with (scope) { return ${code} }`)(scope)
}
function method(path: string, name: string, scope: Record<string, any>) {
  const file = source(path)
  let found: ts.FunctionDeclaration | ts.ArrowFunction | undefined
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name
      && node.initializer && ts.isArrowFunction(node.initializer)) found = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(found, name)
  return compile(found.getText(file).replace(/^export\s+/, ""), scope)
}
function component(path: string, name: string, expose: string, scope: Record<string, any>) {
  const file = source(path)
  const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name) as ts.FunctionDeclaration
  assert.ok(declaration?.body)
  const statements = declaration.body.statements.slice(0, -1).map(node => node.getText(file)).join("\n")
  return compile(`function(props) { ${statements}\nreturn ${expose} }`, scope)
}
function effect(path: string, marker: string, scope: Record<string, any>) {
  const file = source(path)
  let found: ts.ArrowFunction | undefined
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "createEffect"
      && ts.isArrowFunction(node.arguments[0]) && node.arguments[0].getText(file).includes(marker)) found = node.arguments[0]
    ts.forEachChild(node, visit)
  }
  visit(file); assert.ok(found, marker)
  return compile(found.getText(file), scope)
}
function deferred() {
  let resolve!: (value?: any) => void, reject!: (error: Error) => void
  const promise = new Promise<any>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
function attachment() {
  let controller = new AbortController()
  const [signal, setSignal] = createSignal(controller.signal)
  return {
    captureBackendOperation: (_id: string, parent?: AbortSignal, owns = () => true) => {
      const captured = parent ? AbortSignal.any([signal(), parent]) : signal()
      return { signal: captured, current: () => !captured.aborted && owns() }
    },
    revoke: () => controller.abort(),
    replace: () => { controller.abort(); controller = new AbortController(); setSignal(controller.signal) },
  }
}
const solid = { createEffect, createMemo, createSignal, createUniqueId, mapArray, on, onCleanup, untrack }

for (const outcome of ["success", "failure", "cancellation"] as const) {
  for (const successor of [false, true]) {
    test(`lifecycle retained refresh: ${outcome}, successor=${successor}`, async () => {
      const backend = attachment(), requests: ReturnType<typeof deferred>[] = []
      let refreshing = false
      const scope = { ...backend, props: { instanceId: "i", disabled: false }, alive: true, epoch: 0,
        identity: () => "same-client-and-generation", active: () => true, busy: () => refreshing,
        setRefreshing: (value: boolean) => { refreshing = value },
        missionStore: { refresh: () => { const request = deferred(); requests.push(request); return request.promise } },
      }
      const check = method("./mission-lifecycle-controls.tsx", "checkStatus", scope)
      const first = check().catch(() => {})
      backend.revoke()
      if (successor) {
        // Production identity effect retires the previous epoch before a B read.
        scope.epoch++; refreshing = false; backend.replace()
        void check()
      }
      if (outcome === "success") requests[0].resolve()
      else requests[0].reject(new DOMException(outcome, outcome === "cancellation" ? "AbortError" : "Error"))
      await first
      assert.equal(refreshing, successor)
      if (successor) { requests[1].resolve(); await flush(); assert.equal(refreshing, false) }
    })
  }
}

for (const outcome of ["success", "failure"] as const) {
  for (const successor of [false, true]) {
    test(`metadata retained load: ${outcome}, successor=${successor}`, async () => {
      const backend = attachment(), requests: ReturnType<typeof deferred>[] = []
      const instance = { id: "i", client: {} }
      let loading = false
      const scope = { ...backend, metadataLoadId: 0, disposed: false, resolvedInstance: () => instance,
        getInstanceMetadata: () => undefined, getActiveCatalogLocation: () => ({}), hasMetadataLoaded: () => false,
        setIsLoading: (value: boolean) => { loading = value }, waitForInstanceInitialSessionHydration: async () => {},
        loadInstanceMetadata: () => { const request = deferred(); requests.push(request); return request.promise },
      }
      const ensure = method("../lib/contexts/instance-metadata-context.tsx", "ensureMetadata", scope)
      const first = ensure(true).catch(() => {}); await flush()
      backend.revoke(); backend.replace()
      let second: Promise<void> | undefined
      if (successor) { second = ensure(true); await flush() }
      if (outcome === "success") requests[0].resolve()
      else requests[0].reject(new Error("failed"))
      await first
      assert.equal(loading, successor)
      if (second) { requests[1].resolve(); await second; assert.equal(loading, false) }
    })
  }
}

for (const name of ["reload", "reconcile", "retryPreparation"]) {
  for (const outcome of ["success", "failure", "cancellation"] as const) {
    test(`editor schedule ${name}: revoked ${outcome} releases its serial read`, async () => {
      const backend = attachment(), request = deferred()
      let reading = false, writes = 0
      const hold = { payload: JSON.stringify({ action: "configure", missionID: "m", directory: "/repo", requestID: "r" }) }
      const scope = { props: { instanceId: "i", directory: "/repo", action: { scheduleID: "m" }, active: () => true, scope: () => "s" },
        held: () => name === "reload" ? undefined : hold, reading: () => reading, target: "m", unified: true,
        capture: () => backend.captureBackendOperation("i").current, retryable: () => true,
        setReading: (value: boolean) => { reading = value }, setFailed: () => {}, setReady: () => {}, setRetryable: () => {},
        serverApi: { fetchMissionSchedule: () => request.promise, saveMissionSchedule: () => { writes++; return {} } },
      }
      const run = method("./mission-editor-schedule.ts", name, scope)
      const first = run(); assert.equal(reading, true)
      backend.revoke(); backend.replace()
      await run() // No successor is admitted while this same view's read owns the flag.
      if (outcome === "success") request.resolve({ document: { id: "m" } })
      else request.reject(new DOMException(outcome, outcome === "cancellation" ? "AbortError" : "Error"))
      await first
      assert.equal(reading, false); assert.equal(writes, 0)
    })
  }
}

for (const outcome of ["success", "failure", "cancellation"] as const) {
  test(`editor defaults: hidden/revoked ${outcome} releases the serial flag`, async () => {
    const backend = attachment(), request = deferred()
    let refreshing = false, publications = 0
    const scope = { busy: () => false, defaultsRefreshing: () => refreshing, isActive: () => true,
      captureView: () => backend.captureBackendOperation("i").current,
      config: { reloadMissionPreferences: () => request.promise },
      setDefaultsRefreshing: (value: boolean) => { refreshing = value }, setDefaultsFailed: () => { publications++ },
    }
    const run = method("./mission-editor.tsx", "useSavedDefaults", scope)
    const first = run(); backend.revoke(); await run()
    if (outcome === "success") request.resolve()
    else request.reject(new DOMException(outcome, outcome === "cancellation" ? "AbortError" : "Error"))
    await first
    assert.equal(refreshing, false); assert.equal(publications, 1) // Initial reset only.
  })
}

for (const outcome of ["success", "failure", "cancellation"] as const) {
  test(`editor source retained view: ${outcome}, hidden cancellation then active B`, async () => {
    const backend = attachment(), requests: ReturnType<typeof deferred>[] = []
    const [active, setActive] = createSignal(true)
    const client = {}, scope = { ...solid, ...backend, isMissionGithubKind, getOpenCodeInstanceGeneration: () => 1,
      getRootClient: () => client, serverApi: { fetchMissionScheduleSourcePage: () => {} } }
    // Branch sources avoid loading unrelated native session/cursor adapters.
    Object.assign(scope.serverApi, { fetchLocalGitBranches: () => { const request = deferred(); requests.push(request); return request.promise } })
    Object.assign(scope, { backendOf: () => ({ api: scope.serverApi }) })
    const create = method("./mission-editor-sources.ts", "createMissionEditorSources", scope)
    let dispose!: () => void
    const reader = createRoot(close => { dispose = close; return create({ instanceId: "i", projectID: "p", directory: () => "/repo",
      kinds: () => ["branch-commits"], selected: () => [], active, captureView: () => () => active() }) })
    // Assert the fixture reaches production dispatch, rather than merely its cleanup.
    reader.loading(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(requests.length, 1)
    backend.revoke(); setActive(false)
    assert.equal(reader.loading(), false)
    backend.replace(); setActive(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(requests.length, 2); assert.equal(reader.loading(), true)
    if (outcome === "success") requests[0].resolve({ branches: [] })
    else requests[0].reject(new DOMException(outcome, outcome === "cancellation" ? "AbortError" : "Error"))
    await flush(); assert.equal(reader.loading(), true)
    requests[1].resolve({ branches: [] }); await flush(); assert.equal(reader.loading(), false)
    dispose()
  })
}

test("history open: revoked owner releases opening, but cannot clear a successor target", async () => {
  for (const successor of [false, true]) {
    const backend = attachment(), request = deferred()
    let opening = false, failed = false
    const scope = { ...backend, target: 0, props: { instanceId: "i", sessionId: "s", messageId: "m" },
      setOpening: (value: boolean) => { opening = value }, setOpenFailed: (value: boolean) => { failed = value },
      openHistoryMatchSession: () => request.promise,
    }
    const run = method("./history-message-preview.tsx", "open", scope), first = run()
    backend.revoke(); backend.replace()
    if (successor) scope.target++
    request.resolve(false); await first
    assert.equal(opening, successor); assert.equal(failed, false)
  }
})

test("shell polling: cancellation releases loading; old completion leaves a retained B busy", async () => {
  const backend = attachment(), requests: ReturnType<typeof deferred>[] = []
  let dispose!: () => void
  const create = component("./shell-output-dialog.tsx", "ShellOutputDialog", "{ loading }", { ...solid, ...backend,
    useI18n: () => ({ t: (key: string) => key }), shellStore: { output: () => { const request = deferred(); requests.push(request); return request.promise } },
  })
  const reader = createRoot(close => { dispose = close; return create({ open: true, instanceId: "i", shell: { id: "s" }, directory: "/repo" }) })
  assert.equal(reader.loading(), true)
  backend.replace(); assert.equal(requests.length, 2)
  requests[0].reject(new DOMException("cancelled", "AbortError")); await flush()
  assert.equal(reader.loading(), true)
  backend.revoke(); requests[1].reject(new DOMException("cancelled", "AbortError")); await flush()
  assert.equal(reader.loading(), false)
  dispose()
})

for (const kind of ["create", "edit", "delete"] as const) {
  for (const outcome of ["success", "failure", "cancellation"] as const) {
    test(`editor ${kind}: revoked ${outcome} releases pending without admitting B`, async () => {
      const backend = attachment(), request = deferred(), action = {}
      let pending = false, dispatched = 0, errors = 0
      const dispatch = () => { dispatched++; return request.promise }
      const scope = { kind, action, original: { id: "m", revision: 1 }, lastPayload: "", requestId: "r",
        coordinatorReady: method("./mission-editor.tsx", "coordinatorReady", { coordinatorSessionID: () => undefined }),
        props: { instanceId: "i", directory: "/repo", action, onSaved: () => { throw new Error("stale publication") } },
        locked: () => pending, isActive: () => true, setFieldError: () => {}, structuralLocked: () => true,
        immediateCreationFollowed: () => false, mode: () => "immediate", textLocked: () => false,
        startOnCreation: () => false,
        captureStart: () => async () => assert.fail("stale creation must not start"),
        captureView: () => backend.captureBackendOperation("i").current, objective: () => "draft", notes: () => "notes",
        template: () => "custom", identity: () => "view", taskMode: () => undefined, effectiveProfiles: () => undefined,
        submittedTitle: () => "title", selectedModel: () => undefined, deleteManagedSessions: () => false, deleteAttempted: () => false,
        uncertainRecurrence: () => undefined, missionCreationHold: () => undefined, holdMissionCreation: () => true,
        missionCreationPayloadIdentity: JSON.stringify, releaseMissionCreation: () => {}, retainUncertainMissionCreation: () => {},
        retainSubmittedMissionModel: () => {}, setShownRequestId: () => {}, setAdopted: () => {}, setDeleteAttempted: () => {},
        isDefinitiveCreationRejection: () => false, missionStore: { demandedInstanceIds: () => [] },
        schedule: { unified: false, journal: () => ({}), saveJournalEdit: dispatch },
        serverApi: { createMission: dispatch, deleteMission: dispatch },
        setPending: (value: boolean) => { pending = value }, setError: () => { errors++ },
      }
      const save = method("./mission-editor.tsx", "save", scope)
      const first = save({ preventDefault() {} }); assert.equal(pending, true)
      backend.revoke(); backend.replace()
      await save({ preventDefault() {} }); assert.equal(dispatched, 1)
      if (outcome === "success") request.resolve({ mission: {} })
      else request.reject(new DOMException(outcome, outcome === "cancellation" ? "AbortError" : "Error"))
      await first
      assert.equal(pending, false); assert.equal(errors, 1)
    })
  }
}

test("history preview: cancelled old read cannot clear B; revoked B settles its flag", async () => {
  const backend = attachment(), requests: ReturnType<typeof deferred>[] = []
  let dispose!: () => void
  const create = component("./history-message-preview.tsx", "HistoryMessagePreview", "{ pending }", { ...solid, ...backend,
    useI18n: () => ({ t: (key: string) => key }), getOpenCodeInstanceGeneration: () => 1, getOpenCodeMutationRevision: () => 0,
    getRootClient: () => ({ session: { get: async () => ({ title: "session" }), message: { get: () => {
      const request = deferred(); requests.push(request); return request.promise
    } } } }),
  })
  const reader = createRoot(close => { dispose = close; return create({ instanceId: "i", sessionId: "s", messageId: "m" }) })
  backend.replace(); assert.equal(requests.length, 2)
  requests[0].resolve({ type: "user", text: "A" }); await flush(); assert.equal(reader.pending(), true)
  backend.revoke(); requests[1].reject(new DOMException("cancelled", "AbortError")); await flush()
  assert.equal(reader.pending(), false)
  dispose()
})

test("archived passage: detached demand is idle, and old settlement cannot clear B", async () => {
  const backend = attachment(), requests: ReturnType<typeof deferred>[] = [], client = {}
  let dispose!: () => void
  const create = component("./mission-recurrence-passage-reader.tsx", "MissionRecurrencePassageReader", "{ loading }", { ...solid, ...backend,
    cache: new Map(), useI18n: () => ({ t: (key: string) => key }), getOpenCodeInstanceGeneration: () => 1,
    instances: () => new Map([["i", { client, folder: "/repo", metadata: { project: { id: "p" } } }]]),
    serverApi: { fetchMissionRecurrencePassagePage: () => { const request = deferred(); requests.push(request); return request.promise } },
  })
  const reader = createRoot(close => { dispose = close; return create({ instanceId: "i", scope: "scope", projectID: "p", scheduleID: "s", receipt: {} }) })
  backend.replace(); assert.equal(requests.length, 2)
  requests[0].reject(new Error("failed A")); await flush(); assert.equal(reader.loading(), true)
  backend.revoke(); requests[1].reject(new DOMException("cancelled", "AbortError")); await flush()
  assert.equal(reader.loading(), false)
  backend.replace(); backend.revoke(); requests[2].reject(new DOMException("cancelled", "AbortError")); await flush()
  dispose()
})

test("skills: already revoked demand never advertises an undispatched read", () => {
  const backend = attachment(); backend.revoke()
  let loading = false, dispose!: () => void, dispatched = 0
  const callback = effect("./unified-picker.tsx", "skill.list", { ...solid, ...backend,
    props: { open: true, workspaceId: "i", directory: "/repo" }, mode: () => "mention",
    setSkills: () => {}, setSkillsError: () => {}, setSkillsLoading: (value: boolean) => { loading = value },
    getRootClient: () => { dispatched++; throw new Error("revoked dispatch") },
    serverEvents: { on: () => () => {}, forInstance: () => ({ onOpen: () => () => {} }) },
  })
  createRoot(close => { dispose = close; createEffect(callback) })
  assert.equal(loading, false); assert.equal(dispatched, 0)
  dispose()
})

test("lifecycle: revocation during the acknowledged control's refresh releases its local flag", async () => {
  const backend = attachment(), refresh = deferred(), mission = { id: "m", revision: 1 }
  let refreshing = false
  const scope = { ...backend, props: { instanceId: "i", mission }, alive: true, epoch: 0, attempt: 0,
    identity: () => "scope", location: () => ({}), active: () => true, busy: () => refreshing,
    retry: () => false, pending: () => false, full: () => false,
    missionLifecycleIntents: { reserve: (_scope: string, _id: string, input: unknown) => ({ input }), start: () => true, finish: () => true },
    serverApi: { controlMission: async () => ({ mission }) }, missionLifecycleSource: () => "scope",
    setRefreshing: (value: boolean) => { refreshing = value }, missionStore: { refresh: () => refresh.promise },
  }
  const act = method("./mission-lifecycle-controls.tsx", "act", scope), result = act("pause")
  await flush(); assert.equal(refreshing, true)
  backend.revoke(); backend.replace(); refresh.resolve(); await result
  assert.equal(refreshing, false)
})

test("playbook reader: owner routing and replacement reject a detached response", async () => {
  const backend = attachment(), requests: ReturnType<typeof deferred>[] = [], owners: string[] = []
  let shown: unknown, failed = false, dispose!: () => void
  const callback = effect("./mission-playbook-reader.tsx", "fetchMissionPlaybooks", { ...solid, ...backend,
    props: { instanceId: "remote~same", taskMode: "native" }, attempt: () => 0,
    serverApi: { fetchMissionPlaybooks: () => assert.fail("local singleton reached") },
    backendOf: (id: string) => { owners.push(id); return { api: { fetchMissionPlaybooks: () => {
      const request = deferred(); requests.push(request); return request.promise
    } } } },
    setDetails: (value: unknown) => { shown = value }, setFailed: (value: boolean) => { failed = value },
  })
  createRoot(close => { dispose = close; createEffect(callback) })
  assert.deepEqual(owners, ["remote~same"])
  backend.replace(); assert.equal(requests.length, 2)
  requests[1].resolve({ taskMode: "native", source: "replacement" }); await flush()
  requests[0].resolve({ taskMode: "native", source: "detached" }); await flush()
  assert.deepEqual(shown, { taskMode: "native", source: "replacement" }); assert.equal(failed, false)
  backend.revoke(); backend.replace(); assert.equal(requests.length, 3)
  dispose(); requests[2].reject(new Error("disposed")); await flush()
  assert.equal(failed, false)
})

test("MissionControl refresh: detachment prevents recurrence publication and control resend", async () => {
  const backend = attachment(), request = deferred()
  let refreshing = false, publications = 0, resends = 0
  const retry = { reconcile: () => request.promise, pending: () => true, resend: async () => { resends++ } }
  const run = method("./instance/shell/right-panel/tabs/MissionControl.tsx", "refresh", { ...backend,
    props: { instanceId: "remote~same" }, refreshing: () => refreshing, controlRetry: () => retry,
    captureView: () => () => true, setRefreshing: (value: boolean) => { refreshing = value },
    missionStore: { refresh: () => request.promise }, setRecurrenceRefresh: () => { publications++ },
  })
  const pending = run(); assert.equal(refreshing, true)
  backend.replace(); request.resolve(true); await pending
  assert.equal(publications, 0); assert.equal(resends, 0); assert.equal(refreshing, false)
})

test("cleanup: remote preflight detachment never advances to a destructive retry", async () => {
  const backend = attachment(), request = deferred(), owners: string[] = []
  let pending = "", deletes = 0, refreshes = 0
  const saved = { missionID: "m", deletionID: "d", requestID: "r", expectedRevision: 1, deleteManagedSessions: false }
  const run = method("./mission-cleanup.tsx", "retry", { ...backend,
    props: { instanceId: "remote~same", active: true, disabled: false, refresh: async () => { refreshes++ } },
    pending: () => pending, rows: () => new Map([["row", saved]]), missionCleanupPending: () => true,
    captureView: () => () => true, attempt: 0, alive: true,
    setPending: (value: string) => { pending = value }, setError: () => {},
    serverApi: { fetchMission: () => assert.fail("local singleton reached") },
    backendOf: (id: string) => { owners.push(id); return { api: {
      fetchMission: () => request.promise, deleteMission: async () => { deletes++ },
    } } },
  })
  const result = run("row"); assert.deepEqual(owners, ["remote~same"])
  backend.replace(); request.resolve({ available: true, cleanups: [saved] }); await result
  assert.equal(deletes, 0); assert.equal(refreshes, 0); assert.equal(pending, "")
})
