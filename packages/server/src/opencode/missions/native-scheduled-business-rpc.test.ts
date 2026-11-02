import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Service } from "@opencode/client/service"
import { Context, Effect, Scope, Option } from "effect"
import { MissionControl } from "../../missions/control"
import { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import { missionCalendarOwnerSchema } from "../../missions/mission-calendar-owner-state"
import type { MissionDocument } from "../../missions/mission-document"
import { missionBusinessCall } from "../../missions/business-control"
import { missionMutationToolResult } from "../../missions/tool-result"
import { missionToolInspection } from "../../missions/tool-inspection"
import { MISSION_INSPECT_OUTPUT_LIMIT } from "../../missions/inspect-view"
import { nativeInvocation } from "./native-invocation"
import { NativeScheduledBusinessRpc, executeNativeScheduledBusiness, registerNativeScheduledBusinessRpc } from "./native-scheduled-business-rpc"

const current = () => true as const, at = Date.parse("2026-10-01T00:00:00Z")
const tag = (name: string) => Context.Service<never, unknown>(name)
async function fixture(t: test.TestContext, lostACK = false, originalPresent = true, upgradedRuntime = false, scheduled = false, realBusiness = false) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "business-rpc-")), registrationFile = path.join(directory, "owned.json")
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const identity = { id: "business-own", pid: process.pid, url: "http://127.0.0.1:1", version: "future-compatible" }
  writeFileSync(registrationFile, JSON.stringify({ ...identity, password: "unit-private-auth" }))
  const artifact = (name: string) => { const file = path.join(directory, name); writeFileSync(file, name)
    return { file, sha256: createHash("sha256").update(name).digest("hex") } }
  const provider = artifact("provider"), savedRuntime = artifact("runtime-old"), newRuntime = artifact("runtime-current")
  const artifacts = { provider, runtime: upgradedRuntime ? newRuntime : savedRuntime }
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const values = new Map<string, any>()
  const documents = new NativeMissionDocumentStore({ get: async key => structuredClone(values.get(key)),
    compareAndSet: async (key, value, expected, guard) => { guard(); assert.equal(values.get(key)?.revision ?? null, expected); values.set(key, structuredClone(value)) } }, "project", directory)
  let doc = await documents.create("business_review", { title: "Business", objective: "Work", template: "custom", taskMode: "native",
    profileID: "profile", executionHost: "local", roots: [{ mode: "directory-only", directory }], watchedConversationIDs: [],
    profiles: { coordinator: { agent: "worker", model: { providerID: "unit", id: "model" } },
      roles: { specialist: { agent: "worker", model: { providerID: "unit", id: "model" } } } },
    launch: { timing: scheduled ? { kind: "every", intervalMs: 900_000 } : { kind: "immediate" }, condition: null, ends: { at: null, afterMs: null, maxLaunches: null } } }, at, current)
  doc = await documents.change(doc.id, doc.revision, current, next => {
    changes.play(next, "first_play", at, [])
    if (scheduled) changes.synchronized(next, "first_play", ["principal", "reconciliation"].map((role, slot) => ({
      role: role as "principal" | "reconciliation", slot: role === "principal" ? slot : 0, timeGeneration: next.timeGeneration,
      scheduleID: `sch_${role}`, sessionID: `ses_${role}`, highWater: 0, pendingWake: null, wakePreparing: null,
    })))
    changes.reserve(next, { kind: scheduled ? "manual" : "immediate", requestID: "original" }, at + 1, [])
    if (!lostACK) changes.admitted(next, next.pending!.id, at + 2)
    next.calendarOwner = missionCalendarOwnerSchema.parse({ version: 1, installation: { registrationFile,
      provider, runtime: savedRuntime },
      profileSource: { profileID: "profile", executionHost: "local", configYamlPath: path.join(directory, "profile.yaml") },
      placement: { rootsDigest: "a".repeat(64), roots: [{ directory, physical: directory, dev: "1", ino: "1", birth: "1" }], routing: [], gitEnvironmentDigest: "a".repeat(64) },
      operation: { requestID: "first_play", expectedRevision: 0, fingerprint: "a".repeat(64), action: "play", pending: false, startedAt: at },
      receipts: [], slots: [], retired: [], auxiliaryReady: false, error: null })
  })
  const pending = doc.pending!, rootID = pending.coordinatorSessionID, childID = "ses_child"
  const sessions = new Map<string, any>([[rootID, { id: rootID, location: { directory }, projectID: "project",
    metadata: { "codenomad.mission": { missionID: pending.missionID, document: { missionID: doc.id, passageID: pending.id } } } }],
  [childID, { id: childID, parentID: rootID, location: { directory }, projectID: "project" }],
  ["ses_ordinary", { id: "ses_ordinary", location: { directory }, projectID: "project" }]])
  const handlers: Record<string, (raw: unknown) => Effect.Effect<unknown, unknown>> = {}
  const calls = { http: 0, discover: 0, acquired: 0, reconcile: 0, environment: 0, method: [] as string[], privateSource: [] as boolean[], originalPrompts: 0 }
  const state = { originalPresent, active: true, promptLock: false, afterDiscover: async () => {}, response: undefined as Response | undefined,
    loseReply: false, responseBytes: [] as number[], writes: 0 }
  const read = async () => await documents.read(doc.id) as MissionDocument
  const ctx = { location, storage: { get: (key: string) => Effect.sync(() => structuredClone(values.get(key))) },
    session: { get: ({ sessionID }: { sessionID: string }) => Effect.gen(function* () {
      calls.privateSource.push(Option.isSome(yield* Effect.serviceOption(tag("@opencode/Session"))))
      return structuredClone(sessions.get(sessionID))
    }) }, rpc: { register: (_definition: unknown, methods: typeof handlers) => Effect.sync(() => { Object.assign(handlers, methods); return {} }) },
  } as unknown as Plugin.Context
  const namespace = `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:`
  const db = { db: { $client: { unsafe: (_sql: string, params: readonly string[]) => ({ withoutTransform: Effect.sync(() => {
    const value = values.get(params[0].slice(namespace.length)); return value === undefined ? [] : [{ value: JSON.stringify(value) }]
  }) }) } } }
  const partial = Context.add(Context.make(tag("@opencode/Location"), location), tag("@opencode/storage/Database"), db)
  const withSession = Context.add(partial, tag("@opencode/Session"), { native: true })
  const full = scheduled ? Context.add(withSession, tag("@opencode/Schedule"), { native: true }) : withSession
  const invocation = nativeInvocation(), scope = await Effect.runPromise(Scope.make())
  t.after(() => Effect.runPromise(Scope.close(scope, { _tag: "Success", value: undefined } as never)))
  const mission = { id: pending.missionID, title: "Mission", objective: "Work", template: "custom", revision: 2, status: "active", runState: "running",
    frontier: [], tasks: [{ key: "owned", title: "Owned", role: "specialist", blockedBy: [], brief: "Owned", status: "ready",
      executionMode: { kind: "native", parentTaskKey: null }, contractGeneration: 1 },
    { key: "unrelated", brief: "x".repeat(1024 * 1024) }], reports: [{ summary: "must not cross mutation wire" }] }
  const control = realBusiness ? new MissionControl({ project: { id: "project", canonical: directory, location: { directory } },
    storage: { get: async key => structuredClone(values.get(key)), set: async (key, value) => { state.writes++; values.set(key, structuredClone(value)) },
      scan: async ({ prefix, after, limit = 100 }) => {
        const keys = [...values.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort()
        return { entries: keys.slice(0, limit).map(key => ({ key, value: structuredClone(values.get(key)) })),
          ...(keys.length > limit ? { next: keys[limit - 1] } : {}) }
      } }, sessions: { get: async ({ sessionID }) => structuredClone(sessions.get(sessionID)),
      create: async () => { throw new Error("Unexpected create") }, prompt: async () => {}, synthetic: async () => {} }, now: () => at }) : { backendActions: false,
    declare: async () => { calls.method.push("declare"); return { disposition: "declared", mission, contract: { taskKey: "owned", generation: 1 } } },
    inspect: async () => { calls.method.push("inspect"); return { mission, actor: null } },
    inspectTool: (...args: Parameters<MissionControl["inspectTool"]>) => missionToolInspection(control, ...args),
    ownedRoot: async () => ({ id: rootID, metadata: { unused: "x".repeat(1024 * 1024) } }),
    contextFor: async () => { calls.method.push("contextFor"); return { instruction: "Owned context", coordinator: true } },
    report: async () => { calls.method.push("report"); return { disposition: "reported", taskKey: "owned", mission } },
  } as unknown as MissionControl
  if (realBusiness) await control.create({ requestID: pending.id, coordinatorSessionID: rootID, objective: "Work", template: "custom" })
  const runtime = {
    reconcile: async () => {
      calls.reconcile++
      if (state.promptLock) throw new Error("Prompt hook reentered the document transport")
      const before = await read()
      if (before.pending!.admittedAt === null && state.originalPresent) await documents.change(before.id, before.revision, current,
        next => changes.admitted(next, next.pending!.id, at + 3))
      return "pending"
    },
    businessSelection: async (sessionID: string, entry: { current(): true }) => {
      entry.current()
      if ((await read()).pending!.admittedAt === null) throw new Error("Admission remains unknown")
      return { readSessionID: sessionID === childID ? rootID : sessionID }
    },
    executeBusiness: async (_sessionID: string, entry: { current(): true }, use: (control: MissionControl) => Promise<unknown>) => {
      entry.current(); return { value: await use(control) }
    },
    prepareBusiness: async (_sessionID: string, entry: { current(): true }) => {
      entry.current()
      if ((await read()).pending!.admittedAt === null) throw new Error("Admission remains unknown")
      calls.environment++; return true
    },
  } as unknown as Parameters<typeof executeNativeScheduledBusiness>[0]
  const acquire = () => Effect.gen(function* () {
    assert.ok(Option.isSome(yield* Effect.serviceOption(tag("@opencode/Session"))))
    assert.equal(Option.isSome(yield* Effect.serviceOption(tag("@opencode/Schedule"))), scheduled)
    calls.acquired++; return runtime
  })
  const bridge = await Effect.runPromiseWith(Context.add(partial, Scope.Scope, scope))(registerNativeScheduledBusinessRpc(ctx, artifacts, invocation, acquire))
  t.mock.method(Service, "discover", async (options?: Parameters<typeof Service.discover>[0]) => { calls.discover++; assert.deepEqual(options, { file: registrationFile }); await state.afterDiscover()
    return { url: identity.url, auth: { type: "basic" as const, username: "opencode", password: "unit-private-auth" } } })
  for (const name of ["ensure", "stop"] as const) t.mock.method(Service, name, () => { throw new Error("Forbidden lifecycle") })
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.http++
    const request = new Request(input, init), url = new URL(request.url)
    assert.equal(request.headers.get("authorization"), `Basic ${Buffer.from("opencode:unit-private-auth").toString("base64")}`)
    if (state.response) return state.response
    const prefix = `/api/rpc/${encodeURIComponent(NativeScheduledBusinessRpc.id)}/`
    assert.ok(url.pathname.startsWith(prefix)); assert.equal(request.method, "POST")
    const method = url.pathname.slice(prefix.length), raw = await request.json() as { input: unknown }
    const result = await Effect.runPromiseWith(full)(handlers[method](raw.input))
    state.responseBytes.push(Buffer.byteLength(JSON.stringify({ output: result })))
    if (state.loseReply) { state.loseReply = false; throw new Error("Lost committed response") }
    return Response.json({ output: result })
  })
  const invoke = <T>(use: () => Promise<T>) => Effect.runPromiseWith(partial)(invocation.capture(Effect.promise(use)))
  const receive = (method: string, raw: unknown) => Effect.runPromiseWith(full)(handlers[method](raw))
  const binding = { documentID: doc.id, passageID: pending.id, missionID: pending.missionID, rootID }
  return { bridge, calls, state, invoke, receive, rootID, childID, binding, identity, registrationFile, read, documents, mission, artifacts, savedRuntime, control }
}

