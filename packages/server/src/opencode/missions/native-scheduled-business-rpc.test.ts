import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Service } from "@opencode/client/service"
import { Context, Effect, Scope, Option } from "effect"
import type { MissionControl } from "../../missions/control"
import { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import { missionCalendarOwnerSchema } from "../../missions/mission-calendar-owner-state"
import type { MissionDocument } from "../../missions/mission-document"
import { missionBusinessCall, missionBusinessResult } from "../../missions/business-control"
import { nativeInvocation } from "./native-invocation"
import { NativeScheduledBusinessRpc, executeNativeScheduledBusiness, registerNativeScheduledBusinessRpc } from "./native-scheduled-business-rpc"

const current = () => true as const, at = Date.parse("2026-10-01T00:00:00Z")
const tag = (name: string) => Context.Service<never, unknown>(name)
async function fixture(t: test.TestContext, lostACK = false, originalPresent = true, upgradedRuntime = false, scheduled = false) {
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
  const state = { originalPresent, active: true, promptLock: false, afterDiscover: async () => {}, response: undefined as Response | undefined }
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
    frontier: [], tasks: [{ key: "owned", brief: "Owned", status: "ready" }, { key: "unrelated", brief: "x".repeat(1024 * 1024) }], reports: [{ summary: "must not cross mutation wire" }] }
  const control = { backendActions: false,
    declare: async () => { calls.method.push("declare"); return { disposition: "declared", mission, contract: { taskKey: "owned", generation: 1 } } },
    inspect: async () => { calls.method.push("inspect"); return { mission, actor: null } },
    contextFor: async () => { calls.method.push("contextFor"); return { instruction: "Owned context", coordinator: true } },
    report: async () => { calls.method.push("report"); return { disposition: "reported", taskKey: "owned", mission } },
  } as unknown as MissionControl
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
    return Response.json({ output: result })
  })
  const invoke = <T>(use: () => Promise<T>) => Effect.runPromiseWith(partial)(invocation.capture(Effect.promise(use)))
  const receive = (method: string, raw: unknown) => Effect.runPromiseWith(full)(handlers[method](raw))
  const binding = { documentID: doc.id, passageID: pending.id, missionID: pending.missionID, rootID }
  return { bridge, calls, state, invoke, receive, rootID, childID, binding, identity, registrationFile, read, documents, mission, artifacts, savedRuntime }
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
    assert.equal(report.disposition, "reported")
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
    assert.deepEqual(result.mission.tasks.map(task => task.key), ["owned"])
    assert.equal("reports" in result.mission, false)
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
  const mission = { id: "msn_owned", tasks: [{ key: "owned" }, { key: "other" }], reports: ["private map"] }
  const result = missionBusinessResult("inspect", ["ses_root", { taskKey: "owned" }], { mission }) as { mission: { tasks: unknown[]; reports?: unknown } }
  assert.equal(result.mission.tasks.length, 1); assert.equal(result.mission.reports, undefined)
})
