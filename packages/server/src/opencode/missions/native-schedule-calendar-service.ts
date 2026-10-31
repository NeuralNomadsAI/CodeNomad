import path from "node:path"
import { Clock, Context, DateTime, Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import type { Plugin } from "@opencode/plugin/effect"
import { Schedule } from "@opencode/schema/schedule"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Location } from "@opencode/schema/location"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { assertSynchronousAuthorityGuard } from "../../missions/authority-synchronous"
import type { MissionCalendarOwnerSlot } from "../../missions/mission-calendar-owner-state"
import { missionCalendarOwnerSlotSchema } from "../../missions/mission-calendar-owner-state"
import { documentID } from "../../missions/launch-policy"
import type { MissionCalendarWhen } from "../../missions/mission-calendar-plan"
import type { MissionWake } from "../../missions/mission-document"
import { NATIVE_SCHEDULE_CARRIER_MODEL, NATIVE_SCHEDULE_CARRIER_TITLE } from "./native-schedule-carrier"
import { NATIVE_SCHEDULE_CARRIER_MARKER, NATIVE_SCHEDULE_CARRIER_SIGNAL } from "./native-schedule-carrier-binding"

type NativeEffect = Effect.Effect<unknown, unknown>
type Target = { missionID: string; descriptor: MissionCalendarOwnerSlot }
export type NativeScheduleCalendarTarget = Target
export type NativeScheduleCalendarInfo = { id: string; sessionID: string; name: string; when: MissionCalendarWhen;
  status: "active" | "paused" | "done"; nextDueAt: number | null; endsAt: number | null; runCount: number; remainingRuns: number | null; createdAt: number }
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
const scheduleTag = tag("@opencode/Schedule"), locationTag = tag("@opencode/Location"), configTag = tag("@opencode/Config")
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
  providerAvailable?: () => Effect.Effect<void, unknown>,
) {
  const graph = yield* Effect.context<never>()
  const required = (key: typeof scheduleTag) => {
    const found = Context.getOption(graph, key)
    if (Option.isNone(found)) throw new Error("Native calendar contract unavailable")
    return found.value
  }
  const schedules = Schema.decodeUnknownSync(schedulesShape)(required(scheduleTag))
  const location = Schema.decodeUnknownSync(Schema.toType(Schema.Struct(Location.Info.fields)))(required(locationTag))
  const config = required(configTag) as { entries(): NativeEffect }
  const sessions = required(sessionTag) as { remove(id: string): NativeEffect; active: NativeEffect }
  const database = required(databaseTag) as { db: { $client: SqlClient.SqlClient } }
  const lifecycle = required(lifecycleTag) as { isClosed(): boolean }
  if (!Predicate.isFunction(config.entries) || !Predicate.isFunction(sessions.remove) || !Effect.isEffect(sessions.active)
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
  const available = Effect.fnUntraced(function* () {
    if (!providerAvailable) throw new Error("Native calendar provider availability unqualified")
    const effect = providerAvailable()
    if (!Effect.isEffect(effect)) throw new Error("Native calendar provider availability unqualified")
    yield* effect
    assertCurrent()
  })
  const enabled = Effect.fnUntraced(function* () {
    assertCurrent()
    const entries = yield* config.entries()
    if (!Array.isArray(entries) || entries.length > 256) throw new Error("Native calendar configuration incomplete")
    const latest = [...entries].reverse().find(entry => entry?.type === "document" && entry.info?.experimental !== undefined)
    if (latest?.info.experimental?.schedules !== true) throw new Error("Native calendar schedules disabled")
    assertCurrent()
  })
  const carrier = Effect.fnUntraced(function* (target: Target) {
    yield* enabled()
    const session = yield* ctx.session.get({ sessionID: Session.ID.make(target.descriptor.sessionID) })
    if (session.id !== target.descriptor.sessionID || session.parentID || session.projectID !== location.project.id
      || session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID
      || canonicalAuthority(session.metadata?.[NATIVE_SCHEDULE_CARRIER_MARKER]) !== canonicalAuthority(marker(target))
      || session.model?.providerID !== NATIVE_SCHEDULE_CARRIER_MODEL.providerID || session.model.id !== NATIVE_SCHEDULE_CARRIER_MODEL.id)
      throw new Error("Native calendar carrier differs")
    const effect = schedules.enabled(session.id)
    if (!Effect.isEffect(effect) || (yield* effect) !== true) throw new Error("Native calendar schedules disabled")
    assertCurrent()
  })
  const decode = Schema.decodeUnknownEffect(Schema.toType(Schedule.Info))
  const project = (info: Schedule.Info): NativeScheduleCalendarInfo => {
    const time = (value: DateTime.Utc | undefined) => value === undefined ? null : DateTime.toEpochMillis(value)
    if (!info.sessionID || !info.name || info.action.type !== "prompt" || info.action.prompt !== NATIVE_SCHEDULE_CARRIER_SIGNAL
      || !Number.isSafeInteger(info.runCount) || info.runCount < 0) throw new Error("Native calendar Info differs")
    return { id: info.id, sessionID: info.sessionID, name: info.name, when: info.when as MissionCalendarWhen,
      status: info.status, nextDueAt: time(info.nextDueAt), endsAt: time(info.endsAt), runCount: info.runCount, remainingRuns: info.remainingRuns ?? null,
      createdAt: DateTime.toEpochMillis(info.time.created) }
  }
  const same = (value: NativeScheduleCalendarInfo, target: Target) => nativeScheduleCalendarMatches(value, target.descriptor)
  const get = Effect.fnUntraced(function* (target: Target, id: string) {
    yield* carrier(target)
    const value = yield* schedules.get(id).pipe(Effect.flatMap(decode), Effect.map(project), Effect.catch(error =>
      missing(error, "Schedule.NotFoundError") ? Effect.succeed(undefined) : Effect.fail(error)))
    if (value && (!same(value, target) || value.id !== id)) throw new Error("Native calendar mapping differs")
    return value
  })
  const mutate = (action: "pause" | "resume", input: Target, id: string, guard: () => true) => protect(input, target => Effect.gen(function* () {
    if (!(yield* get(target, id))) throw new Error("Native calendar missing")
    yield* carrier(target)
    if (action === "resume") yield* available()
    yield* carrier(target)
    const value = yield* Effect.suspend(() => { assertCurrent(); assertSynchronousAuthorityGuard(guard, "policy-unqualified"); return schedules[action](id) })
      .pipe(Effect.flatMap(decode), Effect.map(project))
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
      yield* available()
      const present = yield* ctx.session.get({ sessionID: Session.ID.make(target.descriptor.sessionID) }).pipe(Effect.catch(error =>
        missing(error, "Session.NotFoundError") ? Effect.succeed(undefined) : Effect.fail(error)))
      if (!present) { yield* enabled(); yield* Effect.suspend(() => {
        assertCurrent(); assertSynchronousAuthorityGuard(guard, "policy-unqualified")
        return ctx.session.create({ id: Session.ID.make(target.descriptor.sessionID), title: NATIVE_SCHEDULE_CARRIER_TITLE,
          location: { directory: location.directory }, agent: Agent.ID.make(carrierAgent),
          model: Model.Ref.make({ providerID: Provider.ID.make(NATIVE_SCHEDULE_CARRIER_MODEL.providerID), id: Model.ID.make(NATIVE_SCHEDULE_CARRIER_MODEL.id) }),
          metadata: { [NATIVE_SCHEDULE_CARRIER_MARKER]: marker(target) } })
      }) }
      yield* carrier(target)
    }), guard),
    list: (input, guard) => protect(input, target => Effect.gen(function* () {
      yield* carrier(target)
      yield* available()
      const values = yield* schedules.list({ sessionID: target.descriptor.sessionID }).pipe(Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(Schema.toType(Schedule.Info)).check(Schema.isMaxLength(16)))))
      const result = values.map(project)
      if (result.some(info => info.sessionID !== target.descriptor.sessionID)) throw new Error("Native calendar list is foreign")
      canonicalAuthority(result, 1024 * 1024)
      assertCurrent(); return result
    }), guard),
    get: (input, id, guard) => protect(input, target => get(target, id), guard),
    create: (input, guard) => protect(input, target => Effect.gen(function* () {
      yield* carrier(target)
      yield* available()
      yield* carrier(target)
      if (target.descriptor.anchorAt === undefined) throw new Error("Native calendar creation anchor unavailable")
      const anchor = target.descriptor.anchorAt, real = yield* Clock.Clock
      const creationClock: Clock.Clock = { currentTimeMillis: Effect.succeed(anchor), currentTimeMillisUnsafe: () => anchor,
        currentTimeNanos: Effect.succeed(BigInt(anchor) * 1_000_000n), currentTimeNanosUnsafe: () => BigInt(anchor) * 1_000_000n,
        monotonicTimeNanos: real.monotonicTimeNanos, monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(), sleep: duration => real.sleep(duration) }
      const input = Schema.decodeUnknownSync(Schema.toType(Schedule.CreateInput))({ sessionID: target.descriptor.sessionID, name: target.descriptor.name,
        when: target.descriptor.when, action: { type: "prompt", prompt: NATIVE_SCHEDULE_CARRIER_SIGNAL },
        ...(target.descriptor.endsAt === null ? {} : { ends: { at: new Date(target.descriptor.endsAt).toISOString() } }) })
      const value = yield* Effect.suspend(() => { assertCurrent(); assertSynchronousAuthorityGuard(guard, "policy-unqualified");
        return schedules.create(input).pipe(Effect.provideService(Clock.Clock, creationClock)) })
        .pipe(Effect.flatMap(decode), Effect.map(project))
      if (!same(value, target)) throw new Error("Native created calendar differs")
      return value
    }), guard),
    pause: (target, id, guard) => mutate("pause", target, id, guard), resume: (target, id, guard) => mutate("resume", target, id, guard),
    remove: (input, id, guard) => protect(input, target => Effect.gen(function* () {
      if (!(yield* get(target, id))) return
      yield* carrier(target)
      yield* Effect.suspend(() => { assertCurrent(); assertSynchronousAuthorityGuard(guard, "policy-unqualified"); return schedules.remove(id) }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Void)))
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
      if (!info || info.runCount < wake.run) return false
      const value = yield* query("SELECT data FROM session_message WHERE id=? AND session_id=? AND type='user' AND length(CAST(data AS BLOB))<=262144",
        [wake.messageID, target.descriptor.sessionID])
      if (value.length !== 1 || typeof value[0].data !== "string") return false
      const data = JSON.parse(value[0].data)
      const message = Schema.decodeUnknownSync(SessionMessage.User)({ ...data, id: wake.messageID, type: "user" })
      const metadata = message.metadata?.schedule as { id?: unknown; run?: unknown; dueAt?: unknown; late?: unknown } | undefined
      return metadata?.id === wake.scheduleID && metadata.run === wake.run && metadata.dueAt === wake.dueAt
        && typeof metadata.late === "boolean" && message.text === NATIVE_SCHEDULE_CARRIER_SIGNAL
    }), guard),
  } satisfies NativeScheduleCalendarService
})
