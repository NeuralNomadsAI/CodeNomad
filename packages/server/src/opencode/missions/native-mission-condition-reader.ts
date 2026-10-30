import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { MissionJournal, MISSION_JOURNAL_STORAGE_PREFIX, type MissionStorage } from "../../missions/journal"
import { MISSION_DOCUMENT_PREFIX, missionSourceKey, type MissionDocument, type MissionSourceCheckpoint } from "../../missions/mission-document"
import type { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { isolatedMissionPassageJournal } from "../../missions/mission-document-passage-storage"
import { readMissionLocalSource } from "../../missions/mission-local-sources"
import { stableToken } from "../../missions/receipt-identity"
import { requiresMissionCalendar } from "../../missions/launch-policy"
import type { MissionMap } from "../../missions/model"
import { acquireNativeSourceFence, type NativeSourceFence } from "./native-source-fence"
import { acquireNativePassageObservation, type NativePassageObservation } from "./native-passage-observation"
import { observePassageFamilySettlement } from "./native-recurrence-settlement"
import { acquireMissionNativeService, type MissionNativeRunner, type MissionNativeService } from "./native-service-adapter"
import { acquireNativeSourceObservation } from "./native-source-observation"

type Condition = NonNullable<MissionDocument["configuration"]["launch"]["condition"]>
export type MissionConditionRead = { checkpoint: MissionSourceCheckpoint; changed: boolean; current(): true; revalidate?(): Promise<void> }
const same = (a: unknown, b: unknown) => canonicalAuthority(a, 256 * 1024) === canonicalAuthority(b, 256 * 1024)
const unavailable = (): never => { throw new Error("Mission event source coverage unavailable") }
const sourceKey = (doc: MissionDocument, id: string) => `${MISSION_DOCUMENT_PREFIX}/project/${stableToken(`${doc.projectID}\0${doc.projectCanonical}`, 24)}/missions/${id}`

/** Read one explicit dependency chain, under the caller's project document
 * exclusion. Missing/deleted edges and over-bound coverage remain blocking. */
export async function assertMissionSourceAcyclic(target: MissionDocument, store: Pick<NativeMissionDocumentStore, "read">,
  pin: (id: string) => void = () => {}) {
  let condition = target.configuration.launch.condition
  const seen = new Set([target.id])
  while (condition?.kind === "schedule-success" || condition?.kind === "mission-completed") {
    if (seen.has(condition.missionID) || seen.size >= 64) throw new Error("Mission source dependency cycle or capacity")
    seen.add(condition.missionID); pin(condition.missionID)
    const source = await store.read(condition.missionID)
    if (!source) { if (condition.kind === "mission-completed") return; return unavailable() }
    if ("deletedAt" in source || source.deletion) return unavailable()
    condition = source.configuration.launch.condition
  }
}

export function createMissionConditionReader(input: {
  store: Pick<NativeMissionDocumentStore, "read">; storage: MissionStorage; native: MissionNativeService;
  observation: NativePassageObservation; fence(): NativeSourceFence; signal: AbortSignal; current(): true
  observationFor?: (location: { directory: string; workspaceID?: string }, projectID: string, canonical: string) => Promise<NativePassageObservation>
}) {
  return async (doc: MissionDocument): Promise<MissionConditionRead> => {
    const condition = doc.configuration.launch.condition
    if (!condition || condition.kind === "conversation-message") return unavailable()
    const fence = input.fence(), guards: (() => true)[] = [input.current, fence.current]
    const current = (): true => { input.signal.throwIfAborted(); for (const guard of guards) guard(); return true }
    await assertMissionSourceAcyclic(doc, input.store, id => fence.document(sourceKey(doc, id)))
    const previous = doc.checkpoints.find(item => item.key === missionSourceKey(condition))
    if (condition.kind === "branch-commits" || condition.kind === "files-changed") {
      const root = condition.kind === "branch-commits" ? condition.directory : input.native.location.directory
      if (!doc.configuration.roots.some(item => item.directory === root)) return unavailable()
      const read = await readMissionLocalSource(condition, root, previous, input.signal)
      guards.push(read.current); current()
      return { ...read, current }
    }
    const source = await input.store.read(condition.missionID)
    if (source && ("deletedAt" in source || source.deletion || source.projectID !== doc.projectID || source.projectCanonical !== doc.projectCanonical
      || !source.configuration.roots.some(root => doc.configuration.roots.some(allowed => allowed.directory === root.directory)))) return unavailable()
    const document = source as MissionDocument | undefined
    const journal = new MissionJournal(input.storage, doc.projectID, doc.projectCanonical)
    let historical: Awaited<ReturnType<MissionJournal["missionView"]>> | undefined
    if (!document) {
      fence.journal(`${MISSION_JOURNAL_STORAGE_PREFIX}/${journal.projectToken}/${condition.missionID}/`)
      historical = await journal.missionView(condition.missionID)
      if (historical.discardedEvents || historical.controlUnavailable || historical.notificationUnavailable || !historical.mission) return unavailable()
    }
    const historicalCoordinator = historical?.mission?.actors.find(actor => actor.sessionId === historical.mission!.coordinatorSessionId)
    const placement = document?.oneTime?.location ?? (document ? { directory: document.configuration.roots[0].directory } : historicalCoordinator?.location)
    if (!placement || !doc.configuration.roots.some(allowed => allowed.directory === placement.directory)) return unavailable()
    if (historical?.mission) {
      fence.conversation(historical.mission.coordinatorSessionId)
      const root = await input.native.get({ sessionID: historical.mission.coordinatorSessionId }, { signal: input.signal })
      if (root.id !== historical.mission.coordinatorSessionId || root.projectID !== doc.projectID || root.parentID || !same(root.location, placement)) return unavailable()
    }
    const placementDigest = stableToken(canonicalAuthority([doc.projectID, doc.projectCanonical, condition.missionID, placement.directory,
      "workspaceID" in placement ? placement.workspaceID ?? null : null]), 64)
    if (previous && (previous.kind !== condition.kind || previous.placementDigest !== placementDigest)) return unavailable()
    const checkpoint = (value: MissionSourceCheckpoint["value"]): MissionSourceCheckpoint => ({ key: missionSourceKey(condition), kind: condition.kind, placementDigest, value })
    const observe = async (mission: MissionMap, messageID: string) => {
      if (mission.projectID !== doc.projectID || mission.status !== "completed" || mission.runState === "stopped") return undefined
      const root = await input.native.get({ sessionID: mission.coordinatorSessionId }, { signal: input.signal })
      if (root.id !== mission.coordinatorSessionId || root.projectID !== doc.projectID || root.parentID
        || !doc.configuration.roots.some(allowed => allowed.directory === root.location.directory)) return unavailable()
      if (root.location.directory !== placement.directory || root.location.workspaceID !== ("workspaceID" in placement ? placement.workspaceID : undefined)) return unavailable()
      const observation = root.location.directory === input.native.location.directory && root.location.workspaceID === input.native.location.workspaceID
        ? input.observation : await input.observationFor?.(root.location, doc.projectID, doc.projectCanonical)
      if (!observation) return unavailable()
      guards.push(observation.assertCurrent)
      for (const id of new Set([root.id, ...mission.actors.map(actor => actor.sessionId)]))
        fence.family(id, id === root.id ? messageID : mission.tasks.find(task => task.actorSessionId === id)?.admissionId)
      let uncertain = false
      const result = await observePassageFamilySettlement({ projectID: doc.projectID, mission, messageID, coordinatorSessionID: root.id,
        native: observation, directory: root.location.directory, workspaceID: root.location.workspaceID, signal: input.signal, current: input.current,
        uncertain: () => { uncertain = true } })
      if (uncertain) return unavailable()
      return result?.outcome === "completed" ? { ...result.proof, outcome: "completed" as const,
        journalDigest: stableToken(canonicalAuthority(JSON.parse(JSON.stringify(mission)), 256 * 1024), 64) } : undefined
    }
    const passage = async (receipt: MissionDocument["history"][number]) => {
      if (!document) return unavailable()
      const physical = `${MISSION_DOCUMENT_PREFIX}/passages/${journal.projectToken}/${document.id}/${receipt.id}/${receipt.missionID}/`
      fence.journal(physical)
      const scoped = isolatedMissionPassageJournal(input.storage, { projectID: doc.projectID, projectCanonical: doc.projectCanonical,
        ownerID: document.id, passageID: receipt.id, storagePrefix: MISSION_DOCUMENT_PREFIX }, input.current)
      const view = await scoped.journal.missionView(receipt.missionID)
      if (view.discardedEvents || view.controlUnavailable || view.notificationUnavailable || !view.mission
        || view.mission.coordinatorSessionId !== receipt.coordinatorSessionID) return unavailable()
      const proof = await observe(view.mission, receipt.messageID)
      return proof && { passageID: receipt.id, missionID: receipt.missionID, ...proof }
    }
    if (condition.kind === "schedule-success") {
      if (!document || document.oneTime || !requiresMissionCalendar(document.configuration.launch)) return unavailable()
      const old = previous?.value as { count?: number; lastPassageID?: string | null } | undefined
      if (old && (!Number.isSafeInteger(old.count) || old.count! < 0 || old.count! > document.successfulCount
        || (old.count === 0) !== (old.lastPassageID === null) || old.count! > 0 && typeof old.lastPassageID !== "string")) return unavailable()
      const count = document.successfulCount, lastPassageID = document.lastSuccessfulPassageID
      const delta = old ? count - old.count! : 0, successes = document.history.filter(item => item.outcome === "completed")
      if (delta > successes.length || old && count === old.count && old.lastPassageID !== lastPassageID) return unavailable()
      const oldReceipt = successes.at(successes.length - delta - 1)
      if (old && successes.length > delta && oldReceipt?.id !== old.lastPassageID) return unavailable()
      const proofs = []
      for (const receipt of successes.slice(successes.length - delta)) {
        const proof = await passage(receipt)
        if (!proof) { current(); return { checkpoint: previous!, changed: false, current } }
        proofs.push(proof)
      }
      const result = checkpoint({ count, lastPassageID, proofs })
      current()
      return { checkpoint: result, changed: delta > 0, current }
    }
    if (document && !document.oneTime && ["every", "cron", "multi"].includes(document.configuration.launch.timing.kind)) return unavailable()
    let completed = false, proof: unknown = null
    if (document && !document.oneTime) {
      const receipt = document.history.find(item => item.outcome === "completed")
      if (receipt) { proof = await passage(receipt) ?? null; completed = proof !== null }
    } else {
      if (!historical) fence.journal(`${MISSION_JOURNAL_STORAGE_PREFIX}/${journal.projectToken}/${condition.missionID}/`)
      const view = historical ?? await journal.missionView(condition.missionID), mission = view.mission
      if (view.discardedEvents || view.controlUnavailable || view.notificationUnavailable || !mission) return unavailable()
      const firstAdmission = document?.oneTime?.firstPlay?.messageID ?? view.events.flatMap(event => event.type === "mission.control-applied"
        && event.sessionID === mission.coordinatorSessionId && event.nativeAcknowledgement?.action === "start" ? [event.nativeAcknowledgement.admission.id] : [])[0]
      if (mission.status === "completed") {
        if (!firstAdmission) return unavailable()
        proof = await observe(mission, firstAdmission) ?? null; completed = proof !== null
      }
    }
    const old = previous?.value as { completed?: boolean } | undefined
    if (old && typeof old.completed !== "boolean") return unavailable()
    if (old?.completed && !completed) return unavailable()
    const result = checkpoint({ completed, proof: proof as MissionSourceCheckpoint["value"] })
    current()
    return { checkpoint: result, changed: !!previous && !old!.completed && completed, current }
  }
}

export const acquireNativeMissionConditionReader = Effect.fn("missions.acquireConditionReader")(function* (
  ctx: Plugin.Context, store: NativeMissionDocumentStore, run: MissionNativeRunner, signal: AbortSignal, current: () => true,
) {
  const native = yield* acquireMissionNativeService(current, run)
  const observation = yield* acquireNativePassageObservation(undefined, run)
  const fence = yield* acquireNativeSourceFence(current)
  const observationFor = yield* acquireNativeSourceObservation(run, current)
  const storage: MissionStorage = { get: key => run(ctx.storage.get(key)) as ReturnType<MissionStorage["get"]>,
    scan: value => run(ctx.storage.scan(value)) as ReturnType<MissionStorage["scan"]>, set: async () => { throw new Error("Read-only event source") } }
  return createMissionConditionReader({ store, storage, native, observation, fence, signal, current, observationFor })
})
