import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import ts from "typescript"
import { BackendEvents } from "../lib/backend-events.ts"

// Execute production module ASTs with bounded I/O dependencies. No application,
// SDK connection, UI mount or replacement action implementation runs here.
function production(path: string, bindings: Record<string, unknown>, expose: string[] = []) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8")
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const stripped = ts.factory.updateSourceFile(parsed, parsed.statements.filter(node => !ts.isImportDeclaration(node)))
  const code = ts.transpileModule(ts.createPrinter().printFile(stripped), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = {}
  new Function("exports", ...Object.keys(bindings), `${code}\nObject.assign(exports, { ${expose.join(",")} })`)(exports, ...Object.values(bindings))
  return exports as Record<string, (...args: any[]) => any>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function lifetime() {
  const events = new BackendEvents()
  const source = { on: () => () => {}, onOpen: () => () => {}, onTransportStatus: () => () => {}, onDispose: () => () => {} }
  let detach = events.attach("local", source)
  const { captureBackendOperation } = production("../lib/backend-operation.ts", { backendEvents: events })
  return { captureBackendOperation, replace() { detach(); detach = events.attach("local", source) }, close() { detach() } }
}

test("enqueued commands retain admission authority; a fresh attachment does not wait or replay", async () => {
  const owner = lifetime()
  const { serializeSessionAction } = production("./session-action-queue.ts", owner)
  const gate = deferred<string>()
  let sent = 0
  const first = serializeSessionAction("workspace", "session", async () => { sent++; return gate.promise })
  await Promise.resolve()
  await Promise.resolve()
  const obsolete = serializeSessionAction("workspace", "session", async () => { sent++; return "obsolete" })
  const rejection = assert.rejects(obsolete, { name: "AbortError" })
  owner.replace()
  assert.equal(await serializeSessionAction("workspace", "session", async () => { sent++; return "fresh" }), "fresh")
  gate.resolve("acknowledged")
  assert.equal(await first, "acknowledged", "a dispatched mutation keeps its result")
  await rejection
  assert.equal(sent, 2)
  owner.close()
})

test("destructive message digest cannot authorize a write on a replacement attachment", async () => {
  const owner = lifetime(), digest = deferred<string>()
  let writes = 0, publications = 0
  const { pruneMessageContent } = production("./session-pruning.ts", {
    ...owner, contentRevision: () => digest.promise, serverApi: { pruneSessionMessage: () => { writes++; return { status: "pruned" } } },
    getRootClient: () => ({}), getOpenCodeInstanceGeneration: () => 1,
    invalidateOpenCodeSessionContent: () => { publications++ }, invalidateSessionMessageLoad: () => { publications++ },
  })
  const pending = pruneMessageContent("workspace", "session", { id: "message", content: [] }, [0], () => { publications++ })
  owner.replace(); digest.resolve("digest")
  await assert.rejects(pending, { name: "AbortError" })
  assert.equal(writes, 0); assert.equal(publications, 0)
  const receipt = deferred<any>(), sent = deferred<void>()
  const client = {}
  const inflight = production("./session-pruning.ts", {
    ...owner, contentRevision: async () => "digest", serverApi: { pruneSessionMessage: () => { writes++; sent.resolve(); return receipt.promise } },
    getRootClient: () => client, getOpenCodeInstanceGeneration: () => 1,
    invalidateOpenCodeSessionContent: () => { publications++ }, invalidateSessionMessageLoad: () => { publications++ },
  })
  const acknowledged = inflight.pruneMessageContent("workspace", "session", { id: "message", content: [] }, [0], () => { publications++ })
  await sent.promise
  owner.replace(); receipt.resolve({ status: "pruned" })
  await acknowledged
  assert.equal(writes, 1, "a transmitted destructive write is never replayed")
  assert.equal(publications, 0, "a late ACK starts no native reread or projection")
  owner.close()
})

test("the real custom-command action rechecks admitted authority after instruction preparation", async () => {
  const owner = lifetime(), setup = deferred<void>(), entered = deferred<void>()
  const queue = production("./session-action-queue.ts", owner)
  let commands = 0
  const client = { session: { command: async () => { commands++ } } }
  const actions = production("./session-actions.ts", {
    ...owner, ...queue, getLogger: () => ({ info() {}, warn() {}, error() {} }),
    instances: () => new Map([["workspace", { client }]]), sessions: () => new Map([["workspace", new Map([["session", {}]])]]),
    getRootClient: () => client, syncSessionInstructions: async () => { entered.resolve(); await setup.promise },
  })
  const pending = actions.executeCustomCommand("workspace", "session", "review", "")
  await entered.promise
  owner.replace(); setup.resolve()
  await assert.rejects(pending, { name: "AbortError" })
  assert.equal(commands, 0)
  await actions.executeCustomCommand("workspace", "session", "review", "")
  assert.equal(commands, 1, "a fresh user command can acquire the replacement attachment")
  owner.close()
})

test("history pages and saved destructive plans retain authority across awaits and confirmation", async () => {
  const owner = lifetime(), response = deferred<any>()
  let reads = 0, writes = 0, progress = 0, refreshes = 0
  const page = { status: "page", scanned: 1, tools: 1, reasoning: 0, skipped: 0, hits: [], candidates: [{ id: "message", toolCount: 1, reasoningCount: 0 }], cursor: null }
  const history = production("./session-history.ts", {
    ...owner, serverApi: { querySessionHistory: () => { reads++; return reads === 1 ? response.promise : Promise.resolve(page) },
      pruneSessionHistory: () => { writes++; return Promise.resolve({ results: [] }) } },
    getOpenCodeInstanceGeneration: () => 1, tGlobal: (key: string) => key, HttpResponseError: Error,
    refreshSessionContent: () => { refreshes++ },
  })
  const walk = history.walkHistory("workspace", {}, () => { progress++ })
  owner.replace(); response.resolve({ ...page, cursor: "next" })
  await assert.rejects(walk, { name: "AbortError" })
  assert.equal(reads, 1); assert.equal(progress, 0)
  const plan = await history.planSessionTechnicalPartDeletion("workspace", "session")
  assert.equal(plan.candidates.length, 1)
  owner.replace()
  await assert.rejects(history.executeSessionTechnicalPartDeletion(plan), { name: "AbortError" })
  assert.equal(writes, 0); assert.equal(refreshes, 0)
  assert.equal((await history.readHistoryPage("workspace", {})).status, "page", "new explicit demand reacquires authority")
  const fresh = await history.planSessionTechnicalPartDeletion("workspace", "session")
  fresh.candidates = Array.from({ length: 17 }, () => fresh.candidates[0])
  const cancel = new AbortController()
  await assert.rejects(history.executeSessionTechnicalPartDeletion(fresh, { signal: cancel.signal, progress: () => cancel.abort() }), { name: "AbortError" })
  assert.equal(writes, 1)
  assert.equal(refreshes, 1, "cancelling a view preserves compensatory invalidation on its still-live attachment")
  owner.close()
})

test("generation cleanup rolls back unsent work and keeps transmitted work uncertain after detach", async () => {
  for (const transmitted of [false, true]) {
    const owner = lifetime(), setup = deferred<void>(), entered = deferred<void>(), settled: string[] = []
    const queue = production("./session-action-queue.ts", owner)
    const { admitSessionAction } = production("./session-actions.ts", {
      ...owner, ...queue, getLogger: () => ({}),
      beginSessionGenerationAdmission: () => ({ complete: () => settled.push("accepted-or-unknown"), rollback: () => settled.push("unsent") }),
    }, ["admitSessionAction"])
    const pending = admitSessionAction("workspace", "session", async (signal: AbortSignal, dispatched: () => void) => {
      if (transmitted) dispatched()
      entered.resolve(); await setup.promise; signal.throwIfAborted()
    })
    await entered.promise
    owner.replace(); setup.resolve()
    await assert.rejects(pending, { name: "AbortError" })
    assert.deepEqual(settled, [transmitted ? "accepted-or-unknown" : "unsent"])
    owner.close()
  }
})

test("transcript frames and compaction buffers never merge or publish across attachments", () => {
  const owner = lifetime(), frames: Array<() => void> = []
  let projected = 0, usage = 0
  const projection = production("./opencode-projection-frame.ts", {
    ...owner, getLogger: () => ({ error: assert.fail }),
    requestAnimationFrame: (run: () => void) => { frames.push(run); return frames.length }, cancelAnimationFrame: () => {},
  })
  projection.setTranscriptProjectionGates({ isActiveSession: () => true, isLatestMessageWindow: () => true,
    projectPage: () => { projected++ }, onProjectedUsage: () => { usage++ }, invalidateInactiveLoadedSession: assert.fail })
  const data = {}
  projection.scheduleTranscriptProjection("workspace", "session", data, { updateUsage: true })
  owner.replace()
  projection.flushTranscriptProjections()
  assert.equal(projected, 0); assert.equal(usage, 0)
  projection.scheduleTranscriptProjection("workspace", "session", data, { updateUsage: true })
  owner.replace()
  projection.scheduleTranscriptProjection("workspace", "session", data)
  projection.flushTranscriptProjections()
  assert.equal(projected, 1); assert.equal(usage, 0, "old usage obligation must not merge into a fresh frame")
  const reduced: string[] = []
  const { createCompactionDeltaBuffer } = production("./compaction-delta-buffer.ts", owner)
  const buffer = createCompactionDeltaBuffer((event: any) => reduced.push(event.data.text))
  buffer.push("workspace", "session", { data: { text: "old" } }, {})
  owner.replace()
  buffer.push("workspace", "session", { data: { text: "fresh" } }, {})
  buffer.flush("workspace", "session")
  assert.deepEqual(reduced, ["fresh"])
  const { createReconnect } = production("./opencode-reconnect.ts", owner)
  let captures = 0, resets = 0
  const reconnect = createReconnect({ capture: () => { captures++; return [] }, resetInstance: () => { resets++ } })
  const connected = { data: { daemon: "same-daemon" } }
  reconnect.onServerConnected("workspace", connected)
  reconnect.onServerConnected("workspace", connected)
  assert.equal(captures, 1, "a verified same-attachment reconnect retains continuity")
  owner.replace()
  reconnect.onServerConnected("workspace", connected)
  assert.equal(captures, 1, "the same daemon label on another attachment cannot adopt the old transcript")
  assert.equal(resets, 3)
  owner.close()
})

test("MissionControl actor and scheduled navigation reject late hydration on an identical reattachment", async () => {
  const path = "../components/instance/shell/right-panel/tabs/MissionControl.tsx"
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const variables = (statements: ts.NodeArray<ts.Statement>) => statements.filter(ts.isVariableStatement)
    .flatMap(statement => statement.declarationList.declarations.map(declaration => ({ statement, declaration })))
  const component = variables(source.statements).find(entry => entry.declaration.name.getText(source) === "MissionControl")!.declaration.initializer as ts.ArrowFunction
  const declarations = variables((component.body as ts.Block).statements)
  const statement = (name: string) => declarations.find(entry => entry.declaration.name.getText(source) === name)!.statement
  const scheduled = declarations.find(entry => entry.declaration.name.getText(source) === "scheduled")!.declaration.initializer as ts.CallExpression
  const property = (scheduled.arguments[0] as ts.ObjectLiteralExpression).properties.find(member => member.name?.getText(source) === "onOpenConversation") as ts.PropertyAssignment
  const callback = property.initializer as ts.ArrowFunction
  assert.ok(ts.isVoidExpression(callback.body))
  // Drop only the fire-and-forget `void`, so the test can await the real callback.
  const awaitable = ts.factory.updateArrowFunction(callback, callback.modifiers, callback.typeParameters, callback.parameters,
    callback.type, callback.equalsGreaterThanToken, callback.body.expression)
  const selected = ts.factory.updateSourceFile(source, [statement("navigationOrigin"), statement("openActor"),
    ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList([
      ts.factory.createVariableDeclaration("openScheduledConversation", undefined, undefined, awaitable),
    ], ts.NodeFlags.Const))])
  const code = ts.transpileModule(ts.createPrinter().printFile(selected), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText

  for (const route of ["actor", "scheduled"] as const) for (const outcome of ["cancel", "resolve"] as const) {
    const owner = lifetime(), hydration = deferred<void>(), client = {}, errors: boolean[] = []
    let navigations = 0, reveals = 0, accepted: (() => boolean) | undefined, signal: AbortSignal | undefined
    const mission = { id: "mission", coordinatorSessionId: "session", actors: [] }
    const bindings = {
      ...owner, props: { instanceId: "workspace", onRevealConversation: () => { reveals++ } },
      intent: 0, conversationEpoch: 0, scope: () => "unchanged-view", captureView: () => () => true,
      passageSchedule: () => undefined, currentPassage: { snapshot: () => undefined }, selectedScheduled: () => "schedule",
      mission: () => mission, missions: () => [mission], includesSession: () => true, scheduled: { ownsSession: () => true },
      instances: () => new Map([["workspace", { client }]]), getOpenCodeInstanceGeneration: () => 1,
      getAuthoritativelyDeletedSessionIdsForInstance: () => new Set(), sessions: () => new Map([["workspace", new Map([["session", {}]])]]),
      setNavigationError: (error: boolean) => { errors.push(error) }, batch: (run: () => void) => run(),
      setActiveSessionFromList: () => { navigations++ }, showSessionChatFor: () => { navigations++ }, updateMissionProjectView: () => { navigations++ },
      hydrateRestoredSessionChain: async (_instance: string, _ids: string[], captured: AbortSignal, current: () => boolean) => {
        signal = captured; accepted = current
        await hydration.promise
        if (outcome === "cancel") throw new DOMException("Hydration cancelled", "AbortError")
      },
    }
    const actions = new Function(...Object.keys(bindings), `${code}\nreturn { openActor, openScheduledConversation }`)(...Object.values(bindings))
    const pending = route === "actor" ? actions.openActor("session") : actions.openScheduledConversation("session")
    assert.ok(accepted?.(), `${route}: unchanged view admits hydration`)
    assert.ok(signal && !signal.aborted, `${route}: attachment signal reaches native hydration reads`)
    owner.replace()
    assert.equal(signal!.aborted, true)
    assert.equal(accepted!(), false, `${route}: matching client/generation/view cannot resurrect old authority`)
    hydration.resolve()
    await pending
    assert.equal(errors.includes(true), false, `${route}/${outcome}: no late error publication`)
    assert.equal(navigations, 0, `${route}/${outcome}: no late selection, chat or reader mutation`)
    assert.equal(reveals, 0, `${route}/${outcome}: no drawer reveal`)
    owner.close()
  }
})