test("ordinary callbacks use only public ancestry: zero discovery, HTTP or private acquisition", async t => {
  const f = await fixture(t)
  assert.equal(await f.invoke(() => f.bridge.select("ses_ordinary")), undefined)
  assert.equal(await f.invoke(() => f.bridge.prepare("ses_ordinary")), false)
  assert.equal(f.calls.http, 0); assert.equal(f.calls.discover, 0); assert.equal(f.calls.acquired, 0)
  assert.ok(f.calls.privateSource.every(value => !value))
})

test("pure immediate context prepares ENV and reports without technical files, current provider identity or a Schedule tag", async t => {
  const f = await fixture(t)
  rmSync(f.artifacts.provider.file); rmSync(f.savedRuntime.file)
  f.artifacts.provider = { file: path.join(f.savedRuntime.file, "different-provider"), sha256: "c".repeat(64) }
  await f.invoke(async () => {
    const route = await f.bridge.select(f.rootID)
    assert.ok(route, "immediate remains selected business, never ordinary fallback")
    assert.equal(f.calls.acquired, 1); assert.equal(f.calls.environment, 1)
    const report = await route.control.report(f.rootID, { outcome: "completed", summary: "Done", evidence: [], next: [], final: false })
    assert.ok("toolResult" in report)
    assert.equal(report.toolResult.disposition, "reported")
    assert.equal(f.calls.acquired, 2, "one fresh qualified acquisition per RPC")
  })
  assert.deepEqual(f.calls.method, ["report"])
  assert.equal(f.calls.reconcile, 1)
})

