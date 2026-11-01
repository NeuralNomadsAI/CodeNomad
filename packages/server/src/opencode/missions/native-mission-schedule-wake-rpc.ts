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
import { acquireNativeMissionScheduleWakeReader } from "./native-mission-schedule-wake-reader"
import { readNativeScheduleAuxiliaryWakeBinding } from "./native-schedule-owner-bindings"
import { assertNativeScheduleCarrierArtifacts, readNativeScheduleCarrierOwnership, readNativeScheduleCarrierBinding,
  nativeScheduleClaimKey, closeNativeScheduleCarrierClaimLocked, type NativeScheduleCarrierBinding } from "./native-schedule-carrier-binding"
import { nativeScheduleIncarnationGuard, sameNativeScheduleIncarnation } from "./native-schedule-transport-identity"
import { nativeScheduleWakeKey, assertNativeScheduleWake, type NativeScheduleWake, type NativeScheduleTransportReply, type NativeSchedulePreflight } from "./native-schedule-transport-contract"
import { assertNativeSchedulePreflight, nativeSchedulePreflight } from "./native-mission-schedule-preflight"
import { parseNativeMissionScheduleClaim } from "./native-mission-schedule-wake-dispatch"
import type { NativeScheduleArtifacts } from "./native-schedule-installation"
import type { NativeScheduleCalendarOwner } from "./native-schedule-owner"

