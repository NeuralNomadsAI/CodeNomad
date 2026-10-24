import type { MissionEvent, MissionTaskNativeCallObservedEvent } from "./model"
import { parseNativeBinding, sameNativeCall } from "./native-report-provenance"
import { stableToken } from "./receipt-identity"
import { parseNativeCallObservation, readNativeCallObservation, type NativeCallObservation, type NativeCallReadClient,
  type NativeCallReadResult, type NativeCallReadTarget, type NativeLogCursor } from "./native-call-observation"

export type NativeCallReconciliationTarget = NativeCallReadTarget & {
  projectID: string; missionID: string; taskKey: string
  /** Immutable admitted native-bound/call-started event timestamp, not task.updatedAt. */
  callCreatedAt: number
}
export type NativeCallReconciliationProof = {
  projectID: string; missionID: string; taskKey: string; childSessionID: string; binding: NativeCallReadTarget["binding"]
  toolName: string; callCreatedAt: number
  nativeIncarnation: string; storageIdentity: string; familyIdentity: string
}
export type NativeObservationPublisher = {
  event(missionID: string, eventID: string): Promise<MissionEvent | undefined>
  /** MUST atomically recheck proof/current invocation, detect identity conflicts,
   * and assign createdAt after the latest journal event and admitted call.
   * Native sequence/timestamps are not journal ordering. */
  append(event: Omit<MissionTaskNativeCallObservedEvent, "createdAt">, proof: NativeCallReconciliationProof): Promise<void>
}

export function nativeCallObservationID(target: Pick<NativeCallReconciliationTarget, "projectID" | "missionID" | "taskKey" | "binding" | "childSessionID">,
  observation: NativeCallObservation): string {
  return `evt_${stableToken(JSON.stringify([target.projectID, target.missionID, target.taskKey, target.binding.generation,
    target.binding.parentSessionID, target.binding.parentMessageID, target.binding.toolCallID, target.childSessionID,
    observation.source.sessionID, observation.source.id]), 28)}`
}

/** Explicit observation publication only. No executor, prompt, report, notification or receipt repair exists here. */
export async function reconcileNativeCallObservation(input: {
  target: NativeCallReconciliationTarget; client: NativeCallReadClient; expectedProof: NativeCallReconciliationProof
  validate: () => Promise<NativeCallReconciliationProof | undefined>; publisher: NativeObservationPublisher
  signal: AbortSignal; publish?: boolean; maxEvents?: number; parentCursor?: NativeLogCursor; childCursor?: NativeLogCursor
}): Promise<NativeCallReadResult & { published: number; existing: number }> {
  input = { ...input }
  const expected = structuredClone(input.expectedProof), target = structuredClone(input.target)
  const check = async () => {
    input.signal.throwIfAborted()
    const proof = await input.validate()
    if (!proof || !parseNativeBinding(proof.binding) || !sameNativeCall(proof.binding, target.binding)
      || !sameNativeCall(expected.binding, target.binding) || proof.projectID !== target.projectID || proof.missionID !== target.missionID
      || proof.taskKey !== target.taskKey || proof.childSessionID !== target.childSessionID
      || proof.toolName !== target.toolName || proof.callCreatedAt !== target.callCreatedAt
      || expected.projectID !== target.projectID || expected.missionID !== target.missionID || expected.taskKey !== target.taskKey
      || expected.childSessionID !== target.childSessionID
      || expected.toolName !== target.toolName || expected.callCreatedAt !== target.callCreatedAt
      || ["nativeIncarnation", "storageIdentity", "familyIdentity"].some(key => {
        const field = key as "nativeIncarnation" | "storageIdentity" | "familyIdentity"
        return !expected[field] || expected[field].length > 240 || expected[field] !== proof[field]
      })) throw new Error("Native observation authority changed/unknown")
  }
  const result = await readNativeCallObservation(input.client, target, { ...input, check })
  let published = 0, existing = 0
  // A bounded slice may publish its exact durable facts; failed/unknown reads
  // discard all facts and checkpoints in the reader. Completion is not inferred.
  if (!input.publish || !result.observations.length) return { ...result, published, existing }
  try {
    await check()
    if (!Number.isSafeInteger(target.callCreatedAt) || target.callCreatedAt < 1) throw new Error("Invalid call event order fence")
    // Prepare/check all identities before any append. The publisher closes the final admission race.
    const pending: Array<Omit<MissionTaskNativeCallObservedEvent, "createdAt">> = []
    for (const observation of result.observations) {
      if (!parseNativeCallObservation(observation)) throw new Error("Invalid observation")
      const event: Omit<MissionTaskNativeCallObservedEvent, "createdAt"> = { version: 1, type: "task.native-call-observed",
        id: nativeCallObservationID(target, observation), projectID: target.projectID, missionID: target.missionID,
        taskKey: target.taskKey, binding: { ...target.binding }, childSessionID: target.childSessionID,
        observation }
      await check()
      const saved = await input.publisher.event(event.missionID, event.id)
      await check()
      if (saved) {
        if (saved.type !== event.type || saved.id !== event.id || saved.version !== event.version
          || saved.missionID !== event.missionID || saved.projectID !== event.projectID || saved.taskKey !== event.taskKey
          || saved.childSessionID !== event.childSessionID || !Number.isSafeInteger(saved.createdAt) || saved.createdAt <= target.callCreatedAt
          || !sameNativeCall(saved.binding, event.binding)
          || JSON.stringify(parseNativeCallObservation(saved.observation)) !== JSON.stringify(parseNativeCallObservation(event.observation))) {
          throw new Error("Native observation identity conflict")
        }
        existing++
      } else pending.push(event)
    }
    for (const event of pending) { await check(); await input.publisher.append(event, expected); published++; await check() }
  } catch {
    result.complete = false; result.reasons.push("native-publication-conflict-or-authority-unknown")
    delete result.parentCursor; delete result.childCursor
  }
  return { ...result, published, existing }
}