test("a scheduled pending with the same missing technical files is blocked before native acquisition or ENV", async t => {
  const f = await fixture(t, false, true, false, true)
  rmSync(f.artifacts.provider.file); rmSync(f.savedRuntime.file)
  await assert.rejects(f.invoke(() => f.bridge.select(f.rootID)))
  assert.equal(f.calls.acquired, 0); assert.equal(f.calls.environment, 0)
  assert.deepEqual(f.calls.method, [])
})

test("the derived calendar requirement is captured even when binding IDs and installation are unchanged", async t => {
  const f = await fixture(t)
  await f.invoke(async () => {
    const route = await f.bridge.select(f.rootID)
    assert.ok(route)
    const http = f.calls.http, before = await f.read()
    await f.documents.change(before.id, before.revision, current, next => {
      // Controlled source drift: the client must not cross its captured branch.
      next.configuration.launch.timing = { kind: "every", intervalMs: 900_000 }
      next.pending!.configuration.launch.timing = { kind: "every", intervalMs: 900_000 }
    })
    await assert.rejects(route.control.contextFor(route.readSessionID))
    assert.equal(f.calls.http, http)
  })
})

test("same exact provider accepts an intact saved runtime across upgrade; missing old bytes or a different provider stay blocked", async t => {
  const f = await fixture(t, false, true, true, true)
  assert.notEqual(f.artifacts.runtime.sha256, f.savedRuntime.sha256)
  await f.invoke(async () => {
    const route = await f.bridge.select(f.rootID)
    assert.ok(route)
    assert.ok((await route.control.contextFor(route.readSessionID))!.instruction)
  })
  assert.deepEqual(f.calls.method, ["contextFor"])
  const selected = f.calls.acquired
  f.artifacts.provider = { ...f.artifacts.provider, sha256: "c".repeat(64) }
  await assert.rejects(f.invoke(() => f.bridge.select(f.rootID)))
  assert.equal(f.calls.acquired, selected)
  f.artifacts.provider = { ...f.artifacts.provider, sha256: createHash("sha256").update("provider").digest("hex") }
  rmSync(f.savedRuntime.file)
  await assert.rejects(f.invoke(() => f.bridge.select(f.rootID)))
  assert.equal(f.calls.acquired, selected, "missing saved bundle fails before native runtime acquisition")
})

