import path from "node:path"
import { Clock, Context, DateTime, Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import type { Plugin } from "@opencode/plugin/effect"
import { Automation } from "@opencode/schema/automation"
import { Session } from "@opencode/schema/session"
import { Location } from "@opencode/schema/location"
import { Agent } from "@opencode/schema/agent"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { assertSynchronousAuthorityGuard } from "../../missions/authority-synchronous"
import type { MissionCalendarOwnerSlot } from "../../missions/mission-calendar-owner-state"
import { missionCalendarOwnerSlotSchema } from "../../missions/mission-calendar-owner-state"
import { documentID } from "../../missions/launch-policy"
import type { MissionCalendarWhen } from "../../missions/mission-calendar-plan"
import type { MissionWake } from "../../missions/mission-document"
import { isAllowedScheduleCarrierModel, NATIVE_SCHEDULE_CARRIER_TITLE } from "./native-schedule-carrier"
import { NATIVE_SCHEDULE_CARRIER_MARKER, NATIVE_SCHEDULE_CARRIER_SIGNAL } from "./native-schedule-carrier-binding"
import { readNativeScheduleFlag } from "./native-schedule-flag"
import { matchMissionAutomation, missionAutomationID, missionAutomationService, missionAutomationTrigger, missionCodeWake, missionCodeWakeRunning,
  readMissionAutomation, MISSION_WAKE_CODE, MISSION_WAKE_PERMISSIONS,
  type MissionAutomationInfo } from "./native-mission-automation"

type NativeEffect = Effect.Effect<unknown, unknown>
type Target = { missionID: string; descriptor: MissionCalendarOwnerSlot }
export type NativeScheduleCalendarTarget = Target
export type NativeScheduleCalendarInfo = { id: string; sessionID: string; name: string; when: MissionCalendarWhen;
  status: "active" | "paused" | "done"; nextDueAt: number | null; endsAt: number | null; runCount: number; remainingRuns: number | null; createdAt: number
  /** Runs the Code Mode wake program rather than prompting its carrier. */
  code: boolean }
export interface NativeScheduleCalendarService {
  readonly directory: string
  assertCurrent(): true
  ensureCarrier(target: Target, current: () => true): Promise<void>
  list(target: Target, current: () => true): Promise<NativeScheduleCalendarInfo[]>
  get(target: Target, id: string, current: () => true): Promise<NativeScheduleCalendarInfo | undefined>
  create(target: Target, current: () => true): Promise<NativeScheduleCalendarInfo>
  pause(target: Target, id: string, current: () => true): Promise<NativeScheduleCalendarInfo>
  resume(target: Target, id: string, current: () => true): Promise<NativeScheduleCalendarInfo>
  remove(target: Target, id: string, current: () => true): Promise<void>
  removeCarrier(target: Target, current: () => true): Promise<void>
  carrierQuiet(target: Target, current: () => true): Promise<boolean>
  wakeAcknowledged(target: Target, wake: MissionWake, current: () => true): Promise<boolean>
}
export const nativeScheduleCalendarMatches = (info: NativeScheduleCalendarInfo, slot: MissionCalendarOwnerSlot) =>
  info.sessionID === slot.sessionID && info.name === slot.name && canonicalAuthority(info.when) === canonicalAuthority(slot.when)
  && info.endsAt === slot.endsAt && info.remainingRuns === null && (slot.anchorAt === undefined || info.createdAt === slot.anchorAt)
const tag = (id: string) => Context.Service<never, unknown>(id)
const locationTag = tag("@opencode/Location")
const sessionTag = tag("@opencode/Session"), databaseTag = tag("@opencode/storage/Database"), lifecycleTag = tag("@opencode/LocationLifecycle")
const method = Schema.declare<(...args: any[]) => NativeEffect>((value): value is (...args: any[]) => NativeEffect => Predicate.isFunction(value))
const schedulesShape = Schema.Struct({ create: method, list: method, get: method, pause: method, resume: method, remove: method, enabled: method })
const rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
const marker = (target: Target) => ({ missionID: target.missionID, timeGeneration: target.descriptor.timeGeneration,
  role: target.descriptor.role, slot: target.descriptor.slot })
const missing = (error: unknown, name: string) => !!error && typeof error === "object" && "_tag" in error && error._tag === name

/** Acquire inside the current RPC graph. Promise effects are joined by the
 * supplied invocation runner; scope release retires every exported operation. */
export const acquireNativeScheduleCalendarService = Effect.fn("missions.acquireScheduleCalendar")(function* (
  ctx: Plugin.Context, carrierAgent: string, current: () => true,
  invocationRun?: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>,
) {
  const graph = yield* Effect.context<never>()
  const required = (key: typeof missionAutomationService) => {
    const found = Context.getOption(graph, key)
    if (Option.isNone(found)) throw new Error("Native calendar contract unavailable")
    return found.value
  }
  const schedules = Schema.decodeUnknownSync(schedulesShape)(required(missionAutomationService))
  const location = Schema.decodeUnknownSync(Schema.toType(Schema.Struct(Location.Info.fields)))(required(locationTag))
  const sessions = required(sessionTag) as { remove(id: string): NativeEffect; active: NativeEffect }
  const database = required(databaseTag) as { db: { $client: SqlClient.SqlClient } }
  const lifecycle = required(lifecycleTag) as { isClosed(): boolean }
  if (!Predicate.isFunction(sessions.remove) || !Effect.isEffect(sessions.active)
    || !Predicate.isFunction(database.db?.$client?.unsafe) || !Predicate.isFunction(lifecycle.isClosed) || !carrierAgent) throw new Error("Native calendar cleanup/config contract unavailable")
  let active = true
  yield* Effect.addFinalizer(() => Effect.sync(() => { active = false }))
  const assertCurrent = (): true => {
    assertSynchronousAuthorityGuard(current, "policy-unqualified")
    if (!active || lifecycle.isClosed() !== false || location.directory !== ctx.location.directory || location.workspaceID !== ctx.location.workspaceID
      || location.project.id !== ctx.location.project.id || location.project.canonical !== ctx.location.project.canonical)
      throw new Error("Native calendar Location retired")
    return true
  }
  const run = invocationRun ?? (<A>(effect: Effect.Effect<A, unknown>) => Effect.runPromiseWith(graph)(effect))
  const invoke = <A>(make: () => Effect.Effect<A, unknown>, guard: () => true) => run(Effect.suspend(() => {
    assertCurrent(); assertSynchronousAuthorityGuard(guard, "policy-unqualified")
    return make()
  }))
  const protect = async <A>(input: Target, use: (snapshot: Target) => Effect.Effect<A, unknown>, guard: () => true): Promise<A> => {
    const snapshot = { missionID: documentID.parse(input.missionID), descriptor: missionCalendarOwnerSlotSchema.parse(structuredClone(input.descriptor)) }
    return invoke(() => use(snapshot), guard)
  }
  const enabled = Effect.fnUntraced(function* () {
    assertCurrent()
    if (!(yield* readNativeScheduleFlag(ctx)).enabled) throw new Error("Native calendar schedules disabled")
    assertCurrent()
  })
  const schedulesEnabled = Effect.fnUntraced(function* () {
    const effect = schedules.enabled(location.directory)
    if (!Effect.isEffect(effect) || (yield* effect) !== true) throw new Error("Native calendar schedules disabled")
  })
  // Native has no joint snapshot. Read both flags, the carrier and any row
  // together after earlier awaits; validate and dispatch on that result.
  const readCarrier = (target: Target) => Effect.suspend(() => ctx.session.get({ sessionID: Session.ID.make(target.descriptor.sessionID) }))
  const validateCarrier = (target: Target, session: Effect.Success<ReturnType<typeof readCarrier>>) => {
    if (session.id !== target.descriptor.sessionID || session.parentID || session.projectID !== location.project.id
      || session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID
      || canonicalAuthority(session.metadata?.[NATIVE_SCHEDULE_CARRIER_MARKER]) !== canonicalAuthority(marker(target))
      || !isAllowedScheduleCarrierModel(session.model))
      throw new Error("Native calendar carrier differs")
    assertCurrent()
    return session
  }
  const observe = <A>(target: Target, row: Effect.Effect<A, unknown>) => Effect.all(
    [enabled(), schedulesEnabled(), readCarrier(target), row], { concurrency: "unbounded" }).pipe(Effect.map(([, , session, value]) => {
      validateCarrier(target, session)
      return { session, value }
    }))
  const carrier = (target: Target) => observe(target, Effect.void).pipe(Effect.map(result => result.session))
  const wakeRules = () => MISSION_WAKE_PERMISSIONS.map(rule => ({ ...rule }))
  // A carrier made before code wakes has no rules of its own; it receives exactly these.
  const codeCarrier = Effect.fnUntraced(function* (target: Target, guard: () => true) {
    const session = yield* carrier(target)
    const rules = session.permissions
    if (canonicalAuthority(rules ?? []) === canonicalAuthority(MISSION_WAKE_PERMISSIONS)) return session
    if (rules?.length) throw new Error("Native calendar carrier permissions differ")
    const sessionID = Session.ID.make(target.descriptor.sessionID)
    yield* Effect.suspend(() => { assertCurrent(); assertSynchronousAuthorityGuard(guard, "policy-unqualified")
      return ctx.session.update({ sessionID, permissions: wakeRules() }) })
    const updated = yield* carrier(target)
    if (canonicalAuthority(updated.permissions ?? []) !== canonicalAuthority(MISSION_WAKE_PERMISSIONS))
      throw new Error("Native calendar carrier permissions unconfirmed")
    return updated
  })
  const project = (info: MissionAutomationInfo, target: Target): NativeScheduleCalendarInfo => {
    const time = (value: DateTime.Utc | undefined) => value === undefined ? null : DateTime.toEpochMillis(value)
    const slot = target.descriptor
    const code = missionCodeWake(info)
    if (!matchMissionAutomation(info, slot, { directory: location.directory, projectID: location.project.id }, NATIVE_SCHEDULE_CARRIER_SIGNAL))
      throw new Error("Native calendar Info differs")
    const id = slot.scheduleID && missionAutomationID(slot.scheduleID) === info.id ? slot.scheduleID : info.id
    return { id, sessionID: slot.sessionID, name: info.name, when: slot.when,
      status: info.status, nextDueAt: time(info.nextDueAt), endsAt: time(info.expires), runCount: info.runCount, remainingRuns: null,
      createdAt: DateTime.toEpochMillis(info.time.created), code }
  }
  const same = (value: NativeScheduleCalendarInfo, target: Target) => nativeScheduleCalendarMatches(value, target.descriptor)
  const get = Effect.fnUntraced(function* (target: Target, id: string) {
    const nativeID = missionAutomationID(id)
    const row = Effect.suspend(() => schedules.get(nativeID)).pipe(Effect.flatMap(readMissionAutomation), Effect.catch(error =>
      missing(error, "Automation.NotFoundError") ? Effect.succeed(undefined) : Effect.fail(error)))
    const { value: info } = yield* observe(target, row)
    if (!info) return undefined
    if (info.id !== nativeID) throw new Error("Native calendar mapping differs")
    const value = { ...project(info, target), id }
    if (!same(value, target)) throw new Error("Native calendar mapping differs")
    return value
  })
  const mutate = (action: "pause" | "resume", input: Target, id: string, guard: () => true) => protect(input, target => Effect.gen(function* () {
    const existing = yield* get(target, id)
    if (!existing) throw new Error("Native calendar missing")
    if (action === "resume" && !existing.code) throw new Error("schedule-calendar-requires-code")
    const nativeID = missionAutomationID(id)
    const value = yield* Effect.suspend(() => {
      assertCurrent()
      assertSynchronousAuthorityGuard(guard, "policy-unqualified")
      return schedules[action](nativeID)
    })
      .pipe(Effect.flatMap(readMissionAutomation), Effect.map(info => {
        if (info.id !== nativeID) throw new Error("Native calendar mutation differs")
        if (action === "resume" && !missionCodeWake(info)) throw new Error("schedule-calendar-requires-code")
        return { ...project(info, target), id }
      }))
    if (!same(value, target) || value.id !== id) throw new Error("Native calendar mutation differs")
    return value
  }), guard)
  const query = (sql: string, parameters: readonly unknown[]) => database.db.$client.unsafe(sql, parameters).withoutTransform.pipe(Effect.flatMap(Schema.decodeUnknownEffect(rows)))
  const quiet = Effect.fnUntraced(function* (target: Target) {
    yield* enabled()
    if (!(yield* query("SELECT id FROM session_v2 WHERE id=?", [target.descriptor.sessionID])).length) return true
    yield* carrier(target)
    const running = yield* sessions.active
    if (!(running instanceof Set) || running.size > 4096) throw new Error("Native carrier active coverage incomplete")
    if (running.has(target.descriptor.sessionID)) return false
    const state = yield* query(`SELECT time_suspended,EXISTS(SELECT 1 FROM session_v2 WHERE parent_id=?) AS children,
      EXISTS(SELECT 1 FROM session_inbox WHERE session_id=?) AS inbox FROM session_v2 WHERE id=?`,
    [target.descriptor.sessionID, target.descriptor.sessionID, target.descriptor.sessionID])
    return state.length === 1 && state[0].time_suspended == null && state[0].children === 0 && state[0].inbox === 0
  })
  return {
    assertCurrent, directory: location.directory,
    ensureCarrier: (input, guard) => protect(input, target => Effect.gen(function* () {
      yield* enabled()
      const present = yield* ctx.session.get({ sessionID: Session.ID.make(target.descriptor.sessionID) }).pipe(Effect.catch(error =>
        missing(error, "Session.NotFoundError") ? Effect.succeed(undefined) : Effect.fail(error)))
      if (!present) { yield* enabled(); yield* Effect.suspend(() => {
        assertCurrent(); assertSynchronousAuthorityGuard(guard, "policy-unqualified")
        return ctx.session.create({ id: Session.ID.make(target.descriptor.sessionID), title: NATIVE_SCHEDULE_CARRIER_TITLE,
          location: { directory: location.directory }, agent: Agent.ID.make(carrierAgent),
          metadata: { [NATIVE_SCHEDULE_CARRIER_MARKER]: marker(target) }, permissions: wakeRules() })
      }) }
      yield* carrier(target)
    }), guard),
    list: (input, guard) => protect(input, target => Effect.gen(function* () {
      const { value: values } = yield* observe(target, Effect.suspend(() => schedules.list({ sessionID: target.descriptor.sessionID })).pipe(Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(Schema.toType(Automation.Info)).check(Schema.isMaxLength(16))))))
      const result = values.map(info => project(info, target))
      if (result.some(info => info.sessionID !== target.descriptor.sessionID)) throw new Error("Native calendar list is foreign")
      canonicalAuthority(result, 1024 * 1024)
      assertCurrent(); return result
    }), guard),
    get: (input, id, guard) => protect(input, target => get(target, id), guard),
    create: (input, guard) => protect(input, target => Effect.gen(function* () {
      if (target.descriptor.anchorAt === undefined) throw new Error("Native calendar creation anchor unavailable")
      const anchor = target.descriptor.anchorAt, real = yield* Clock.Clock
      const creationClock: Clock.Clock = { currentTimeMillis: Effect.succeed(anchor), currentTimeMillisUnsafe: () => anchor,
        currentTimeNanos: Effect.succeed(BigInt(anchor) * 1_000_000n), currentTimeNanosUnsafe: () => BigInt(anchor) * 1_000_000n,
        monotonicTimeNanos: real.monotonicTimeNanos, monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(), sleep: duration => real.sleep(duration) }
      const input = Schema.decodeUnknownSync(Schema.toType(Automation.CreateInput))({ sessionID: target.descriptor.sessionID, name: target.descriptor.name,
        trigger: missionAutomationTrigger(target.descriptor), action: { type: "code", code: MISSION_WAKE_CODE },
        ...(target.descriptor.endsAt === null ? {} : { expires: new Date(target.descriptor.endsAt).toISOString() }) })
      yield* codeCarrier(target, guard)
      const value = yield* Effect.suspend(() => { assertCurrent(); assertSynchronousAuthorityGuard(guard, "policy-unqualified");
        return schedules.create(input).pipe(Effect.provideService(Clock.Clock, creationClock)) })
        .pipe(Effect.flatMap(readMissionAutomation), Effect.map(info => project(info, target)))
      if (!value.code || !same(value, target)) throw new Error("Native created calendar differs")
      return value
    }), guard),
    pause: (target, id, guard) => mutate("pause", target, id, guard), resume: (target, id, guard) => mutate("resume", target, id, guard),
    remove: (input, id, guard) => protect(input, target => Effect.gen(function* () {
      if (!(yield* get(target, id))) return
      yield* Effect.suspend(() => { assertCurrent(); assertSynchronousAuthorityGuard(guard, "policy-unqualified"); return schedules.remove(missionAutomationID(id)) }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Void)))
      if (yield* get(target, id)) throw new Error("Native calendar removal unconfirmed")
    }), guard),
    removeCarrier: (input, guard) => protect(input, target => Effect.gen(function* () {
      if (!(yield* quiet(target))) throw new Error("Native carrier cleanup coverage incomplete")
      const exists = yield* query("SELECT id FROM session_v2 WHERE id=?", [target.descriptor.sessionID])
      if (!exists.length) return
      yield* carrier(target)
      yield* Effect.suspend(() => { assertCurrent(); assertSynchronousAuthorityGuard(guard, "policy-unqualified"); return sessions.remove(target.descriptor.sessionID) }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Void)))
      if ((yield* query("SELECT id FROM session_v2 WHERE id=?", [target.descriptor.sessionID])).length) throw new Error("Native carrier removal unconfirmed")
    }), guard),
    carrierQuiet: (input, guard) => protect(input, target => quiet(target), guard),
    wakeAcknowledged: (input, wake, guard) => protect(input, target => Effect.gen(function* () {
      const info = yield* get(target, wake.scheduleID)
      if (!info) return false
      // An active row retries an uncounted run. A paused or done one still counts a program
      // in flight, so only a program that ended uncounted leaves the run unconsumed for good.
      if (!info.code) throw new Error("schedule-calendar-requires-code")
      return info.runCount >= wake.run
        || info.status !== "active" && info.runCount === wake.run - 1 && !missionCodeWakeRunning(wake.scheduleID, wake.run)
    }), guard),
  } satisfies NativeScheduleCalendarService
})
