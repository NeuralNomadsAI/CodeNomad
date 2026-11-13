import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { COORDINATOR_INPUT_MARKER, coordinatorInputSchema } from "../../missions/mission-coordinator-baseline"
import { runMissionExclusive } from "../../missions/exclusive"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { nativeScheduleDocumentKey } from "./native-schedule-carrier-binding"
import { nativeInvocation } from "./native-invocation"
import { acquireNativeSourceFence } from "./native-source-fence"
import { scheduledPassageOwner } from "./native-scheduled-passage-owner"

/** Stamp the first actual child prompt of an adopted passage before admission.
 * The one native metadata entry survives message pruning and is replaced only by
 * a later passage. A lost/denied first admission stays uncertain. */
export const registerScheduledChildInput = Effect.fn("missions.registerScheduledChildInput")(function* (ctx: Plugin.Context) {
  const invocation = nativeInvocation()
  yield* ctx.session.hook("prompt", event => invocation.capture(Effect.gen(function* () {
    const child = yield* ctx.session.get({ sessionID: event.sessionID })
    if (!child.parentID) return
    let root = child
    const seen = new Set<string>()
    for (let depth = 0; root.parentID && depth <= 32; depth++) {
      if (seen.has(root.id)) throw new Error("Adopted child ancestry cycle")
      seen.add(root.id)
      root = yield* ctx.session.get({ sessionID: root.parentID })
    }
    if (root.parentID) throw new Error("Adopted child ancestry capacity")
    const marker = root.metadata?.["codenomad.mission"] as { missionID?: unknown; document?: { missionID?: unknown; passageID?: unknown; coordinatorReused?: unknown } } | undefined
    if (marker?.document?.coordinatorReused !== true || typeof marker.document.missionID !== "string") return
    const doc = scheduledPassageOwner(yield* ctx.storage.get(nativeScheduleDocumentKey(ctx, marker.document.missionID)), {
      projectID: ctx.location.project.id, projectCanonical: ctx.location.project.canonical,
    }, root.id, marker)
    if (!doc) return
    const pending = doc.pending
    if (!pending || pending.id !== marker.document.passageID || pending.missionID !== marker.missionID || pending.coordinatorSessionID !== root.id) return
    if (child.projectID !== doc.projectID || child.location.directory !== ctx.location.directory
      || child.location.workspaceID !== ctx.location.workspaceID || root.location.directory !== ctx.location.directory
      || root.location.workspaceID !== ctx.location.workspaceID) throw new Error("Adopted child moved")
    const fences = yield* acquireNativeSourceFence(() => true)
    const rootFence = fences(); rootFence.selectedSession(root)
    yield* Effect.tryPromise(() => invocation.check(run => runMissionExclusive(JSON.stringify(["passage-input", doc.projectID, child.id]), async () => {
      const fresh = await run(ctx.session.get({ sessionID: child.id }))
      const owner = { passageID: pending.id, missionID: pending.missionID, coordinatorSessionID: root.id }
      const previous = coordinatorInputSchema.safeParse(fresh.metadata?.[COORDINATOR_INPUT_MARKER])
      if (fresh.metadata?.[COORDINATOR_INPUT_MARKER] !== undefined && !previous.success) throw new Error("Adopted child input identity unavailable")
      if (previous.success && canonicalAuthority({ ...previous.data, messageID: "" }) === canonicalAuthority({ ...owner, messageID: "" })) return
      if (previous.success && previous.data.passageID === pending.id) throw new Error("Adopted child input owner differs")
      if (fresh.parentID !== child.parentID || fresh.projectID !== child.projectID || fresh.location.directory !== child.location.directory
        || fresh.location.workspaceID !== child.location.workspaceID) throw new Error("Adopted child moved")
      const value = { ...owner, messageID: event.messageID }
      const childFence = fences(); childFence.selectedSession(fresh)
      const update = ctx.session.update({ sessionID: Session.ID.make(child.id),
        metadata: JSON.parse(canonicalAuthority({ ...fresh.metadata, [COORDINATOR_INPUT_MARKER]: value })) })
      await run(Effect.suspend(() => { rootFence.current(); childFence.current(); return update }))
      const confirmed = await run(ctx.session.get({ sessionID: child.id }))
      if (canonicalAuthority(confirmed.metadata?.[COORDINATOR_INPUT_MARKER]) !== canonicalAuthority(value)) throw new Error("Adopted child input unconfirmed")
    })))
  })).pipe(Effect.orDie))
})