test("partial client graphs cross HTTP into a fresh full receiver; mutation projection precedes 1MiB serialization", async t => {
  const f = await fixture(t)
  await f.invoke(async () => {
    const route = await f.bridge.select(f.rootID)
    assert.ok(route); assert.equal(route.control.backendActions, false)
    const result = await route.execute!(control => control.declare(f.rootID, { taskKey: "owned", title: "Owned", role: "specialist", brief: "Work", blockedBy: [],
      executionMode: { kind: "native", parentTaskKey: null } }))
    assert.ok("toolResult" in result)
    assert.equal((result.toolResult.task as { key: string }).key, "owned")
    assert.equal("mission" in result.toolResult, false)
    const context = await route.execute!(control => control.contextFor(route.readSessionID))
    assert.equal(context!.instruction, "Owned context")
    await assert.rejects(route.control.interruptTask(f.rootID, { taskKey: "owned" }))
    await assert.rejects(route.control.prepare(f.rootID, { requestID: "handoff", objective: "No", template: "custom" }))
  })
  assert.equal(f.calls.http, 3); assert.equal(f.calls.acquired, 3)
  assert.ok(f.calls.privateSource.includes(false) && f.calls.privateSource.includes(true))
  assert.deepEqual(f.calls.method, ["declare", "contextFor"])
})

