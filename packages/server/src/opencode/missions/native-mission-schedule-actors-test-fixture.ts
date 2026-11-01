import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type test from "node:test"
import { Service } from "@opencode/client/service"
import type { Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Schema } from "effect"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { MissionControl } from "../../missions/control"
import type { MissionInputTransport } from "../../missions/control-types"
import { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import type { MissionDocument } from "../../missions/mission-document"
import { missionDocumentPassage } from "../../missions/mission-document-passage-storage"
import { captureMissionCalendarPlacement } from "../../missions/mission-calendar-placement"
import { missionCalendarOwnerSchema } from "../../missions/mission-calendar-owner-state"
import { acquireNativeScheduledActorTransport } from "./native-mission-schedule-actors"
import type { ownerFixture } from "./native-schedule-owner-test-fixture"

const current = () => true as const

export async function actorFixture(t: test.TestContext, calendar?: Awaited<ReturnType<typeof ownerFixture>>) {
  const directory = calendar?.directory ?? mkdtempSync(path.join(os.tmpdir(), "schedule-actors-"))
  if (!calendar) t.after(() => rmSync(directory, { recursive: true, force: true }))
  const saved = await calendar?.read(), at = calendar?.now ?? Date.parse("2026-10-01T00:00:00Z")
  const registrationFile = saved?.calendarOwner!.installation.registrationFile ?? path.join(directory, "owned-channel.json")
  const configYamlPath = saved?.calendarOwner!.profileSource.configYamlPath ?? path.join(directory, "profile.yaml")
  const identity = { id: "actors-private", pid: process.pid, url: "http://127.0.0.1:1", version: "future-qualified" }
  writeFileSync(registrationFile, JSON.stringify({ ...identity, password: "private-memory-only" }))
  writeFileSync(configYamlPath, "server:\n  environmentVariables:\n    ACTOR_FIXTURE: fresh\n")
  const artifact = (name: string) => { const file = path.join(directory, name); writeFileSync(file, name)
    return { file, sha256: createHash("sha256").update(name).digest("hex") } }
  const installation = saved?.calendarOwner!.installation ?? { registrationFile, provider: artifact("provider.mjs"), runtime: artifact("runtime.mjs") }
  const values = calendar?.values ?? new Map<string, any>(), sessions = calendar?.sessions ?? new Map<string, any>()
  const active = new Set<string>(), inboxes = new Map<string, any[]>()
  const calls: Array<{ kind: string; id: string }> = [], admissions = new Map<string, any>()
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const storage = {
    get: async (key: string) => structuredClone(values.get(key)),
    set: async (key: string, value: any) => { values.set(key, structuredClone(value)) },
    scan: async ({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) => {
      const keys = [...values.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort()
      const page = keys.slice(0, limit)
      return { entries: page.map(key => ({ key, value: structuredClone(values.get(key)) })), ...(keys.length > limit ? { next: page.at(-1) } : {}) }
    },
    compareAndSet: async (key: string, value: any, expected: number | null, guard: () => true) => {
      guard(); assert.equal(values.get(key)?.revision ?? null, expected); values.set(key, structuredClone(value))
    },
  }
  const documents = calendar?.store ?? new NativeMissionDocumentStore(storage, "project", directory)
  const selection = saved?.configuration.profiles!.coordinator ?? { agent: "worker", model: { providerID: "unit", id: "model" } }
  let doc = saved ?? await documents.create("actors_review", { title: "Actors", objective: "Work", template: "custom", taskMode: "native",
    profileID: "profile", executionHost: "local", roots: [{ mode: "directory-only", directory }], watchedConversationIDs: [],
    profiles: { coordinator: selection, roles: { specialist: selection } },
    launch: { timing: { kind: "immediate" }, condition: null, ends: { maxLaunches: null, at: null, afterMs: null } } }, at, current)
  doc = await documents.change(doc.id, doc.revision, current, next => {
    if (!calendar) changes.play(next, "first_play", at, [])
    changes.reserve(next, { kind: calendar ? "manual" : "immediate", requestID: "original_passage" }, at + 1, [])
    changes.admitted(next, next.pending!.id, at + 2)
    if (!calendar) next.calendarOwner = missionCalendarOwnerSchema.parse({ version: 1, installation, profileSource: { profileID: "profile", executionHost: "local", configYamlPath },
      placement: captureMissionCalendarPlacement(next.configuration.roots),
      operation: { action: "play", requestID: "first_play", expectedRevision: 0, fingerprint: "a".repeat(64), pending: false, startedAt: at },
      receipts: [], checks: [], slots: [], retired: [], auxiliaryReady: false, error: null })
  })
  const pending = doc.pending!, coordinatorID = pending.coordinatorSessionID
  const add = (id: string, parentID?: string) => {
    const session = { id, parentID, projectID: "project", location: { directory }, ...selection,
      metadata: parentID ? {} : { "codenomad.mission": { version: 1, missionID: pending.missionID, kind: "coordinator", role: "coordinator",
        document: { missionID: doc.id, passageID: pending.id } } }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: at, updated: at } }
    sessions.set(id, session); active.add(id); inboxes.set(id, [])
    return session
  }
  add(coordinatorID); add("ses_child", coordinatorID); add("ses_grandchild", "ses_child")
  const state = { stuck: "", late: false, lostCancel: false, malformedInterrupt: false, live: true,
    beforeInterrupt: () => {}, beforeFetch: (() => {}) as () => void | Promise<void>,
    storageEffect: undefined as ((kind: "get" | "scan") => Effect.Effect<void, unknown>) | undefined,
    interruptEffect: undefined as ((sessionID: string) => Effect.Effect<void, unknown>) | undefined }
  const ctx = { location, storage: {
    get: (key: string) => Effect.gen(function* () { if (state.storageEffect) yield* state.storageEffect("get"); return yield* Effect.promise(() => storage.get(key)) }),
    scan: (input: any) => Effect.gen(function* () { if (state.storageEffect) yield* state.storageEffect("scan"); return yield* Effect.promise(() => storage.scan(input)) }),
  }, session: {
    get: ({ sessionID }: { sessionID: string }) => Effect.sync(() => {
      if (!sessions.has(sessionID)) throw Object.assign(new Error("Missing actor"), { _tag: "SessionNotFoundError", sessionID })
      return structuredClone(sessions.get(sessionID))
    }),
    interrupt: ({ sessionID, resume }: { sessionID: string; resume: boolean }) => Effect.gen(function* () {
      state.beforeInterrupt(); assert.equal(resume, false); calls.push({ kind: "interrupt", id: sessionID })
      if (state.interruptEffect) yield* state.interruptEffect(sessionID)
      if (state.malformedInterrupt) return { applied: true }
      if (sessionID === state.stuck) return { interrupted: false }
      const interrupted = active.delete(sessionID)
      sessions.get(sessionID).outcome = "interrupted"
      if (sessionID === coordinatorID && state.late) { state.late = false; add("ses_late", coordinatorID) }
      return { interrupted }
    }),
    synthetic: (input: any) => Effect.sync(() => {
      calls.push({ kind: "synthetic", id: input.id })
      if (!admissions.has(input.id)) admissions.set(input.id, { id: input.id, sessionID: input.sessionID, type: "synthetic", delivery: "queue",
        time: { created: at + 5 }, payload: { text: input.text, description: input.description, metadata: input.metadata } })
      return Schema.decodeUnknownSync(SessionInbox.Synthetic)(admissions.get(input.id))
    }),
  } } as unknown as Plugin.Context
  t.mock.method(Service, "discover", async (options: unknown) => { assert.deepEqual(options, { file: registrationFile }); return {
    url: identity.url, auth: { type: "basic" as const, username: "opencode", password: "private-memory-only" },
  } })
  for (const name of ["ensure", "stop"] as const) t.mock.method(Service, name, () => { throw new Error("Forbidden service lifecycle") })
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    await state.beforeFetch()
    const request = new Request(input, init), url = new URL(request.url)
    assert.equal(request.headers.get("authorization"), `Basic ${Buffer.from("opencode:private-memory-only").toString("base64")}`)
    const childList = url.pathname === "/api/session", inbox = url.pathname.match(/^\/api\/session\/([^/]+)\/inbox(?:\/([^/]+))?$/)
    if (childList) return Response.json({ data: [...sessions.values()].filter(item => item.parentID === url.searchParams.get("parentID")), cursor: {} })
    if (url.pathname === "/api/session/active") return Response.json({ data: Object.fromEntries([...active].map(id => [id, { type: "running" }])) })
    if (inbox) {
      const id = decodeURIComponent(inbox[1])
      if (request.method === "GET") return Response.json({ data: inboxes.get(id) ?? [] })
      calls.push({ kind: "cancel", id })
      inboxes.set(id, (inboxes.get(id) ?? []).filter(item => item.id !== inbox[2]))
      if (state.lostCancel) throw new Error("Private cancellation ACK lost")
      return new Response(null, { status: 204 })
    }
    if (request.method === "PUT" && url.pathname.endsWith("/environment")) {
      calls.push({ kind: "environment", id: coordinatorID }); return new Response(null, { status: 204 })
    }
    throw new Error(`Unexpected private request ${request.method} ${url.pathname}`)
  })
  const passage = missionDocumentPassage(storage, doc, current)
  let port: NonNullable<MissionInputTransport["lifecycle"]> | undefined
  const control = new MissionControl({ project: { id: "project", canonical: directory, location: { directory } }, storage: passage.storage,
    sessions: { get: async ({ sessionID }) => sessions.get(sessionID), create: async () => { throw new Error("No new root") },
      prompt: async () => {}, synthetic: async () => {} }, transport: { prompt: async () => {}, synthetic: async () => {},
      lifecycle: (id, input) => port!(id, input) }, now: () => at + 4 })
  await control.create({ requestID: pending.id, objective: "Work", template: "custom", coordinatorSessionID: coordinatorID })
  const read = async () => await documents.read(doc.id) as MissionDocument
  const change = async (use: (next: MissionDocument) => void) => { const before = await read(); return documents.change(doc.id, before.revision, current, use) }
  const request = async (action: "start" | "pause" | "stop", requestID: string) => ({ missionID: pending.missionID, requestID,
    expectedRevision: (await control.snapshot()).missions[0].revision, action })
  const prepare = async (action: "start" | "pause" | "stop", requestID = `human_${action}`, calendarPending = false) => {
    await change(next => {
      next.state = action === "start" ? "running" : action === "pause" ? "paused" : "stopped"
      next.calendarOwner!.operation = { ...next.calendarOwner!.operation, requestID, action: action === "start" ? "resume" : action, pending: calendarPending }
      next.calendarOwner!.error = calendarPending ? "native-uncertain" : null
    })
    return request(action, requestID)
  }
  const invoke = <T>(use: () => Promise<T>, controlCurrent: () => true = current) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const graph = yield* Effect.context<never>()
    port = yield* acquireNativeScheduledActorTransport(ctx, installation, effect => Effect.runPromiseWith(graph)(effect), () => {
      if (!state.live) throw new Error("Retired invocation"); return controlCurrent()
    })
    return yield* Effect.promise(use)
  })).pipe(Effect.provideService(Context.Service<never, unknown>("@opencode/Location"), location)))
  return { directory, installation, identity, registrationFile, values, sessions, active, inboxes, calls, admissions, coordinatorID,
    pending, state, control, read, change, prepare, request, invoke, storage, port: () => port! }
}
