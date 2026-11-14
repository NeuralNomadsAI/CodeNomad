// Explicit isolated qualification package; never installed by product wiring.
import { Plugin, Rpc } from "@opencode/plugin/effect"
import { Clock, Context, Effect, Cause, Option } from "effect"
import { Session } from "@opencode/schema/session"
import { appendFileSync } from "node:fs"
import { stableToken } from "../../missions/receipt-identity"
import { nextMissionCalendarCron } from "../../missions/mission-calendar-plan"
import { MISSION_SCHEDULE_CARRIER_SESSION_PREFIX } from "../../missions/mission-schedule-carrier-identity"
import { nativeInvocation } from "./native-invocation"
import { acquireNativeScheduleCalendarService } from "./native-schedule-calendar-service"
import type { NativeScheduleCalendarTarget } from "./native-schedule-calendar-service"
import { registerNativeScheduleProvider, assertNativeScheduleProviderAvailable } from "./native-schedule-provider-registration"
import type { NativeScheduleArtifacts } from "./native-schedule-installation"
import { nativeScheduleCarrierHooks } from "./native-schedule-carrier"

const method = { input: { type: "object" }, output: { type: "object" } } as const
const definition = Rpc.define({ id: "codenomad.calendar-owner-qualification", methods: { methods: method, dst: method, off: method }, events: {} })
export default Plugin.define({ id: "codenomad.calendar-owner-qualification", effect: ctx => Effect.gen(function* () {
  const artifacts = ctx.options as NativeScheduleArtifacts & { logFile: string }, invocation = nativeInvocation(), hooks = nativeScheduleCarrierHooks(() => false)
  const trace = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.tapCause(cause => Effect.sync(() => appendFileSync(artifacts.logFile, Cause.pretty(cause) + "\n"))))
  yield* registerNativeScheduleProvider(ctx, artifacts)
  yield* ctx.aisdk.hook("language", event => Effect.sync(() => hooks.language(event)))
  const current = () => true as const
  const acquire = () => acquireNativeScheduleCalendarService(ctx, "build", current, effect => invocation.check(run => run(effect)),
    () => assertNativeScheduleProviderAvailable(ctx, artifacts))
  const target = (name: string, when: NativeScheduleCalendarTarget["descriptor"]["when"], slot = 0): NativeScheduleCalendarTarget => ({ missionID: "native_calendar",
    descriptor: { role: "principal", slot, timeGeneration: 1, sessionID: `${MISSION_SCHEDULE_CARRIER_SESSION_PREFIX}${stableToken(`${ctx.location.directory}\0${name}`, 40)}`,
      name: `cm_${name}`, when, endsAt: null, anchorAt: Date.now(), creation: "attempted", scheduleID: null, ambiguous: [] } })
  yield* ctx.rpc.register(definition, {
    methods: () => trace(Effect.scoped(invocation.capture(Effect.gen(function* () {
      const native = yield* acquire(), selected = target("methods", { type: "every", every: "900000 millis", tz: "UTC" })
      const found = yield* Effect.serviceOption(Context.Service<never, unknown>("@opencode/Session"))
      if (Option.isNone(found)) throw new Error("native Session qualification unavailable")
      const sessions = found.value as { create(input: unknown): Effect.Effect<Session.Info, unknown>; remove(id: string): Effect.Effect<void, unknown> }
      return yield* Effect.promise(async () => {
        await native.ensureCarrier(selected, current)
        const created = await native.create(selected, current)
        const list = await native.list(selected, current)
        if (list.length !== 1 || list[0].id !== created.id) throw new Error("native session-filtered list differs")
        if ((await native.get(selected, created.id, current))?.id !== created.id) throw new Error("native get differs")
        if ((await native.pause(selected, created.id, current)).status !== "paused") throw new Error("native pause differs")
        if ((await native.resume(selected, created.id, current)).status !== "active") throw new Error("native resume differs")
        await native.remove(selected, created.id, current)
        if (await native.get(selected, created.id, current)) throw new Error("native remove differs")
        if (!await native.carrierQuiet(selected, current)) throw new Error("unused native carrier is not quiet")
        await native.removeCarrier(selected, current)
        const anchored = []
        for (const type of ["every", "in"] as const) {
          const item = target(`delayed_${type}`, type === "every" ? { type, every: "900000 millis", tz: "UTC" } : { type, in: "900000 millis", tz: "UTC" })
          const anchor = item.descriptor.anchorAt!, expected = anchor + 900_000
          item.descriptor.endsAt = expected
          await native.ensureCarrier(item, current)
          await new Promise(resolve => setTimeout(resolve, 50))
          const before = Date.now(), value = await native.create(item, current)
          const restored = await invocation.check(run => run(Clock.currentTimeMillis))
          if (before <= anchor || value.createdAt !== anchor || value.nextDueAt !== expected || value.endsAt !== expected
            || restored < before || restored > Date.now()) throw new Error("native delayed creation origin differs")
          anchored.push({ type, anchor, actualCreateAt: before, createdAt: value.createdAt, dueAt: value.nextDueAt, endsAt: value.endsAt, restored })
          await native.pause(item, value.id, current)
          await native.remove(item, value.id, current)
          await native.removeCarrier(item, current)
          if (type === "every") {
            const replacement = target("phase_every", item.descriptor.when)
            replacement.descriptor.anchorAt = value.nextDueAt! - 900_000
            replacement.descriptor.endsAt = value.endsAt
            await native.ensureCarrier(replacement, current)
            await new Promise(resolve => setTimeout(resolve, 25))
            const adopted = await native.create(replacement, current)
            const paused = await native.pause(replacement, adopted.id, current), resumed = await native.resume(replacement, adopted.id, current)
            if (adopted.nextDueAt !== value.nextDueAt || paused.status !== "paused" || resumed.status !== "active"
              || resumed.nextDueAt !== value.nextDueAt) throw new Error("native replacement phase or paused identity differs")
            anchored.push({ type: "every-phase", anchor: replacement.descriptor.anchorAt, actualCreateAt: Date.now(), createdAt: adopted.createdAt,
              dueAt: adopted.nextDueAt, endsAt: adopted.endsAt, restored: await invocation.check(run => run(Clock.currentTimeMillis)) })
            await native.pause(replacement, adopted.id, current)
            await native.remove(replacement, adopted.id, current)
            await native.removeCarrier(replacement, current)
          }
        }
        const parent = target("children", { type: "every", every: "900000 millis", tz: "UTC" })
        await native.ensureCarrier(parent, current)
        const child = await invocation.check(run => run(sessions.create({ id: Session.ID.make(`${parent.descriptor.sessionID}_child`),
          parentID: parent.descriptor.sessionID, title: "Owned qualification child", agent: "build" })))
        if (child.parentID !== parent.descriptor.sessionID) throw new Error("native child placement differs")
        let refused = false
        try { await native.removeCarrier(parent, current) } catch { refused = true }
        if (!refused) throw new Error("native recursive child deletion was not fenced")
        await invocation.check(run => run(sessions.remove(child.id)))
        await native.removeCarrier(parent, current)
        return { qualified: ["create", "list(sessionID)", "get", "pause", "resume", "remove", "enabled", "Session.remove", "quiet SQL"],
          protectedActualChild: true, anchored, sessionID: selected.descriptor.sessionID, scheduleID: created.id }
      })
    })))),
    off: () => trace(Effect.scoped(invocation.capture(Effect.gen(function* () {
      const native = yield* acquire()
      return yield* Effect.promise(async () => {
        try { await native.ensureCarrier(target("flag_off", { type: "every", every: "900000 millis", tz: "UTC" }), current) }
        catch (error) { if ((error as Error).message.includes("schedules disabled")) return { refused: true }; throw error }
        throw new Error("disabled native flag admitted a carrier")
      })
    })))),
    dst: raw => trace(Effect.scoped(Effect.gen(function* () {
      const input = raw as { expression: string; now: number; expected: number; slot: number }
      return yield* invocation.capture(Effect.gen(function* () {
        const native = yield* acquire(), selected = target(`dst_${input.slot}`, { type: "cron", cron: input.expression, tz: "America/New_York" }, input.slot)
        selected.descriptor.anchorAt = input.now
        return yield* Effect.promise(async () => {
          await native.ensureCarrier(selected, current)
          const created = await native.create(selected, current)
          const preview = nextMissionCalendarCron(input.expression, "America/New_York", input.now)
          if (created.nextDueAt !== input.expected || preview !== created.nextDueAt) throw new Error("native nextCron oracle differs")
          await native.pause(selected, created.id, current)
          await native.remove(selected, created.id, current)
          for (let pass = 0; pass < 100 && !await native.carrierQuiet(selected, current); pass++) await new Promise(resolve => setTimeout(resolve, 10))
          await native.removeCarrier(selected, current)
          return { native: created.nextDueAt, preview, controlledClock: input.now }
        })
      }))
    }))),
  }).pipe(Effect.orDie)
}) })
