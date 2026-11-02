import { canonicalAuthority } from "../../missions/authority-protocol"
import { missionCheckpointsSchema, missionSourceKey, type MissionDocument, type MissionSourceCheckpoint } from "../../missions/mission-document"
import { documentWatchCheckpoint, documentWatchCheckpointSchema, documentWatchKey } from "../../missions/mission-document-passage-input"
import { recurrenceInputBudget, recurrenceSourceContextLimit } from "../../missions/recurrence-read-budget"
import { recurrenceSourceLocationDigest, type PassageSource } from "../../missions/recurrence-input"
import { MISSION_SCHEDULE_CARRIER_SESSION_PREFIX } from "../../missions/mission-schedule-carrier-identity"
import { nativePassageMessageDigest, type MissionNativeService } from "./native-service-adapter"
import type { MissionConditionRead } from "./native-mission-condition-reader"
import type { NativeSourceFence } from "./native-source-fence"

export type QualifiedDocumentSourceSnapshot = { changed: boolean; checkpoints: MissionSourceCheckpoint[]; current(): true; revalidate?(): Promise<void> }
export type DocumentConditionReader = (document: MissionDocument) => Promise<MissionConditionRead>

/** Native stable prefixes and condition proofs share one frozen pending snapshot.
 * New sources baseline before Play; retained checkpoints survive remove/re-add. */
export async function prepareNativeDocumentSources(doc: MissionDocument, native: MissionNativeService, signal: AbortSignal,
  current: () => true, conditionReader?: DocumentConditionReader, fence?: NativeSourceFence, initialContext = false): Promise<QualifiedDocumentSourceSnapshot> {
  const config = doc.configuration, condition = config.launch.condition, guards: (() => true)[] = [current, native.assertCurrent]
  const observed = doc.firstPlayedAt === null ? { ...doc, checkpoints: [] } : doc
  if (fence) guards.push(fence.current)
  const checkpoints: MissionSourceCheckpoint[] = [], sources: PassageSource[] = []
  let revalidate: (() => Promise<void>) | undefined
  let changed = !condition
  if (condition && condition.kind !== "conversation-message") {
    if (!conditionReader) throw new Error("Qualified Mission condition reader unavailable")
    const result = await conditionReader(structuredClone(observed))
    if (result.checkpoint.key !== missionSourceKey(condition) || result.checkpoint.kind !== condition.kind) throw new Error("Mission condition proof incomplete")
    guards.push(result.current); checkpoints.push(result.checkpoint); changed = result.changed
    revalidate = result.revalidate
  }
  const ids = [...new Set([...config.watchedConversationIDs, ...(condition?.kind === "conversation-message" ? [condition.conversationID] : [])])]
  const budget = { consigne: config.objective, roots: config.roots, watchedConversationIDs: ids }
  if (!recurrenceInputBudget(budget).sufficient) throw new Error("Document watched input capacity")
  for (const conversationID of ids) {
    signal.throwIfAborted(); current(); fence?.conversation(conversationID)
    const old = observed.checkpoints.find(item => item.key === documentWatchKey(conversationID))
    let cursor = old && documentWatchCheckpointSchema.parse(old.value)
    const source = await native.get({ sessionID: conversationID }, { signal })
    if (source.id !== conversationID) throw new Error("Document watched ancestry differs")
    const seen = new Set<string>()
    let ancestor = source
    for (;;) {
      signal.throwIfAborted(); current()
      const marker = ancestor.metadata?.["codenomad.mission"] as { missionID?: string; document?: { missionID?: string } } | undefined
      if (seen.has(ancestor.id) || seen.size > 32 || ancestor.projectID !== doc.projectID
        || !config.roots.some(root => root.directory === ancestor.location.directory)
        || ancestor.location.directory !== source.location.directory || ancestor.location.workspaceID !== source.location.workspaceID
        || ancestor.id.startsWith(MISSION_SCHEDULE_CARRIER_SESSION_PREFIX) || ancestor.metadata?.["codenomad.schedule-carrier"]
        || marker?.missionID === doc.id || marker?.document?.missionID === doc.id || doc.oneTime?.coordinatorSessionID === ancestor.id
        || doc.pending?.coordinatorSessionID === ancestor.id || doc.history.some(item => item.coordinatorSessionID === ancestor.id))
        throw new Error("Document watched source moved or excluded")
      seen.add(ancestor.id)
      if (!ancestor.parentID) break
      const parentID = ancestor.parentID
      fence?.conversation(parentID)
      ancestor = await native.get({ sessionID: parentID }, { signal })
      if (ancestor.id !== parentID) throw new Error("Document watched ancestry differs")
    }
    if (old && old.placementDigest !== recurrenceSourceLocationDigest(source.location)) throw new Error("Document watched source moved or excluded")
    if (!old && !initialContext) {
      if (!native.sourceBaseline) throw new Error("Mission message baseline reader unavailable")
      const anchor = await native.sourceBaseline(conversationID, { signal })
      if (anchor) fence?.message(conversationID, anchor.id, nativePassageMessageDigest(anchor))
      cursor = { messageID: anchor?.id ?? null, nativeDigest: anchor ? nativePassageMessageDigest(anchor) : null }
    }
    if (cursor?.messageID) {
      fence?.message(conversationID, cursor.messageID, cursor.nativeDigest!)
      const anchor = await native.message({ sessionID: conversationID, messageID: cursor.messageID }, { signal })
      if (!anchor || !cursor.nativeDigest || nativePassageMessageDigest(anchor) !== cursor.nativeDigest) throw new Error("Document watched anchor changed")
    }
    const messages = !old && !initialContext ? [] : await native.sourceMessages({ sessionID: conversationID, ...source.location,
      afterMessageID: cursor?.messageID ?? null, ...(cursor?.nativeDigest ? { afterNativeDigest: cursor.nativeDigest } : {}),
      limit: 32, contextLimit: recurrenceSourceContextLimit(budget, sources.map(source => source.messages)), excludeTechnical: true }, { signal }, current, current)
    if (messages.some(message => message.needsDecision)) throw new Error("Document source input capacity")
    if (initialContext && messages.length === 32 && messages.every(message => message.type === "technical")) throw new Error("Mission message prefix capacity")
    for (const message of messages) fence?.message(conversationID, message.id, message.nativeDigest)
    const frozen = { conversationID, ...source.location, afterMessageID: cursor?.messageID ?? null, messages }
    sources.push(frozen)
    const prior = old ?? { key: documentWatchKey(conversationID), kind: "conversation-message" as const,
      placementDigest: recurrenceSourceLocationDigest(source.location), value: cursor ?? { messageID: null, nativeDigest: null } }
    checkpoints.push(documentWatchCheckpoint(frozen, prior))
    if (condition?.kind === "conversation-message" && condition.conversationID === conversationID) {
      changed = !!old && messages.some(message => ["user", "synthetic", "assistant"].includes(message.type))
      if (!changed && messages.length === 32) throw new Error("Mission message prefix capacity")
    }
  }
  canonicalAuthority(checkpoints, 64 * 1024)
  const assertCurrent = (): true => { signal.throwIfAborted(); for (const guard of guards) guard(); return true }
  assertCurrent()
  return { changed, checkpoints: missionCheckpointsSchema.parse(checkpoints), current: assertCurrent,
    ...(revalidate ? { revalidate: async () => { await revalidate!(); assertCurrent() } } : {}) }
}
