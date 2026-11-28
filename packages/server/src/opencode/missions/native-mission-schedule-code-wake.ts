import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Cause, Context, Effect } from "effect"
import { parseMissionDocument, type MissionDocument } from "../../missions/mission-document"
import { assertMissionCalendarPlacement } from "../../missions/mission-calendar-placement"
import { nativeInvocation } from "./native-invocation"
import { assertNativeScheduleCarrierArtifacts, nativeScheduleClaimKey, nativeScheduleDocumentKey,
  readNativeScheduleCarrierOwnership } from "./native-schedule-carrier-binding"
import { assertNativeScheduleWake, type NativeScheduleWake } from "./native-schedule-transport-contract"
import { parseNativeMissionScheduleClaim, recoverNativeMissionScheduleClaim } from "./native-mission-schedule-wake-dispatch"
import { nativeMissionScheduleDispatcher } from "./native-mission-schedule-wake-dispatcher"
import { MISSION_WAKE_TOOL, missionWakeMessageID, runningMissionCodeWake, sameMissionAutomation } from "./native-mission-automation"
import { sendNativeMissionScheduleMaintenance } from "./native-mission-schedule-wake-maintenance"
import type { NativeScheduleTransportResult } from "./native-schedule-transport"
import { setTimeout as delay } from "node:timers/promises"

// Set only while OpenCode runs an automation's program unattended.
const unattended = Context.Reference<unknown>("@opencode/Permission/Unattended", { defaultValue: () => undefined })
// The program's whole budget is 30 seconds, plugin activation included.
const CODE_WAKE_DEADLINE_MS = 20_000
const applied = (result: { state: string; reply?: { state: string } }) => result.state === "received" && result.reply?.state === "applied"

/** One code run of a Mission calendar. A principal run returns once Missions admitted it
 * (its preparation then proves the run), and an auxiliary run
 * once its reconciliation applied. Anything else fails, so OpenCode retries the same run. */