test("prompt membership never enters HTTP or the document lock; context reconciles the original once before ENV and selection", async t => {
  const f = await fixture(t, true)
  assert.equal((await f.read()).launchedCount, 0)
  await f.documents.withExclusion(async locked => {
    locked.assertActive(); f.state.promptLock = true
    try { assert.equal(await f.invoke(() => f.bridge.prepare(f.childID)), true) }
    finally { f.state.promptLock = false }
  })
  assert.equal((await f.read()).launchedCount, 0)
  assert.equal(f.calls.http, 0); assert.equal(f.calls.acquired, 0); assert.equal(f.calls.environment, 0)
  assert.ok(await f.invoke(() => f.bridge.select(f.childID)))
  assert.equal((await f.read()).launchedCount, 1)
  assert.ok(await f.invoke(() => f.bridge.select(f.childID)))
  assert.equal((await f.read()).launchedCount, 1); assert.equal(f.calls.environment, 2)
  assert.equal(f.calls.originalPrompts, 0); assert.ok((await f.read()).pending, "an active current turn stays pending")
})

test("an attempted input without a positive original cannot restore ENV, select business or send another prompt", async t => {
  const f = await fixture(t, true, false)
  assert.equal(await f.invoke(() => f.bridge.prepare(f.childID)), true, "prompt acknowledges membership, not admission or ENV")
  assert.equal(f.calls.http, 0); assert.equal(f.calls.acquired, 0)
  await assert.rejects(f.invoke(() => f.bridge.select(f.childID)))
  assert.equal((await f.read()).launchedCount, 0); assert.equal(f.calls.environment, 0); assert.equal(f.calls.originalPrompts, 0)
})

test("unknown methods, lifecycle, malformed args and caller/root substitution fail before property invocation", async t => {
  const f = await fixture(t), base = { sessionID: f.childID, binding: f.binding, incarnation: f.identity }
  for (const method of ["constructor", "lifecycle", "delete", "__proto__"]) await assert.rejects(f.receive("execute", { ...base, method, args: [] }))
  for (const [method, args] of [["declare", [f.rootID, {}]], ["declare", [f.childID, {}]], ["contextFor", ["ses_other"]],
    ["reportNative", [{ sessionID: f.rootID, contract: {}, toolCallID: "tool", messageID: "msg" }, {}]], ["prepare", [f.childID, {}]], ["interruptTask", [f.childID, {}]]] as const)
    await assert.rejects(f.receive("execute", { ...base, method, args }))
  assert.deepEqual(f.calls.method, [])
})

test("stale incarnation, caller-chosen paths, output overflow and source replacement are closed without retry", async t => {
  const f = await fixture(t), base = { sessionID: f.rootID, binding: f.binding, incarnation: f.identity }
  await assert.rejects(f.receive("select", { ...base, registrationFile: "other" }))
  await assert.rejects(f.receive("select", { ...base, incarnation: { ...f.identity, id: "replaced" } }))
  f.state.afterDiscover = async () => { writeFileSync(f.registrationFile, JSON.stringify({ ...f.identity, id: "changed" })) }
  await assert.rejects(f.invoke(() => f.bridge.select(f.rootID)))
  assert.equal(f.calls.http, 0)
  f.state.afterDiscover = async () => {}; writeFileSync(f.registrationFile, JSON.stringify(f.identity))
  f.state.response = new Response("x".repeat(1024 * 1024 + 1), { headers: { "content-type": "application/json" } })
  await assert.rejects(f.invoke(() => f.bridge.select(f.rootID)))
  assert.equal(f.calls.http, 1); assert.deepEqual(f.calls.method, [])
})

test("read and mutation identities are bound separately; delegate targets must belong to the same pending document", async () => {
  assert.throws(() => missionBusinessCall("declare", ["ses_root", {}], "ses_child", "ses_root", "msn_owned"))
  assert.throws(() => missionBusinessCall("inspect", ["ses_root", { start: { template: "custom", objective: "No" } }, "op"], "ses_child", "ses_root", "msn_owned"))
  const input = { sessionID: "ses_root", binding: { documentID: "doc", passageID: "pass", missionID: "msn_owned", rootID: "ses_root" }, incarnation: {},
    method: "delegate" as const, args: ["ses_root", { taskKey: "owned", role: "specialist", title: "Owned", brief: "Work", blockedBy: [], targetSessionID: "ses_other",
      executionMode: { kind: "independent", reason: "existing-root", explanation: "Owned root" } }] }
  let invoked = false
  const runtime = { businessSelection: async (id: string) => ({ readSessionID: id }), executeBusiness: async () => { invoked = true } } as unknown as Parameters<typeof executeNativeScheduledBusiness>[0]
  await assert.rejects(executeNativeScheduledBusiness(runtime, { current, signal: new AbortController().signal }, input, input.binding,
    async () => ({ ...input.binding, documentID: "foreign", rootID: "ses_other" })))
  assert.equal(invoked, false)
  for (const method of ["inspect", "observeTask", "decisionCandidates", "listMissions"] as const) {
    assert.throws(() => missionBusinessCall(method, ["ses_root", { taskKey: "owned" }, "read"], "ses_root", "ses_root", "msn_owned"), /inspectTool/)
  }
})

