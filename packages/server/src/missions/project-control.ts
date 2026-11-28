import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import type { MissionControl } from "./control"
import { MissionControlError } from "./control-error"
import type { MissionJsonValue, MissionMap } from "./model"
import { runMissionExclusive } from "./exclusive"
import { projectToolCommand, type ProjectToolCommand } from "./project-control-tool"
import { projectControlProof, type ProjectControlProof } from "./project-control-proof"
import { missionAcceptsCoordinatorMessage } from "./briefing-request"
import { canonicalAuthority } from "./authority-protocol"

const receiptSchema = z.object({
  command: projectToolCommand, state: z.enum(["pending", "completed", "refused"]),
  result: z.record(z.string(), z.json()).optional(), code: z.string().optional(), retryable: z.boolean().optional(),
}).strict()
type Receipt = z.infer<typeof receiptSchema>
/** Text inputs stay in the immutable native receipt; tool replies carry its
 * identity and digest. Escaped 20k bodies can exceed the entire wire read bound. */
export function projectControlResult(result: { receipt?: Receipt }) {
  const receipt = result.receipt
  if (!receipt || receipt.command.tool !== "configure") return result
  const { objective: _objective, notes: _notes, ...fields } = receipt.command.input
  return { ...result, receipt: { ...receipt, command: { tool: "configure", input: fields },
    payloadDigest: createHash("sha256").update(canonicalAuthority(receipt.command, 512 * 1024)).digest("hex") } }
}
type Storage = { get(key: string): Promise<MissionJsonValue | undefined>; set(key: string, value: MissionJsonValue): Promise<void> }
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
export const missionControlAction = (action: string) => action === "play" || action === "resume" ? "start" as const
  : action === "pause" || action === "interrupt" ? "pause" as const : "stop" as const
function lifecycleReceipt(mission: MissionMap | undefined, command: ProjectToolCommand) {
  if (command.tool !== "control" || !["play", "resume", "pause", "interrupt", "stop"].includes(command.input.action)) return
  const c = mission?.control, r = command.input
  return c && c.requestID === r.requestID && c.expectedRevision === r.expectedRevision
    && c.action === missionControlAction(r.action) && Boolean(c.graceful) === (r.action === "pause") ? c : undefined
}
export function projectMissionState(mission: MissionMap) {
  const control = mission.control
  return { missionID: mission.id, revision: mission.revision, status: mission.status, ...(mission.runState ? { runState: mission.runState } : {}),
    ...(control ? { control: { requestID: control.requestID, expectedRevision: control.expectedRevision, action: control.action,
      graceful: Boolean(control.graceful), pending: control.pending.length } } : {}) }
}
/** Durable project-tool intents wrap the ordinary business operations. A lost
 * acknowledgement leaves its original intent, never permission to send again. */
