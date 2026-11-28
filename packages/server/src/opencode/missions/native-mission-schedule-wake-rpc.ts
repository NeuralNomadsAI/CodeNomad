import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { z } from "zod"
import type { MissionDocument, MissionWake } from "../../missions/mission-document"
import { missionDocumentChanges } from "../../missions/mission-document-state"
import type { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { assertMissionCalendarPlacement } from "../../missions/mission-calendar-placement"
import { nativeInvocation } from "./native-invocation"
import { acquireNativeMissionScheduleOwner } from "./native-mission-schedule-owner"
import { acquireNativeScheduledPassageRuntime, type NativeScheduledPassageRuntime } from "./native-scheduled-passage-runtime"
import { readNativeScheduleAuxiliaryWakeBinding } from "./native-schedule-owner-bindings"
import { assertNativeScheduleCarrierArtifacts, readNativeScheduleCarrierOwnership, readNativeScheduleCarrierBinding,
  nativeScheduleClaimKey, closeNativeScheduleCarrierClaimLocked, type NativeScheduleCarrierBinding } from "./native-schedule-carrier-binding"
import { nativeScheduleIncarnationGuard, sameNativeScheduleIncarnation } from "./native-schedule-transport-identity"
import { nativeScheduleWakeKey, assertNativeScheduleWake, type NativeScheduleWake, type NativeScheduleTransportReply, type NativeSchedulePreflight } from "./native-schedule-transport-contract"
import { assertNativeSchedulePreflight, nativeSchedulePreflight } from "./native-mission-schedule-preflight"
import { parseNativeMissionScheduleClaim } from "./native-mission-schedule-wake-dispatch"
import { nativeScheduleClaimAbandoned, receivingNativeScheduleWake } from "./native-mission-schedule-wake-flight"
import type { NativeScheduleCalendarOwner } from "./native-schedule-owner"
import type { NativeScheduleCalendarService } from "./native-schedule-calendar-service"
import { missionCodeWakeProof } from "./native-mission-automation"
import { admitNativeMissionScheduleCodeWake } from "./native-mission-schedule-code-admission"
import { compactNativeMissionDocumentDeletion } from "./native-mission-schedule-deletion"

const text = z.string().min(1).max(4096)
const inputSchema = z.object({ registrationFile: text, incarnation: z.object({ id: text, pid: z.number().int().positive(), url: text, version: text.optional() }).strict(),
  wake: z.object({ missionID: text, generation: z.number().int().positive(), scheduleID: text, run: z.number().int().positive(), sessionID: text, messageID: text }).strict(),
  preflight: z.object({ cutoff: z.number().int().nonnegative(), issuedAt: z.number().int().nonnegative(), signature: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional() }).strict()
type Input = z.infer<typeof inputSchema>
type Entry = { current(): true; signal: AbortSignal; consumed?(): void }
export type NativeMissionScheduleWakePorts = { store: NativeMissionDocumentStore; owner: Pick<NativeScheduleCalendarOwner, "adoptAuxiliary" | "reconcile">;
  runtime: Pick<NativeScheduledPassageRuntime, "preflight" | "wake" | "reconcile">;
  read(): Promise<{ binding: NativeScheduleCarrierBinding; wake: MissionWake }>;
  claim(): Promise<ReturnType<typeof parseNativeMissionScheduleClaim>>;
  close(locked: NativeMissionDocumentStore): Promise<boolean>;
  compact?(): Promise<void> }

const nonCodeReply = (wake: NativeScheduleWake): NativeScheduleTransportReply =>
  ({ key: nativeScheduleWakeKey(wake), state: "rejected", reason: "schedule-calendar-requires-code" })
const refuseNonCode = (wake: NativeScheduleWake, error: unknown): NativeScheduleTransportReply => {
  if (!(error instanceof Error) || error.message !== "schedule-calendar-requires-code") throw error
  return nonCodeReply(wake)
}

/** Orchestration over real document/owner/passage ports. An auxiliary consumes
 * and releases its own claim before any cleanup or pending-business observation. */
export function receiveNativeMissionScheduleWake(mode: "wake" | "status", input: Input, entry: Entry,
  ports: NativeMissionScheduleWakePorts): Promise<NativeScheduleTransportReply> {
  // Status proves abandonment only for receivers that ended; register this one first.
  const work = mode === "wake" ? receivingNativeScheduleWake(input.wake, () => receive(mode, input, entry, ports)) : receive(mode, input, entry, ports)
  return work.catch(error => refuseNonCode(input.wake, error))
}

async function receive(mode: "wake" | "status", input: Input, entry: Entry,
  ports: NativeMissionScheduleWakePorts): Promise<NativeScheduleTransportReply> {
  const wake = input.wake, key = nativeScheduleWakeKey(wake), reply = (state: NativeScheduleTransportReply["state"]) => ({ key, state })
  entry.current(); entry.signal.throwIfAborted()
  const claim = await ports.claim()
  const { binding, wake: original } = await ports.read(), calendar = binding.calendar
  if (calendar.highWater >= wake.run) return reply("applied")
  const claimed = claim?.key === key && sameNativeScheduleIncarnation(claim.incarnation, input.incarnation)
  if (mode === "status") {
    const abandoned = !!claim && nativeScheduleClaimAbandoned(claim, wake, input.incarnation)
    const preflight = calendar.role === "reconciliation"
      ? { messagePresent: true, ready: wake.run === calendar.highWater + 1, cutoff: Date.now() }
      : await ports.runtime.preflight({ ...entry, missionID: wake.missionID, wake })
    entry.current()
    return { ...reply(claimed ? "pending" : "unknown"), messagePresent: preflight.messagePresent, ready: preflight.ready,
      ...(abandoned ? { abandoned: true } : {}),
      ...(preflight.messagePresent && preflight.ready ? { preflight: nativeSchedulePreflight(wake, input.incarnation.id, preflight.cutoff) } : {}) }
  }
  if (!claimed) return reply("unknown")
  const cutoff = assertNativeSchedulePreflight(input.preflight, wake, input.incarnation.id)
  if (calendar.role === "reconciliation") {
    if (!binding.document.calendars.some(item => item.scheduleID === calendar.scheduleID)) await ports.owner.adoptAuxiliary(wake)
    const consumed = await ports.store.withExclusion(async locked => {
      entry.current(); entry.signal.throwIfAborted()
      const doc = await locked.read(wake.missionID)
      if (!doc || "deletedAt" in doc) return false
      const current = doc.calendars.find(item => item.role === "reconciliation" && item.scheduleID === wake.scheduleID && item.sessionID === wake.sessionID
        && item.timeGeneration === wake.generation)
      if (!current || current.highWater + 1 < wake.run) return false
      const proof = await ports.read()
      entry.current()
      if (proof.wake.dueAt !== original.dueAt) throw new Error("schedule-wake-original-changed")
      if (current.highWater < wake.run) await locked.change(doc.id, doc.revision, entry.current, value => missionDocumentChanges.processWake(value, original))
      // The receipt admits consuming the run, committed with its high-water: closure,
      // owner and passage reconciliation may outlast it.
      entry.consumed?.()
      return ports.close(locked)
    })
    if (!consumed) return reply("pending")
    await ports.owner.reconcile(wake.missionID)
    try { await ports.runtime.reconcile({ ...entry, missionID: wake.missionID }) }
    finally { await ports.owner.reconcile(wake.missionID) }
  } else {
    // wake returns after admission/observation, never after the business actor's
    // lifetime. Its reserved high-water closes even while business stays pending.
    try { await ports.runtime.wake({ ...entry, missionID: wake.missionID, wake, cutoff }) }
    finally { await ports.store.withExclusion(locked => ports.close(locked)) }
    await ports.owner.reconcile(wake.missionID)
  }
  const fresh = await ports.store.read(wake.missionID)
  const settled = await ports.claim()
  entry.current()
  const isApplied = !!(fresh && !("deletedAt" in fresh) && ([...fresh.calendars, ...fresh.synchronization?.retiredCalendars ?? []]
    .some(item => item.scheduleID === wake.scheduleID && item.highWater >= wake.run)
    || settled?.key === key && settled.settled && settled.settled.revision <= fresh.revision))
  // Best effort: the run is applied either way, and a manual Check reports why a deletion stays.
  if (isApplied && fresh && !("deletedAt" in fresh) && fresh.deletion) await ports.compact?.().catch(() => undefined)
  return reply(isApplied ? "applied" : "pending")
}

export async function readNativeMissionScheduleWakeProof(input: {
  ctx: Plugin.Context; doc: MissionDocument; role: "principal" | "reconciliation"; wake: NativeScheduleWake;
  native: NativeScheduleCalendarService;
  run: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
  current: () => true;
}): Promise<{ binding: NativeScheduleCarrierBinding; wake: MissionWake }> {
  const { ctx, doc, role, wake: ref, native, run, current } = input
  current()
  const binding = role === "reconciliation"
    ? await readNativeScheduleAuxiliaryWakeBinding(ctx, ref, native, run, current)
    : await run(readNativeScheduleCarrierBinding(ctx, ref.sessionID))
  if (!binding || binding.document.id !== ref.missionID || binding.calendar.scheduleID !== ref.scheduleID
    || binding.calendar.timeGeneration !== ref.generation) throw new Error("schedule-wake-mapping")
  const descriptor = binding.document.calendarOwner!.slots.find(item => item.sessionID === ref.sessionID)
  if (!descriptor) throw new Error("schedule-wake-current-slot")
  const info = await native.get({ missionID: doc.id, descriptor }, ref.scheduleID, current)
  if (info && !info.code) throw new Error("schedule-calendar-requires-code")
  const wake = info && missionCodeWakeProof(binding.calendar, info, ref.run)
  if (!wake) throw new Error("schedule-wake-proof")
  current(); return { binding, wake }
}

/** Each receiver acquires private services in its own HTTP invocation graph. */
export function nativeMissionScheduleWakeHandlers(ctx: Plugin.Context) {
  const invocation = nativeInvocation()
  const handler = (mode: "wake" | "status" | "admit", raw: unknown) => Effect.scoped(invocation.capture(Effect.gen(function* () {
    const input = inputSchema.parse(raw); assertNativeScheduleWake(input.wake)
    if (input.incarnation.pid !== process.pid) throw new Error("schedule-wake-process")
    const processCurrent = nativeScheduleIncarnationGuard(input.registrationFile, input.incarnation)
    const run = <A>(effect: Effect.Effect<A, unknown>) => invocation.check(run => run(effect))
    const ownership = yield* readNativeScheduleCarrierOwnership(ctx, input.wake.sessionID), doc = ownership?.document
    if (!ownership?.verified || !doc?.calendarOwner || doc.id !== input.wake.missionID || doc.timeGeneration !== input.wake.generation
      || input.registrationFile !== doc.calendarOwner.installation.registrationFile) throw new Error("schedule-wake-owner")
    let active = true, consumed = false
    yield* Effect.addFinalizer(() => Effect.sync(() => { active = false }))
    const current = (): true => {
      if (!active) throw new Error("schedule-wake-retired")
      processCurrent(); assertNativeScheduleCarrierArtifacts(doc.calendarOwner!.installation)
      if (mode === "wake" && !consumed) assertNativeSchedulePreflight(input.preflight, input.wake, input.incarnation.id)
      return assertMissionCalendarPlacement(doc.calendarOwner!.placement, doc.configuration.roots)
    }
    current()
    const { owner, native, store } = yield* acquireNativeMissionScheduleOwner(ctx, doc, run, current)
    const descriptors = [...doc.calendarOwner.slots, ...doc.calendarOwner.retired.map(item => item.descriptor)]
    const mapped = [...doc.calendars, ...doc.synchronization?.retiredCalendars ?? []].find(item => item.sessionID === input.wake.sessionID
      && item.scheduleID === input.wake.scheduleID && item.timeGeneration === input.wake.generation)
    if (mapped && mapped.highWater >= input.wake.run) {
      // Consumed replays do not acquire the passage engine, but still qualify
      // the exact native row before acknowledging a Code Mode run.
      const descriptor = descriptors.find(item => item.sessionID === mapped.sessionID && item.scheduleID === mapped.scheduleID
        && item.timeGeneration === mapped.timeGeneration)
      if (!descriptor) throw new Error("schedule-wake-current-slot")
      const row = yield* Effect.tryPromise(() => native.get({ missionID: doc.id, descriptor }, input.wake.scheduleID, current))
      current()
      if (!row) throw new Error("schedule-wake-proof")
      if (!row.code) return nonCodeReply(input.wake)
      return { key: nativeScheduleWakeKey(input.wake), state: "applied" as const }
    }
    if (mode === "admit") {
      const descriptor = doc.calendarOwner.slots.find(item => item.sessionID === input.wake.sessionID)
      if (!descriptor) throw new Error("schedule-wake-current-slot")
      return yield* Effect.tryPromise(() => admitNativeMissionScheduleCodeWake(input.wake, { store, current,
        row: () => native.get({ missionID: doc.id, descriptor }, input.wake.scheduleID, current) }).catch(error => refuseNonCode(input.wake, error)))
    }
    const runtime = yield* acquireNativeScheduledPassageRuntime(ctx, run, { incarnation: input.incarnation.id })
    const controller = new AbortController()
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
    const read = () => readNativeMissionScheduleWakeProof({
      ctx, doc, role: ownership.reference.role, wake: input.wake, native, run, current,
    })
    return yield* Effect.tryPromise(() => receiveNativeMissionScheduleWake(mode, input, { current, signal: controller.signal, consumed: () => { consumed = true } }, { store, owner, runtime, read,
      claim: async () => parseNativeMissionScheduleClaim(await run(ctx.storage.get(nativeScheduleClaimKey(ctx, doc.id))), doc.id),
      close: locked => closeNativeScheduleCarrierClaimLocked(ctx, doc.id, run, current, locked),
      compact: () => compactNativeMissionDocumentDeletion(ctx, store, doc.id, run, current).then(() => undefined) }))
  })).pipe(Effect.orDie))
  return { wake: (raw: unknown) => handler("wake", raw), status: (raw: unknown) => handler("status", raw), admit: (raw: unknown) => handler("admit", raw) }
}
