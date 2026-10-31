import { canonicalAuthority } from "../../missions/authority-protocol"
import { missionCheckpointsSchema, missionSourceKey, type MissionDocument, type MissionSourceCheckpoint } from "../../missions/mission-document"
import { documentPassageSources, documentWatchCheckpoint, documentWatchCheckpointSchema, documentWatchKey } from "../../missions/mission-document-passage-input"
import { recurrenceInputBudget, recurrenceSourceContextLimit } from "../../missions/recurrence-read-budget"
import { recurrenceSourceLocationDigest, type PassageSource } from "../../missions/recurrence-input"
import { nativePassageMessageDigest, type MissionNativeService } from "./native-service-adapter"

export type QualifiedDocumentSourceSnapshot = { changed: boolean; checkpoints: MissionSourceCheckpoint[]; current(): true }
export type DocumentConditionReader = (document: MissionDocument) => Promise<QualifiedDocumentSourceSnapshot>

/** Conditions belong to qualified external readers. Missing/unknown coverage never
 * becomes an empty source proof. Additional watches use the existing native stable
 * whole-message prefix reader and freeze its complete bytes in the pending. */
export async function prepareNativeDocumentSources(doc: MissionDocument, native: MissionNativeService, signal: AbortSignal,
  current: () => true, condition?: DocumentConditionReader): Promise<QualifiedDocumentSourceSnapshot> {
  const config = doc.configuration
  if (config.launch.condition) {
    if (!condition) throw new Error("Qualified Mission condition reader unavailable")
    const result = await condition(structuredClone(doc))
    const checkpoints = missionCheckpointsSchema.parse(result.checkpoints)
    if (!checkpoints.some(item => item.key === missionSourceKey(config.launch.condition!) && item.kind === config.launch.condition!.kind))
      throw new Error("Mission condition proof incomplete")
    result.current(); current()
    // Watch input proof must be part of the SAME qualified condition snapshot.
    if (config.watchedConversationIDs.length) {
      const proof = { ...doc, pending: { configuration: config, checkpoints } }
      documentPassageSources(proof)
    }
    return { ...result, checkpoints }
  }
  const budget = { consigne: config.objective, roots: config.roots, watchedConversationIDs: config.watchedConversationIDs }
  if (!recurrenceInputBudget(budget).sufficient) throw new Error("Document watched input capacity")
  const sources: PassageSource[] = [], checkpoints: MissionSourceCheckpoint[] = []
  for (const conversationID of config.watchedConversationIDs) {
    signal.throwIfAborted(); current()
    const old = doc.checkpoints.find(item => item.key === documentWatchKey(conversationID))
    const cursor = old && documentWatchCheckpointSchema.parse(old.value)
    const source = await native.get({ sessionID: conversationID }, { signal })
    if (source.projectID !== doc.projectID || !config.roots.some(root => root.directory === source.location.directory)
      || old && old.placementDigest !== recurrenceSourceLocationDigest(source.location)) throw new Error("Document watched source moved")
    if (cursor?.messageID) {
      const anchor = await native.message({ sessionID: conversationID, messageID: cursor.messageID }, { signal })
      if (!anchor || !cursor.nativeDigest || nativePassageMessageDigest(anchor) !== cursor.nativeDigest) throw new Error("Document watched anchor changed")
    }
    const messages = await native.sourceMessages({ sessionID: conversationID, ...source.location, afterMessageID: cursor?.messageID ?? null,
      ...(cursor?.nativeDigest ? { afterNativeDigest: cursor.nativeDigest } : {}),
      limit: 32, contextLimit: recurrenceSourceContextLimit(budget, sources.map(source => source.messages)) }, { signal }, current, current)
    const frozen = { conversationID, ...source.location, afterMessageID: cursor?.messageID ?? null, messages }
    sources.push(frozen)
    checkpoints.push(documentWatchCheckpoint(frozen, old))
  }
  canonicalAuthority(checkpoints, 64 * 1024)
  current()
  return { changed: true, checkpoints, current: () => { signal.throwIfAborted(); current(); return native.assertCurrent() } }
}