test("catalog ownership transports only acknowledgement, independent of native session metadata size", async t => {
  const f = await fixture(t)
  const route = await f.invoke(() => f.bridge.select(f.rootID))
  assert.ok(route)
  assert.equal(await f.invoke(() => route.control.ownedRoot(f.rootID)), null)
  assert.ok(Math.max(...f.state.responseBytes) < 1_024)
})

test("scheduled inspection fits before RPC, and exact content continuations cross the same bounded bridge", async t => {
  const f = await fixture(t)
  const route = await f.invoke(() => f.bridge.select(f.rootID))
  assert.ok(route)
  const inspect = (input: Record<string, unknown>) => f.invoke(() => route.control.inspectTool(f.rootID, input, "read", undefined)) as Promise<any>
  const header = await inspect({})
  assert.ok(JSON.stringify(header, null, 2).length <= MISSION_INSPECT_OUTPUT_LIMIT)
  assert.equal(header.taskPage.total, 2)
  const page = await inspect({ taskOffset: header.taskPage.nextTaskOffset })
  const marker = page.mission.tasks[0].brief
  assert.ok(marker.read)
  let read = marker.read, joined = ""
  do {
    const slice = await inspect(read)
    assert.ok(JSON.stringify(slice, null, 2).length <= MISSION_INSPECT_OUTPUT_LIMIT)
    joined += slice.content.text
    read = slice.content.next
  } while (read)
  assert.equal(joined, "x".repeat(1024 * 1024))
  await assert.rejects(inspect({ missionID: "msn_foreign" }))
})

for (const unicode of [false, true]) test(`real control through authenticated RPC: 60 huge tasks commit and replay after reply loss (${unicode ? "three-byte BMP" : "ASCII"})`, async t => {
  const f = await fixture(t, false, true, false, false, true)
  const keys = Array.from({ length: 60 }, (_, i) => `task-${String(i).padStart(2, "0")}`)
  for (let batch = 0; batch < 3; batch++) await f.control.revise(f.rootID, { expectedRevision: batch + 1, requestID: `seed-${batch}`, reason: "Seed",
    addTasks: keys.slice(batch * 20, batch * 20 + 20).map(taskKey => ({ taskKey, title: unicode ? "\u0800".repeat(240) : taskKey,
      role: "specialist", brief: (unicode ? "\u0800" : "x").repeat(20_000),
      blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } })), dependencyUpdates: [], retireTasks: [] })
  const input = { expectedRevision: 4, requestID: "small-revision", reason: "Rewire", addTasks: [], retireTasks: [],
    dependencyUpdates: keys.map(taskKey => ({ taskKey, blockedBy: [] })) }
  const route = await f.invoke(() => f.bridge.select(f.rootID))
  assert.ok(route)
  f.state.loseReply = true
  await assert.rejects(f.invoke(() => route.control.revise(f.rootID, input)), /unavailable/)
  assert.equal((await f.control.mission(f.binding.missionID)).mission!.revision, 5)
  const writes = f.state.writes
  const reply = await f.invoke(() => route.control.revise(f.rootID, input))
  assert.ok("toolResult" in reply)
  assert.equal(f.state.writes, writes)
  assert.deepEqual(reply.toolResult, missionMutationToolResult("revise", input, await f.control.revise(f.rootID, input)))
  assert.equal((reply.toolResult.tasks as unknown[]).length, 60)
  assert.ok(Math.max(...f.state.responseBytes) < 300_100)
  t.diagnostic(`request=${Buffer.byteLength(JSON.stringify(input))}; response=${f.state.responseBytes.at(-1)} bytes; revision=5; writes-on-replay=0`)
})