export function nativeMissionScheduleCodeWake(ctx: Plugin.Context, tool: Pick<Tool.Context, "sessionID" | "messageID">,
  maintain = sendNativeMissionScheduleMaintenance, createDispatcher = nativeMissionScheduleDispatcher) {
  const invocation = nativeInvocation(CODE_WAKE_DEADLINE_MS)
  return Effect.scoped(invocation.capture(Effect.gen(function* () {
    const run = <A>(effect: Effect.Effect<A, unknown>) => invocation.check(run => run(effect))
    const match = /^msg_(aut_[A-Za-z0-9]+)_([1-9]\d{0,14})$/.exec(tool.messageID)
    if ((yield* unattended) === undefined || !match) throw new Error("schedule-code-wake-caller")
    const ownership = yield* readNativeScheduleCarrierOwnership(ctx, tool.sessionID), original = ownership?.document
    if (!ownership?.verified || !original?.calendarOwner) throw new Error("schedule-code-wake-owner")
    const descriptor = original.calendarOwner.slots.find(item => item.sessionID === tool.sessionID && item.timeGeneration === original.timeGeneration)
    // Retiring calendars admit nothing. The retiring auxiliary asks for cleanup directly.
    if (!descriptor) {
      // Only the retired auxiliary's own automation may ask.
      const retired = original.calendarOwner.retired.find(item => item.descriptor.sessionID === tool.sessionID && item.descriptor.role === "reconciliation"
        && !item.scheduleRemoved && item.descriptor.scheduleID !== null && sameMissionAutomation(item.descriptor.scheduleID, match[1]))
      if (retired) yield* Effect.promise(() => maintain({ missionID: original.id,
        sessionID: tool.sessionID, timeGeneration: ownership.reference.timeGeneration,
        registrationFile: original.calendarOwner!.installation.registrationFile, directory: ctx.location.directory }))
      return "retired"
    }
    const calendar = original.calendars.find(item => item.sessionID === tool.sessionID)
    // A created auxiliary whose acknowledgement was lost is adopted by its own first run.
    const unacknowledged = descriptor.role === "reconciliation" && descriptor.creation === "attempted" && descriptor.scheduleID === null
    const scheduleID = calendar?.scheduleID ?? descriptor.scheduleID ?? (unacknowledged ? match[1] : undefined)
    if (!scheduleID || !sameMissionAutomation(scheduleID, match[1])) throw new Error("schedule-code-wake-mapping")
    const wake: NativeScheduleWake = { missionID: original.id, generation: original.timeGeneration, sessionID: tool.sessionID,
      scheduleID, run: Number(match[2]), messageID: missionWakeMessageID(scheduleID, Number(match[2])) }
    assertNativeScheduleWake(wake)
    if (wake.messageID !== tool.messageID) throw new Error("schedule-code-wake-mapping")
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), CODE_WAKE_DEADLINE_MS)
    yield* Effect.addFinalizer(() => Effect.sync(() => { clearTimeout(timer); abort.abort() }))
    const current = (): true => {
      abort.signal.throwIfAborted()
      assertNativeScheduleCarrierArtifacts(original.calendarOwner!.installation)
      return assertMissionCalendarPlacement(original.calendarOwner!.placement, original.configuration.roots)
    }
    const fresh = async (): Promise<MissionDocument | undefined> => {
      const value = await run(ctx.storage.get(nativeScheduleDocumentKey(ctx, original.id)))
      if (value === undefined || value && typeof value === "object" && "deletedAt" in value) return undefined
      return parseMissionDocument(value, { id: original.id, projectID: ctx.location.project.id, projectCanonical: ctx.location.project.canonical })
    }
    const dispatcher = createDispatcher(ctx, original, { run, current, signal: abort.signal, fresh })
    // Due rows of one Mission share its transport lane, so another wake of it can hold the lane briefly.
    // Wait within the deadline rather than fail: a failed last slot could expire before OpenCode retries it.
    const free = async (send: () => Promise<NativeScheduleTransportResult>) => {
      for (;;) {
        const result = await send()
        if (result.state !== "not-dispatched" || result.reason !== "busy") return result
        await delay(250, undefined, { signal: abort.signal }); current()
      }
    }
    const dispatch = (target: NativeScheduleWake) => free(() => dispatcher.dispatch(target))
    const request = { wake, registrationFile: original.calendarOwner.installation.registrationFile, directory: ctx.location.directory, signal: abort.signal }
    // Until this returns, a Stop or Delete keeps the run's preparation: OpenCode will still count it.
    return yield* Effect.promise(() => runningMissionCodeWake(wake.scheduleID, wake.run, async () => {
      current()
      // An unsettled claim on another occurrence holds every later wake of its Mission.
      const prior = parseNativeMissionScheduleClaim(await run(ctx.storage.get(nativeScheduleClaimKey(ctx, original.id))), original.id)
      let recovered = await recoverNativeMissionScheduleClaim(prior, wake, dispatch)
      if (descriptor.role === "reconciliation") {
        if (!recovered && (await fresh())?.calendarOwner?.operation.pending) {
          // A pending owner control blocks principal preflight while the unsettled claim
          // blocks this reconciliation wake from running owner.reconcile. Settle the
          // pending owner operation first, then retry recovering the exact prior claim.
          await maintain({ missionID: original.id, sessionID: tool.sessionID, timeGeneration: original.timeGeneration,
            registrationFile: original.calendarOwner!.installation.registrationFile, directory: ctx.location.directory }, abort.signal)
          current()
          const retryPrior = parseNativeMissionScheduleClaim(await run(ctx.storage.get(nativeScheduleClaimKey(ctx, original.id))), original.id)
          recovered = await recoverNativeMissionScheduleClaim(retryPrior, wake, dispatch)
        }
        if (!recovered) throw new Error("schedule-code-wake-pending")
        const result = await dispatch(wake)
        if (!applied(result)) throw new Error(result.state === "received" && result.reply.reason || "schedule-code-wake-pending")
        // Then the original next principal preparations.
        for (const principal of (await fresh())?.calendars.filter(item => item.role === "principal" && item.wakePreparing).slice(0, 8) ?? []) {
          current()
          await dispatch({ missionID: original.id, generation: principal.timeGeneration, sessionID: principal.sessionID,
            scheduleID: principal.scheduleID, run: principal.wakePreparing!.run, messageID: principal.wakePreparing!.messageID })
        }
        return "applied"
      }
      // A preparation OpenCode already counted is processed before this run can be admitted.
      const backlog = (await fresh())?.calendars.find(item => item.sessionID === wake.sessionID)?.wakePreparing
      if (recovered && backlog && backlog.run < wake.run)
        await dispatch({ ...wake, run: backlog.run, messageID: backlog.messageID })
      const admission = await free(() => dispatcher.transport.admit(request))
      // The reason (transport failure or receiver reply) shows in the automation's last output.
      if (admission.state !== "received") throw new Error(`schedule-code-wake-${admission.state}-${admission.reason}`)
      if (admission.reply.reason) throw new Error(admission.reply.reason)
      if (!["pending", "applied"].includes(admission.reply.state)) throw new Error(`schedule-code-wake-${admission.reply.state}`)
      if (admission.reply.state === "applied") return "applied"
      // Admitted: OpenCode may count the run now. Processing is retried by later wakes.
      await dispatch(wake).catch(() => undefined)
      return "admitted"
    }))
  })).pipe(Effect.catchCause(cause => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
    const error = Cause.squash(cause)
    // Fixed codes only: native errors and credentials stay out of the automation's output.
    const message = error instanceof Error && /^schedule-[a-z-]+$/.test(error.message) ? error.message : "schedule-code-wake-failed"
    return Effect.fail(new Tool.Error({ message }))
  })))
}

/** The Code Mode tool every Mission code calendar calls. Visible to Code Mode, it
 * accepts only an unattended run of its own carrier's current calendar. */
export const registerNativeMissionScheduleCodeWake = (ctx: Plugin.Context) => ctx.tool.transform(editor => editor.add({
  name: MISSION_WAKE_TOOL.name,
  description: "Internal CodeNomad Mission schedule wake. Only the Mission's own automation can call it.",
  input: { type: "object", properties: {}, additionalProperties: false },
  options: { namespace: MISSION_WAKE_TOOL.namespace, codemode: true, permission: MISSION_WAKE_TOOL.permission },
  execute: (_input, tool) => nativeMissionScheduleCodeWake(ctx, tool).pipe(Effect.map(content => ({ content }))),
}))
