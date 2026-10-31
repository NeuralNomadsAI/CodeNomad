import type { OpenCodeClient, SessionInfo } from "@opencode/client"
import type { MissionLifecycleOperation, MissionNativeAcknowledgement } from "./lifecycle-model"
import type { MissionMap } from "./model"
import { controlResumeAdmissionID } from "./receipt-identity"
import { interruptNativeMissionFamily, isSubagentDelivery, recheckNativeMissionFamily, settleInterruptedRoot, type NativeInboxItem } from "./native-family-interrupt"
import { readNativeControlFamily } from "./native-session-family"

const FAMILY_CONTROL_BUDGET_MS = 50_000
const FAMILY_RECHECK_BUDGET_MS = 10_000
const MAX_STOP_CANCELLATIONS = 128
type InterruptAck = Extract<MissionNativeAcknowledgement, { disposition: "interrupt-observed" }>

/** Shared native algorithm; callers provide their own current operation, root
 * placement and ownership checkpoints. Receipts stay in the existing journal. */
export async function interruptNativeMissionActor(options: {
  client: OpenCodeClient; root: SessionInfo; action: "pause" | "stop"; missionID: string
  signal: AbortSignal; current(): void; checkpoint(): Promise<void>
}): Promise<Pick<InterruptAck, "interrupt" | "cancellations" | "descendants">> {
  const { client, root, action, signal, current, checkpoint } = options
  const { descendants, ledger } = await interruptNativeMissionFamily({ ...options, deadline: Date.now() + FAMILY_CONTROL_BUDGET_MS })
  await checkpoint()
  const interrupt = await client.session.interrupt({ sessionID: root.id, resume: false }, { signal })
  current()
  if (!interrupt || typeof interrupt.interrupted !== "boolean" || Object.keys(interrupt).length !== 1) throw new Error("Unknown native interrupt acknowledgement")
  const cancellations: InterruptAck["cancellations"] = []
  const cancellable = (item: NativeInboxItem) => {
    if (item.type !== "user" && item.type !== "synthetic") return false
    const metadata = item.payload.metadata?.["codenomad.mission"]
    return Boolean(metadata && typeof metadata === "object" && !Array.isArray(metadata) && metadata.missionID === options.missionID)
      || isSubagentDelivery(item)
  }
  let overflow = false
  if (action === "stop") {
    const inbox = await client.session.inbox.list({ sessionID: root.id }, { signal })
    current()
    if (new Set(inbox.map(item => item.id)).size !== inbox.length) throw new Error("Incomplete native inbox observation")
    const queued = inbox.filter(cancellable)
    overflow = queued.length > MAX_STOP_CANCELLATIONS
    for (const item of queued.slice(0, MAX_STOP_CANCELLATIONS)) {
      await checkpoint()
      try {
        const cancelled = await client.session.inbox.cancel({ sessionID: root.id, inboxID: item.id }, { signal })
        current()
        if (cancelled !== undefined) throw new Error("Unknown native cancellation acknowledgement")
        cancellations.push({ inboxID: item.id, disposition: "native-acknowledged" })
      } catch (error) {
        current()
        const pending = await client.session.inbox.list({ sessionID: root.id }, { signal })
        current()
        if (new Set(pending.map(item => item.id)).size !== pending.length || pending.some(pending => pending.id === item.id)) throw error
        cancellations.push({ inboxID: item.id, disposition: "observed-absent" })
      }
    }
  }
  const recheck = (control: typeof descendants, interrupt: boolean) => recheckNativeMissionFamily({ ...options,
    deadline: Date.now() + FAMILY_RECHECK_BUDGET_MS }, ledger, control, interrupt)
  const caught = await recheck(descendants, true)
  const settled = await settleInterruptedRoot({ client, root, action, signal, current, checkpoint,
    ...(action === "stop" ? { cancel: cancellable, onCancelled: (inboxID: string, disposition: InterruptAck["cancellations"][number]["disposition"]) => {
      if (cancellations.length < MAX_STOP_CANCELLATIONS && !cancellations.some(item => item.inboxID === inboxID)) cancellations.push({ inboxID, disposition })
    } } : {}) })
  const verified = await recheck(caught, false)
  let drained = !overflow
  if (overflow) {
    try { drained = !(await client.session.inbox.list({ sessionID: root.id }, { signal })).some(cancellable) }
    catch { signal.throwIfAborted() }
    current()
  }
  return { interrupt, cancellations, descendants: settled && drained ? verified
    : { ...verified, unconfirmed: verified.unconfirmed + 1, complete: false } }
}

export function missionActorResumeInput(missionID: string, operationID: string, sessionID: string, coordinatorID: string, interrupted = "") {
  return { sessionID, id: controlResumeAdmissionID(operationID, sessionID),
    text: sessionID === coordinatorID
      ? `Start or resume existing mission ${missionID}. Inspect its map and playbook, use saved results, and continue coordination autonomously. Do not create a replacement mission. Resume existing queued assignments rather than duplicate them.${interrupted}`
      : `Resume your interrupted assignments in existing mission ${missionID}. Inspect the mission map and your transcript first; continue unfinished work without repeating completed actions, then report normally.`,
    description: "CodeNomad mission start/resume", delivery: "queue" as const, resume: true as const,
    metadata: { "codenomad.mission": { version: 1, missionID, kind: "lifecycle", operationID } } }
}

/** Only descendants reported by the latest Pause can be attributed to it. */
export async function interruptedMissionConversations(client: OpenCodeClient, root: SessionInfo,
  tasks: MissionMap["tasks"], paused: NonNullable<MissionLifecycleOperation["pausedDescendants"]>,
  signal: AbortSignal, current: () => void): Promise<string> {
  if (paused.graceful) return "\n\nThe mission was paused gracefully: you and your sub-agents were asked to finish the step in progress and stop."
    + " Delegated work may have stopped early. Read their last results, continue unfinished sub-agent conversations where they stopped rather than restarting them, and do not assume their work completed."
  if (!paused.sessions.length && !paused.partial) return ""
  const family = await readNativeControlFamily(client, root, signal, { assertCurrent: current, deadline: Date.now() + 15_000 })
  const ids = [...family.members.values()].filter(({ session }) => session.id !== root.id && session.outcome === "interrupted"
    && paused.sessions.includes(session.id)).map(({ session }) => session.id)
  if (!ids.length && !paused.partial) return ""
  if (!ids.length) return "\n\nThe mission was paused while sub-agents may have been running; inspect the mission map for unfinished delegated work."
  const listed = ids.slice(0, 32).map(id => {
    const task = tasks.find(task => task.actorSessionId === id)
    return task ? `task ${task.key} (${id})` : id
  })
  const more = ids.length > listed.length ? ` and ${ids.length - listed.length} more` : ""
  const partial = family.complete && !paused.partial ? "" : " The sub-agent inventory was incomplete; inspect the mission map for others."
  return `\n\nThese sub-agent conversations were interrupted when the mission was paused: ${listed.join(", ")}${more}.`
    + ` Re-delegate or continue their unfinished tasks as needed; do not assume their work completed.${partial}`
}