const text = z.string().min(1).max(4096)
const inputSchema = z.object({ registrationFile: text, incarnation: z.object({ id: text, pid: z.number().int().positive(), url: text, version: text.optional() }).strict(),
  wake: z.object({ missionID: text, generation: z.number().int().positive(), scheduleID: text, run: z.number().int().positive(), sessionID: text, messageID: text }).strict(),
  preflight: z.object({ cutoff: z.number().int().nonnegative(), issuedAt: z.number().int().nonnegative(), signature: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional() }).strict()
type Input = z.infer<typeof inputSchema>
type Entry = { current(): true; signal: AbortSignal }
export type NativeMissionScheduleWakePorts = { store: NativeMissionDocumentStore; owner: Pick<NativeScheduleCalendarOwner, "adoptAuxiliary" | "reconcile">;
  runtime: Pick<NativeScheduledPassageRuntime, "preflight" | "wake" | "reconcile">;
  read(): Promise<{ binding: NativeScheduleCarrierBinding; wake: MissionWake }>;
  claim(): Promise<ReturnType<typeof parseNativeMissionScheduleClaim>>;
  close(locked: NativeMissionDocumentStore): Promise<boolean> }

/** Orchestration over real document/owner/passage ports. An auxiliary consumes
 * and releases its own claim before any cleanup or pending-business observation. */
export async function receiveNativeMissionScheduleWake(mode: "wake" | "status", input: Input, entry: Entry,
  ports: NativeMissionScheduleWakePorts): Promise<NativeScheduleTransportReply> {
  const wake = input.wake, key = nativeScheduleWakeKey(wake), reply = (state: NativeScheduleTransportReply["state"]) => ({ key, state })
  entry.current(); entry.signal.throwIfAborted()
  const claim = await ports.claim()
  const { binding, wake: original } = await ports.read(), calendar = binding.calendar
  if (calendar.highWater >= wake.run) return reply("applied")
  const claimed = claim?.key === key && sameNativeScheduleIncarnation(claim.incarnation, input.incarnation)
  if (mode === "status") {
    const preflight = calendar.role === "reconciliation"
      ? { messagePresent: true, ready: wake.run === calendar.highWater + 1, cutoff: Date.now() }
      : await ports.runtime.preflight({ ...entry, missionID: wake.missionID, wake })
    entry.current()
    return { ...reply(claimed ? "pending" : "unknown"), messagePresent: preflight.messagePresent, ready: preflight.ready,
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
  return reply(fresh && !("deletedAt" in fresh) && ([...fresh.calendars, ...fresh.synchronization?.retiredCalendars ?? []]
    .some(item => item.scheduleID === wake.scheduleID && item.highWater >= wake.run)
    || settled?.key === key && settled.settled && settled.settled.revision <= fresh.revision) ? "applied" : "pending")
}

/** Each receiver captures its full HTTP graph, independently of the hook that
 * initiated transport. No setup/context graph supplies private Session/Schedule. */
export function nativeMissionScheduleWakeHandlers(ctx: Plugin.Context, _artifacts?: NativeScheduleArtifacts) {
  const invocation = nativeInvocation()
  const handler = (mode: "wake" | "status", raw: unknown) => Effect.scoped(invocation.capture(Effect.gen(function* () {
    const input = inputSchema.parse(raw); assertNativeScheduleWake(input.wake)
    if (input.incarnation.pid !== process.pid) throw new Error("schedule-wake-process")
    const processCurrent = nativeScheduleIncarnationGuard(input.registrationFile, input.incarnation)
    const run = <A>(effect: Effect.Effect<A, unknown>) => invocation.check(run => run(effect))
    const ownership = yield* readNativeScheduleCarrierOwnership(ctx, input.wake.sessionID), doc = ownership?.document
    if (!ownership?.verified || !doc?.calendarOwner || doc.id !== input.wake.missionID || doc.timeGeneration !== input.wake.generation
      || input.registrationFile !== doc.calendarOwner.installation.registrationFile) throw new Error("schedule-wake-owner")
    let active = true
    yield* Effect.addFinalizer(() => Effect.sync(() => { active = false }))
    const current = (): true => {
      if (!active) throw new Error("schedule-wake-retired")
      processCurrent(); assertNativeScheduleCarrierArtifacts(doc.calendarOwner!.installation)
      if (mode === "wake") assertNativeSchedulePreflight(input.preflight, input.wake, input.incarnation.id)
      return assertMissionCalendarPlacement(doc.calendarOwner!.placement, doc.configuration.roots)
    }
    current()
    const mapped = [...doc.calendars, ...doc.synchronization?.retiredCalendars ?? []].find(item => item.sessionID === input.wake.sessionID
      && item.scheduleID === input.wake.scheduleID && item.timeGeneration === input.wake.generation)
    if (mapped && mapped.highWater >= input.wake.run) return { key: nativeScheduleWakeKey(input.wake), state: "applied" as const }
    const { owner, native, store } = yield* acquireNativeMissionScheduleOwner(ctx, doc, run, current)
    const reader = yield* acquireNativeMissionScheduleWakeReader(ctx, run)
    const runtime = yield* acquireNativeScheduledPassageRuntime(ctx, run, { incarnation: input.incarnation.id })
    const controller = new AbortController()
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
    const read = async () => {
      current()
      const binding = ownership.reference.role === "reconciliation"
        ? await readNativeScheduleAuxiliaryWakeBinding(ctx, input.wake, native, run, current)
        : await run(readNativeScheduleCarrierBinding(ctx, input.wake.sessionID))
      if (!binding || binding.document.id !== input.wake.missionID || binding.calendar.scheduleID !== input.wake.scheduleID
        || binding.calendar.timeGeneration !== input.wake.generation) throw new Error("schedule-wake-mapping")
      const descriptor = binding.document.calendarOwner!.slots.find(item => item.sessionID === input.wake.sessionID)
      if (!descriptor) throw new Error("schedule-wake-current-slot")
      const info = await native.get({ missionID: doc.id, descriptor }, input.wake.scheduleID, current)
      const wake = await reader.message(input.wake)
      if (!info || info.runCount < input.wake.run || !wake) throw new Error("schedule-wake-proof")
      current(); return { binding, wake }
    }
    return yield* Effect.tryPromise(() => receiveNativeMissionScheduleWake(mode, input, { current, signal: controller.signal }, { store, owner, runtime, read,
      claim: async () => parseNativeMissionScheduleClaim(await run(ctx.storage.get(nativeScheduleClaimKey(ctx, doc.id))), doc.id),
      close: locked => closeNativeScheduleCarrierClaimLocked(ctx, doc.id, run, current, locked) }))
  })).pipe(Effect.orDie))
  return { wake: (raw: unknown) => handler("wake", raw), status: (raw: unknown) => handler("status", raw) }
}
