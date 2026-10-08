import { authorityDigest, canonicalAuthority } from "./authority-protocol"
import { controlOperationID } from "./receipt-identity"
import { RECURRENCE_SOURCE_CONTEXT_HEADER } from "./recurrence-read-budget"
import { MISSION_LIFECYCLE_TEXT_LIMIT, recurrenceStartText } from "./lifecycle-input"
import type { RecurrenceDocument } from "./recurrence-contract"

export type PassageSource = { conversationID: string; directory: string; workspaceID?: string;
  afterMessageID: string | null; messages: Array<{ id: string; type: string; text: string; nativeDigest: string;
    completedAt?: number; needsDecision?: "source-input-capacity" }> }

/** Bounded untrusted source context. No signed effects, tool inputs or outputs. */
export function passageStartInput(document: RecurrenceDocument,
  identity: { missionID: string; coordinatorSessionID: string; passageID: string; messageID: string }, sources: readonly PassageSource[]) {
  if (!Array.isArray(sources) || sources.length !== document.config.watchedConversationIDs.length) throw new Error("Passage source coverage differs")
  for (const [index, source] of sources.entries()) {
    const cursor = document.cursors.find(cursor => cursor.conversationID === source.conversationID)
    if (source.conversationID !== document.config.watchedConversationIDs[index]
      || !document.config.roots.some(root => root.directory === source.directory)
      || source.afterMessageID !== (cursor?.messageID ?? null)
      || cursor?.locationDigest !== undefined && cursor.locationDigest !== recurrenceSourceLocationDigest(source)
      || !Array.isArray(source.messages) || source.messages.length > 32
      || new Set(source.messages.map((message: PassageSource["messages"][number]) => message.id)).size !== source.messages.length
      || source.messages.some((message: PassageSource["messages"][number], index: number) => typeof message.id !== "string" || typeof message.text !== "string"
        || message.text.length > 16_384 || message.id === source.afterMessageID
        || message.needsDecision !== undefined && (message.needsDecision !== "source-input-capacity" || index !== source.messages.length - 1)))
      throw new Error("Passage source identity differs")
  }
  const text = recurrenceStartText(document.config) + (sources.length ? RECURRENCE_SOURCE_CONTEXT_HEADER + canonicalAuthority(sources, 48 * 1024) : "")
  if (text.length > MISSION_LIFECYCLE_TEXT_LIMIT) throw new Error("Recurrence source input capacity")
  return { sessionID: identity.coordinatorSessionID, id: identity.messageID, text,
    description: "CodeNomad recurring mission start", delivery: "queue" as const, resume: true as const,
    metadata: { "codenomad.mission": { version: 1 as const, missionID: identity.missionID, kind: "lifecycle" as const,
      operationID: controlOperationID(identity.missionID, identity.passageID), taskMode: document.config.taskMode,
      recurrence: { passageID: identity.passageID, messageID: identity.messageID, coordinatorSessionID: identity.coordinatorSessionID } } } }
}

export function passageSourceCursors(sources: readonly PassageSource[]) {
  return sources.flatMap(source => {
    const messageID = source.messages.filter(message => !message.needsDecision).at(-1)?.id
    return messageID ? [{ conversationID: source.conversationID, messageID, locationDigest: recurrenceSourceLocationDigest(source) }] : []
  })
}

export function recurrenceSourceLocationDigest(source: { directory: string; workspaceID?: string }) {
  return authorityDigest({ directory: source.directory, workspaceID: source.workspaceID ?? null })
}
