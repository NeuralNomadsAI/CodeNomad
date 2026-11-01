// Explicit isolated qualification entry; excluded from product plugin packaging.
import { Plugin, Rpc } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import { missionScheduleRpcMethods } from "../../missions/mission-schedule-contract"
import type { MissionJsonValue } from "../../missions/model"
import { nativeMissionScheduleHandlers } from "./native-mission-schedule-rpc"
import { nativeInvocation } from "./native-invocation"
import { acquireNativeScheduleCalendarService } from "./native-schedule-calendar-service"
import { registerNativeScheduleProvider, assertNativeScheduleProviderAvailable } from "./native-schedule-provider-registration"
import { captureMissionCalendarPlacement } from "../../missions/mission-calendar-placement"
import type { NativeScheduleArtifacts } from "./native-schedule-installation"
import type { MissionCalendarOwnerSlot } from "../../missions/mission-calendar-owner-state"

const method = { input: { type: "object", additionalProperties: false }, output: { type: "object" } } as const
const definition = Rpc.define({ id: "codenomad.schedule-list-qualification", methods: {
  seed: method, scheduleRead: missionScheduleRpcMethods.scheduleRead, scheduleList: missionScheduleRpcMethods.scheduleList,
}, events: {} })

export default Plugin.define({ id: "codenomad.schedule-list-qualification", effect: ctx => Effect.gen(function* () {
  const invocation = nativeInvocation(), production = nativeMissionScheduleHandlers(ctx)
  const artifacts = ctx.options as NativeScheduleArtifacts
  yield* registerNativeScheduleProvider(ctx, artifacts)
  yield* ctx.rpc.register(definition, {
    seed: () => invocation.capture(Effect.scoped(Effect.gen(function* () {
      const native = yield* acquireNativeScheduleCalendarService(ctx, "build", () => true, effect => invocation.check(run => run(effect)),
        () => assertNativeScheduleProviderAvailable(ctx, artifacts))
      return yield* Effect.tryPromise(() => invocation.check(async run => {
      const store = new NativeMissionDocumentStore({ get: key => run(ctx.storage.get(key)),
        // Only the fixture seeds these paused documents. Product reads use their
        // real handler and public native storage.scan implementation below.
        compareAndSet: async (key, value, expected, current) => {
          current()
          const before = await run(ctx.storage.get(key)) as { revision?: number } | undefined
          if ((before?.revision ?? null) !== expected) throw new Error("Fixture seed revision conflict")
          await run(ctx.storage.set(key, value as MissionJsonValue))
        } }, ctx.location.project.id, ctx.location.project.canonical)
      const selection = { agent: "build", model: { providerID: "fixture", id: "fixture" } }
      const configuration = { title: "Display qualification", objective: "Paused qualification only", template: "custom" as const,
        taskMode: "native" as const, profiles: { coordinator: selection, roles: { specialist: selection } }, profileID: "fixture", executionHost: "fixture",
        roots: [{ mode: "directory-only" as const, directory: ctx.location.directory }], watchedConversationIDs: [],
        launch: { timing: { kind: "every" as const, intervalMs: 900_000 }, condition: null, ends: { at: null, afterMs: null, maxLaunches: 3 } } }
      for (let index = 0; index < 11; index++) await store.create(`display_${String(index).padStart(2, "0")}`, configuration, Date.now(), () => true)
      let removed = await store.read("display_01")
      if (!removed || "deletedAt" in removed) throw new Error("Fixture document missing")
      removed = await store.change(removed.id, removed.revision, () => true, value => changes.requestDeletion(value, "delete_fixture", Date.now()))
      removed = await store.change(removed.id, removed.revision, () => true, value => { value.synchronization = null })
      await store.compact(removed.id, removed.revision, Date.now(), () => true)
      const slots: MissionCalendarOwnerSlot[] = [], now = Date.now()
      let principalDueAt: number | null = null
      for (const role of ["principal", "reconciliation"] as const) {
        const slot: MissionCalendarOwnerSlot = { role, slot: 0, timeGeneration: 1, sessionID: `ses_cn_schedule_display_${role}`,
          name: `cm_display_${role}`, when: { type: "every", every: "900000 millis", tz: "UTC" }, endsAt: null,
          anchorAt: now, creation: "attempted", scheduleID: null, ambiguous: [] }
        const target = { missionID: "display_08", descriptor: slot }
        await native.ensureCarrier(target, () => true)
        const row = await native.create(target, () => true)
        slots.push({ ...slot, creation: "adopted", scheduleID: row.id })
        if (role === "principal") principalDueAt = row.nextDueAt
      }
      const current = await store.read("display_08")
      if (!current || "deletedAt" in current) throw new Error("Fixture armed document missing")
      await store.change(current.id, current.revision, () => true, value => {
        changes.play(value, "play_fixture", now, [])
        changes.synchronized(value, "play_fixture", slots.map(slot => ({ role: slot.role, slot: slot.slot, timeGeneration: 1,
          sessionID: slot.sessionID, scheduleID: slot.scheduleID!, highWater: 0, pendingWake: null, wakePreparing: null })))
        value.calendarOwner = { version: 1, installation: { ...artifacts, registrationFile: `${ctx.location.directory}/unused-fixture-registration.json` },
          profileSource: { profileID: "fixture", executionHost: "fixture", configYamlPath: `${ctx.location.directory}/unused-fixture.yaml` },
          placement: captureMissionCalendarPlacement(value.configuration.roots),
          operation: { requestID: "play_fixture", expectedRevision: current.revision, fingerprint: "0".repeat(64), action: "play", pending: false, startedAt: now },
          receipts: [], checks: [], slots, retired: [], auxiliaryReady: true, error: null }
      })
      return { count: 10, tombstone: "display_01", armed: "display_08", principalDueAt, principalID: slots.find(slot => slot.role === "principal")!.scheduleID }
    }))
    })).pipe(Effect.orDie)),
    scheduleList: production.scheduleList,
    scheduleRead: production.scheduleRead,
  }).pipe(Effect.orDie)
}) })