export function projectMissionController(input: {
  projectID: string; directory: string; storage: Storage; control: MissionControl; current(): void
  verify(proof: ProjectControlProof): Promise<unknown>; update(proof: ProjectControlProof): Promise<unknown>
}) {
  const { control, storage } = input
  const prefix = `codenomad-mission-project-controls/v1/${hash(input.projectID)}/`
  const readReceipt = async (key: string) => {
    const raw = await storage.get(key)
    return raw === undefined ? undefined : receiptSchema.parse(raw)
  }
  const save = async (key: string, receipt: Receipt) => {
    input.current()
    await storage.set(key, JSON.parse(JSON.stringify(receipt)))
  }
  return async (raw: unknown) => {
    const proof = projectControlProof.parse(raw)
    if (proof.projectID !== input.projectID || proof.directory !== input.directory) throw new Error("Foreign Mission project control")
    const command = proof.command, request = command.input
    return runMissionExclusive(`project-tools:${prefix}`, async () => {
      const verified = await input.verify(proof) as { verified?: unknown } | undefined
      if (verified?.verified !== true) throw new Error("Mission agent principal unconfirmed")
      input.current()
      const base = `${prefix}${hash(request.missionID)}/`, key = `${base}${hash(request.requestID ?? "")}`
      const pendingKey = `${base}pending`
      let previous = request.requestID ? await readReceipt(key) : undefined
      const snapshot = () => control.snapshot()
      const observe = async () => {
        const state = await snapshot(), mission = state.missions.find(m => m.id === request.missionID)
        if (state.projectID !== input.projectID) throw new Error("Foreign Mission snapshot")
        return { mission, state, cleanups: (state.cleanups ?? []).filter(c => c.missionID === request.missionID) }
      }
      if (request.action === "read") {
        const { mission, state, cleanups } = await observe()
        if (!previous && request.requestID) {
          const c = mission?.control
          if (command.tool === "control" && !state.controlUnavailable && c?.requestID === request.requestID) {
            previous = { command: { tool: "control", input: { missionID: request.missionID, requestID: c.requestID,
              expectedRevision: c.expectedRevision, action: c.action === "start" ? "play" : c.action === "pause"
                ? c.graceful ? "pause" : "interrupt" : "stop" } },
              state: c.pending.length ? "pending" : "completed", retryable: Boolean(c.pending.length),
              ...(c.pending.length ? {} : { result: projectMissionState(mission!) }) }
          }
          const cleanup = command.tool === "delete" && !state.cleanupUnavailable
            ? cleanups.find(c => c.requestID === request.requestID) : undefined
          if (cleanup) previous = { command: { tool: "delete", input: { missionID: request.missionID,
            action: "delete", requestID: cleanup.requestID, expectedRevision: cleanup.expectedRevision,
            deleteManagedSessions: cleanup.deleteManagedSessions } },
            state: cleanup.pending || cleanup.documentPending ? "pending" : "completed",
            retryable: Boolean(cleanup.pending || cleanup.documentPending),
            ...(cleanup.pending || cleanup.documentPending ? {} : { result: { deleted: true } }) }
        }
        if (previous && (previous.command.tool !== command.tool || request.expectedRevision !== undefined
          && previous.command.input.expectedRevision !== request.expectedRevision))
          throw new MissionControlError("Original Mission request identity differs", "request-conflict")
        if (previous?.state === "pending") {
          const original = previous.command
          const c = mission?.control, r = original.input
          const exactControl = lifecycleReceipt(mission, original)
          const superseded = original.tool !== "delete" && c?.action === "stop" && !c.pending.length
            && c.requestID !== r.requestID && c.expectedRevision >= (r.expectedRevision ?? Number.MAX_SAFE_INTEGER)
          const answered = original.tool === "control" && original.input.action === "request-update"
            && (mission?.briefing?.requestID === r.requestID || mission?.briefingResponses?.some(b => b.requestID === r.requestID))
          const deletion = original.tool === "delete" ? cleanups.find(c => c.requestID === r.requestID
            && c.expectedRevision === r.expectedRevision && c.deleteManagedSessions === original.input.deleteManagedSessions) : undefined
          if (!state.controlUnavailable && (exactControl && !exactControl.pending.length || superseded || answered)
            || !state.cleanupUnavailable && deletion && !deletion.pending && !deletion.documentPending) {
            previous = { ...previous, state: "completed", retryable: false,
              result: mission ? { ...projectMissionState(mission), ...(superseded ? { superseded: true } : {}), ...(answered ? { answered: true } : {}) } : { deleted: true } }
          } else previous = { ...previous, retryable: Boolean(!state.controlUnavailable && exactControl && exactControl.pending.length
            || !state.cleanupUnavailable && deletion && (deletion.pending || deletion.documentPending)) }
          await save(key, previous!)
        }
        else if (previous) await save(key, previous)
        return { ...(mission ? { mission: projectMissionState(mission) } : {}), cleanups,
          ...(previous ? { receipt: previous } : request.requestID ? { uncertain: true } : {}) }
      }
      const { retry: _retry, ...fields } = request
      const original = { tool: command.tool, input: fields } as ProjectToolCommand
      if (previous) {
        if (!isDeepStrictEqual(previous.command, original)) throw new MissionControlError("Mission request ID already used", "request-conflict")
        if (previous.state !== "pending" || !request.retry) return { receipt: previous }
        if (!previous.retryable) return { receipt: previous }
      }
      if (request.retry && !previous) throw new MissionControlError("Read the original partial Mission request", "control-pending")
      const before = await observe()
      if (before.mission?.control?.pending.length && before.mission.control.requestID !== request.requestID
        && !(command.tool === "control" && command.input.action === "stop"))
        throw new MissionControlError("Read the original pending Mission control", "control-pending")
      const pending = await storage.get(pendingKey)
      if (pending !== undefined && pending !== key) {
        const held = typeof pending === "string" ? await readReceipt(pending) : undefined
        if (!held || held.state === "pending") {
          const { mission, state } = await observe()
          const original = held && lifecycleReceipt(mission, held.command)
          const independent = held && held.command.tool !== "delete"
            && !(held.command.tool === "control" && ["play", "resume", "pause", "interrupt", "stop"].includes(held.command.input.action))
          const stopping = command.tool === "control" && command.input.action === "stop" && mission?.status === "active"
            && mission.revision === request.expectedRevision && !state.controlUnavailable && (original?.pending.length || independent)
          if (!stopping) throw new MissionControlError("Read the original pending Mission request", "control-pending")
        }
      }
      // Recovery is deduplicated by the domain's mission/revision/target contract,
      // independently of the caller's request ID.
      const recoveryKey = command.tool === "control" && ["recover-coordinator", "recover-report"].includes(command.input.action)
        ? `${base}recovery-${hash(JSON.stringify([request.expectedRevision, request.action, command.input.taskKey]))}` : undefined
      if (!previous && recoveryKey) {
        const recovery = await readReceipt(recoveryKey)
        if (recovery && recovery.state !== "refused") {
          const alias = { ...recovery, command: original }
          await save(key, alias)
          return { receipt: alias }
        }
      }
      if (command.tool === "control" && command.input.action === "request-update") {
        const { mission, state } = await observe()
        if (!mission || state.controlUnavailable || !missionAcceptsCoordinatorMessage(mission))
          throw new MissionControlError("Mission briefing admission unavailable", "mission-not-running")
        if (mission.revision !== request.expectedRevision)
          throw new MissionControlError("Mission changed; reload before requesting an update", "revision-conflict")
      }
      const receipt: Receipt = { command: original, state: "pending" }
      await save(key, receipt)
      await storage.set(pendingKey, key)
      if (recoveryKey) await save(recoveryKey, receipt)
      try {
        let result: Record<string, unknown>
        if (command.tool === "delete") {
          const deleted = await control.delete({ missionID: request.missionID, requestID: request.requestID!,
            expectedRevision: request.expectedRevision!, deleteManagedSessions: command.input.deleteManagedSessions })
          result = { deleted: deleted.deleted }
        } else if (command.tool === "configure") {
          if (!command.input.objective) throw new Error("Mission text required")
          const edited = await control.update({ missionID: request.missionID, requestID: request.requestID!,
            expectedRevision: request.expectedRevision!, objective: command.input.objective, notes: command.input.notes })
          result = projectMissionState(edited.mission)
        } else if (command.input.action === "request-update") {
          result = await input.update(proof) as Record<string, unknown>
        } else if (command.input.action === "recover-coordinator" || command.input.action === "recover-report") {
          const recovered = await control.recover({ missionID: request.missionID, expectedRevision: request.expectedRevision!,
            target: command.input.action === "recover-coordinator" ? "coordinator" : "report", taskKey: command.input.taskKey })
          result = { ...projectMissionState(recovered.mission), admitted: true }
        } else {
          const changed = await control.lifecycle({ missionID: request.missionID, requestID: request.requestID!,
            expectedRevision: request.expectedRevision!, action: missionControlAction(command.input.action),
            ...(command.input.action === "pause" ? { graceful: true } : {}) })
          result = projectMissionState(changed.mission)
        }
        receipt.state = "completed"; receipt.result = JSON.parse(JSON.stringify(result))
      } catch (error) {
        if (error instanceof MissionControlError) {
          receipt.code = error.code
          if (!["control-pending", "cleanup-pending", "recovery-unknown"].includes(error.code)) receipt.state = "refused"
        }
      }
      await save(key, receipt)
      if (recoveryKey) await save(recoveryKey, receipt)
      return { receipt }
    })
  }
}
