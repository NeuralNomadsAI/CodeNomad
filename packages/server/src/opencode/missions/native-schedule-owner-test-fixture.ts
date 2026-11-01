import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { Effect } from "effect"
import type test from "node:test"
import type { Plugin } from "@opencode/plugin/effect"
import { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { previewMissionCalendar } from "../../missions/mission-calendar-plan"
import type { MissionConfiguration } from "../../missions/launch-policy"
import type { MissionJsonValue } from "../../missions/model"
import { NATIVE_SCHEDULE_CARRIER_MODEL } from "./native-schedule-carrier"
import { nativeScheduleCarrierLookupKey, NATIVE_SCHEDULE_CARRIER_MARKER } from "./native-schedule-carrier-binding"
import { NativeScheduleCalendarOwner, type NativeScheduleOwnerOptions } from "./native-schedule-owner"
import { nativeScheduleOwnerBindings } from "./native-schedule-owner-bindings"
import type { NativeScheduleCalendarInfo, NativeScheduleCalendarService, NativeScheduleCalendarTarget } from "./native-schedule-calendar-service"

export async function ownerFixture(t: test.TestContext, timing: MissionConfiguration["launch"]["timing"] = { kind: "every", intervalMs: 90 * 60_000 }, maximum = 3,
  sources?: NativeScheduleOwnerOptions["sources"]) {
  const scratch = process.env.CODENOMAD_SCHEDULE_TEST_SCRATCH ?? path.join(os.tmpdir(), "codenomad-owner-tests")
  mkdirSync(scratch, { recursive: true })
  const directory = mkdtempSync(path.join(scratch, "calendar-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const values = new Map<string, MissionJsonValue>(), sessions = new Map<string, any>(), calendars = new Map<string, NativeScheduleCalendarInfo>()
  const calls: string[] = [], blocked = new Set<string>()
  let serial = 0, lost: boolean | "principal" | "reconciliation" = false, absentCreate = false, allowResume = false
  const current = () => true as const, now = Date.now()
  let clock = now, auxiliaryDelay = 0
  const store = new NativeMissionDocumentStore({ get: async key => structuredClone(values.get(key)), compareAndSet: async (key, value, expected, guard) => {
    guard()
    const previous = values.get(key) as { revision: number } | undefined
    if ((previous?.revision ?? null) !== expected) throw new Error("CAS conflict")
    values.set(key, structuredClone(value))
  } }, "project", directory)
  const selection = { agent: "build", model: { ...NATIVE_SCHEDULE_CARRIER_MODEL } }
  const configuration: MissionConfiguration = { title: "Calendar test", objective: "Bounded test", template: "custom", taskMode: "native", profileID: "profile", executionHost: "host",
    profiles: { coordinator: selection, roles: { specialist: selection } }, roots: [{ mode: "directory-only", directory }], watchedConversationIDs: [],
    launch: { timing, condition: null, ends: { maxLaunches: maximum, afterMs: null, at: null } } }
  let doc = await store.create("calendar_test", configuration, now - 1, current)
  doc = await store.change(doc.id, doc.revision, current, value => { value.scheduleActivation = { requestID: "activation", expectedRevision: 0,
    authority: "0".repeat(64), state: "ready", targets: [], effectiveOrigin: directory } })
  const ctx = { location: { directory, project: { id: "project", canonical: directory } }, storage: {
    get: (key: string) => Effect.sync(() => structuredClone(values.get(key))),
    set: (key: string, value: MissionJsonValue) => Effect.sync(() => { values.set(key, structuredClone(value)) }),
    remove: (key: string) => Effect.sync(() => { values.delete(key) }),
  }, session: { get: ({ sessionID }: { sessionID: string }) => sessions.has(sessionID) ? Effect.succeed(sessions.get(sessionID)) : Effect.fail({ _tag: "Session.NotFoundError" }) } } as unknown as Plugin.Context
  const record = (action: string, target: NativeScheduleCalendarTarget, guard: () => true) => { guard(); calls.push(`${action}:${target.descriptor.role}`) }
  const native: NativeScheduleCalendarService = {
    directory, assertCurrent: current,
    ensureCarrier: async (target, guard) => {
      record("carrier", target, guard)
      if (!values.has(nativeScheduleCarrierLookupKey(ctx, target.descriptor.sessionID))) throw new Error("Index must precede carrier")
      if (!sessions.has(target.descriptor.sessionID)) sessions.set(target.descriptor.sessionID, { id: target.descriptor.sessionID, projectID: "project", location: { directory },
        model: { ...NATIVE_SCHEDULE_CARRIER_MODEL }, metadata: { [NATIVE_SCHEDULE_CARRIER_MARKER]: { missionID: target.missionID,
          timeGeneration: target.descriptor.timeGeneration, role: target.descriptor.role, slot: target.descriptor.slot } } })
    },
    list: async (target, guard) => { record("list", target, guard); return [...calendars.values()].filter(info => info.sessionID === target.descriptor.sessionID).map(info => structuredClone(info)) },
    get: async (target, id, guard) => { record("get", target, guard); return structuredClone(calendars.get(id)) },
    create: async (target, guard) => {
      record("create", target, guard)
      if (target.descriptor.role === "reconciliation") { clock += auxiliaryDelay; auxiliaryDelay = 0 }
      if (absentCreate) { absentCreate = false; throw new Error("Dispatched create outcome unknown") }
      const info: NativeScheduleCalendarInfo = { id: `sch_${++serial}`, sessionID: target.descriptor.sessionID, name: target.descriptor.name,
        when: structuredClone(target.descriptor.when), endsAt: target.descriptor.endsAt, status: "active", runCount: 0, remainingRuns: null,
        createdAt: target.descriptor.anchorAt!, nextDueAt: previewMissionCalendar({ ...target.descriptor, anchorAt: target.descriptor.anchorAt! }, target.descriptor.anchorAt!, 1)[0] ?? null }
      if (info.nextDueAt === null) throw new Error("The schedule ends before it first fires")
      calendars.set(info.id, info)
      if (lost === true || lost === target.descriptor.role) { lost = false; throw new Error("Create ACK lost") }
      return structuredClone(info)
    },
    pause: async (target, id, guard) => { record("pause", target, guard); const info = calendars.get(id)!; info.status = "paused"; return structuredClone(info) },
    resume: async (target, id, guard) => { record("resume", target, guard); const info = calendars.get(id)!; info.status = "active"; return structuredClone(info) },
    remove: async (target, id, guard) => { record("remove", target, guard); calendars.delete(id) },
    carrierQuiet: async (target, guard) => { record("quiet", target, guard); return !blocked.has(target.descriptor.sessionID) },
    removeCarrier: async (target, guard) => { record("remove-carrier", target, guard); if (blocked.has(target.descriptor.sessionID)) throw new Error("Carrier children/claim remain"); sessions.delete(target.descriptor.sessionID) },
    wakeAcknowledged: async (target, _wake, guard) => { record("wake-proof", target, guard); return false },
  }
  const bytes = "export const owned = true", artifact = (name: string) => {
    const file = path.join(directory, name); writeFileSync(file, bytes)
    return { file, sha256: createHash("sha256").update(bytes).digest("hex") }
  }
  const installation = { registrationFile: path.join(directory, "registration.json"), provider: artifact("provider.mjs"), runtime: artifact("runtime.mjs") }
  const makeOwner = (store: NativeMissionDocumentStore, textEdit: Pick<NativeScheduleOwnerOptions, "prepareTextEdit" | "recordTextEdit"> = {}) => new NativeScheduleCalendarOwner({ store, native, bindings: nativeScheduleOwnerBindings(ctx, Effect.runPromise),
    installation, profileSource: { profileID: "profile", executionHost: "host", configYamlPath: path.join(directory, "config.yaml") }, current, now: () => clock, sources, ...textEdit,
    resumePending: async (_locked, document) => allowResume && document.pending ? { passageID: document.pending.id, messageID: document.pending.messageID,
      coordinatorSessionID: document.pending.coordinatorSessionID, current } : undefined })
  const owner = makeOwner(store)
  const read = async () => { const result = await store.read(doc.id); if (!result || "deletedAt" in result) throw new Error("missing fixture doc"); return result }
  const control = async (action: Parameters<typeof owner.control>[0]["action"], requestID = `request_${action}`, configuration?: MissionConfiguration) => {
    const fresh = await read(); return owner.control({ missionID: fresh.id, requestID, expectedRevision: fresh.revision, action, configuration })
  }
  return { owner, makeOwner, store, native, ctx, directory, values, sessions, calendars, calls, blocked, configuration, read, control, current, now,
    advance: (ms: number) => { clock += ms }, delayAuxiliary: (ms: number) => { auxiliaryDelay = ms },
    loseCreateACK: (role?: "principal" | "reconciliation") => { lost = role ?? true }, loseCreateWithoutCandidate: () => { absentCreate = true }, allowPendingResume: () => { allowResume = true } }
}
