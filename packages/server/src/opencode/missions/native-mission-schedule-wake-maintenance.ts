import type { Plugin } from "@opencode/plugin/effect"
import { Rpc } from "@opencode/plugin/effect"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { Effect } from "effect"
import { z } from "zod"
import { nativeInvocation } from "./native-invocation"
import { acquireNativeMissionScheduleOwner } from "./native-mission-schedule-owner"
import { readNativeScheduleCarrierOwnership, assertNativeScheduleCarrierArtifacts } from "./native-schedule-carrier-binding"
import { nativeScheduleIncarnationGuard, readNativeScheduleIncarnation } from "./native-schedule-transport-identity"
import { boundedNativeScheduleResponse } from "./native-schedule-transport"
import type { MissionDocument } from "../../missions/mission-document"
import type { MissionCalendarOwnerSlot } from "../../missions/mission-calendar-owner-state"

const text = { type: "string", minLength: 1, maxLength: 4096 } as const
const responseSchema = z.object({ complete: z.boolean() }).strict()
export const NativeMissionScheduleMaintenanceRpc = {
  id: "codenomad.missions.schedule-maintenance", methods: { reconcile: {
    input: { type: "object", additionalProperties: false, required: ["sessionID", "registrationFile", "incarnation"], properties: {
      sessionID: text, registrationFile: text, incarnation: { type: "object", additionalProperties: false,
        required: ["id", "pid", "url"], properties: { id: text, pid: { type: "integer", minimum: 1 }, url: text, version: text } },
    } }, output: { type: "object", additionalProperties: false, required: ["complete"], properties: { complete: { type: "boolean" } } },
  } }, events: {},
} as const
export type NativeMissionScheduleIdleHint = Readonly<{ missionID: string; sessionID: string; timeGeneration: number; registrationFile: string; directory: string }>
const laneKey = Symbol.for("codenomad.missions.schedule-maintenance.lanes")
const host = globalThis as typeof globalThis & { [laneKey]?: Set<string> }
const lanes = host[laneKey] ??= new Set<string>()

/** Fixed own-process HTTP method. Late discovery retains its bounded lane and
 * refuses dispatch after cancellation; no private invocation graph is captured. */
export async function sendNativeMissionScheduleMaintenance(hint: NativeMissionScheduleIdleHint, signal?: AbortSignal,
  deps = { discover: Service.discover, headers: Service.headers, fetch: globalThis.fetch }): Promise<boolean> {
  const lane = `${hint.directory}\0${hint.missionID}`
  if (lanes.has(lane) || lanes.size >= 128) return false
  lanes.add(lane)
  const abort = new AbortController(), combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
  const timer = setTimeout(() => abort.abort(), 8000)
  try {
    combined.throwIfAborted()
    const incarnation = readNativeScheduleIncarnation(hint.registrationFile), guard = nativeScheduleIncarnationGuard(hint.registrationFile, incarnation)
    guard()
    const endpoint = await deps.discover({ file: hint.registrationFile })
    combined.throwIfAborted(); guard()
    if (!endpoint || endpoint.url !== incarnation.url) return false
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: deps.headers(endpoint), fetch: async (input, init) => {
      combined.throwIfAborted(); guard()
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin !== new URL(endpoint.url).origin || url.pathname !== `/api/rpc/${NativeMissionScheduleMaintenanceRpc.id}/reconcile` || init?.method !== "POST")
        throw new Error("schedule-maintenance-target")
      return boundedNativeScheduleResponse(await deps.fetch(input, { ...init, signal: combined, redirect: "error" }), combined)
    } })
    const result = await client.rpc(NativeMissionScheduleMaintenanceRpc).reconcile({ sessionID: hint.sessionID, registrationFile: hint.registrationFile, incarnation },
      { location: { directory: hint.directory }, signal: combined })
    combined.throwIfAborted(); guard()
    return responseSchema.parse(result).complete
  } catch { return false }
  finally { clearTimeout(timer); lanes.delete(lane) }
}

const inputSchema = z.object({ sessionID: z.string().min(1).max(1024), registrationFile: z.string().min(1).max(4096),
  incarnation: z.object({ id: z.string().min(1).max(1024), pid: z.number().int().positive(), url: z.string().max(4096), version: z.string().max(1024).optional() }).strict() }).strict()

export async function reconcileNativeMissionScheduleMaintenance(doc: MissionDocument, sessionID: string,
  quiet: (descriptor: MissionCalendarOwnerSlot) => Promise<boolean>, reconcile: () => Promise<MissionDocument>): Promise<{ complete: boolean }> {
  const state = doc.calendarOwner, descriptor = state?.slots.find(slot => slot.sessionID === sessionID)
    ?? state?.retired.find(item => item.descriptor.sessionID === sessionID)?.descriptor
  if (!state || !descriptor || doc.pending || !state.retired.length && !["finished", "stopped"].includes(doc.state) && !doc.deletion
    || !await quiet(descriptor)) return { complete: false }
  const result = await reconcile()
  return { complete: result.calendarOwner?.operation.pending === false && !result.calendarOwner.retired.length
    && !result.calendarOwner.slots.some(slot => slot.sessionID === sessionID) }
}

/** Maintenance reconciles saved technical cleanup only. The terminal event is a
 * hint; current native active/claim/inbox/child coverage decides removal. */
export function nativeMissionScheduleMaintenanceHandler(ctx: Plugin.Context) {
  const invocation = nativeInvocation()
  return (raw: unknown) => Effect.scoped(invocation.capture(Effect.gen(function* () {
    const input = inputSchema.parse(raw), processCurrent = nativeScheduleIncarnationGuard(input.registrationFile, input.incarnation)
    processCurrent()
    const ownership = yield* readNativeScheduleCarrierOwnership(ctx, input.sessionID), doc = ownership?.document
    if (!ownership?.verified || !doc?.calendarOwner || input.registrationFile !== doc.calendarOwner.installation.registrationFile) return { complete: false }
    let active = true
    yield* Effect.addFinalizer(() => Effect.sync(() => { active = false }))
    const current = (): true => {
      if (!active) throw new Error("schedule-maintenance-retired")
      processCurrent(); return assertNativeScheduleCarrierArtifacts(doc.calendarOwner!.installation)
    }
    const run = <A>(effect: Effect.Effect<A, unknown>) => invocation.check(run => run(effect))
    const { owner, native } = yield* acquireNativeMissionScheduleOwner(ctx, doc, run, current)
    return yield* Effect.tryPromise(() => reconcileNativeMissionScheduleMaintenance(doc, input.sessionID,
      descriptor => native.carrierQuiet({ missionID: doc.id, descriptor }, current), () => owner.reconcile(doc.id)))
  })).pipe(Effect.orDie))
}

export const registerNativeMissionScheduleMaintenance = (ctx: Plugin.Context) =>
  ctx.rpc.register(Rpc.define(NativeMissionScheduleMaintenanceRpc), { reconcile: nativeMissionScheduleMaintenanceHandler(ctx) }).pipe(Effect.orDie)
