import { z } from "zod"
import { canonicalAuthority } from "./authority-protocol"
import { controlOperationID } from "./receipt-identity"
import { missionSourceKey, type MissionDocument, type MissionSourceCheckpoint } from "./mission-document"
import { recurrenceSourceLocationDigest, type PassageSource } from "./recurrence-input"
import { MISSION_LIFECYCLE_TEXT_LIMIT } from "./lifecycle-input"
import { RECURRENCE_SOURCE_CONTEXT_HEADER } from "./recurrence-read-budget"

const id = z.string().min(1).max(240)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const documentPassageSourceSchema = z.object({ conversationID: id, directory: z.string().min(1).max(4096), workspaceID: id.optional(),
  afterMessageID: id.nullable(), messages: z.array(z.object({ id, type: z.string().min(1).max(64), text: z.string().max(MISSION_LIFECYCLE_TEXT_LIMIT),
    nativeDigest: digest, completedAt: z.number().int().nonnegative().safe().optional(), needsDecision: z.literal("source-input-capacity").optional() }).strict()).max(32),
}).strict().refine(source => new Set(source.messages.map(message => message.id)).size === source.messages.length
  && source.messages.every((message, index) => message.id !== source.afterMessageID && (!message.needsDecision || index === source.messages.length - 1)))
export const documentWatchCheckpointSchema = z.object({ messageID: id.nullable(), nativeDigest: digest.nullable(), source: documentPassageSourceSchema.optional() }).strict()

export function documentWatchKey(conversationID: string) { return missionSourceKey({ kind: "conversation-message", conversationID }) }
export function documentWatchCheckpoint(source: PassageSource, previous?: MissionSourceCheckpoint): MissionSourceCheckpoint {
  const parsed = documentPassageSourceSchema.parse(source)
  const last = parsed.messages.filter(message => !message.needsDecision).at(-1)
  const old = previous ? documentWatchCheckpointSchema.parse(previous.value) : undefined
  return { key: documentWatchKey(source.conversationID), kind: "conversation-message", placementDigest: recurrenceSourceLocationDigest(source),
    value: { messageID: last?.id ?? old?.messageID ?? null, nativeDigest: last?.nativeDigest ?? old?.nativeDigest ?? null, source: parsed } }
}

/** Full source prefix lives in the pending checkpoint before any native effect.
 * A restart rebuilds these exact bytes, never newer conversation prose. */
export function documentPassageSources(doc: { pending: Pick<NonNullable<MissionDocument["pending"]>, "configuration" | "checkpoints"> | null }): PassageSource[] {
  if (!doc.pending) throw new Error("Document passage unavailable")
  const config = doc.pending.configuration
  return config.watchedConversationIDs.map(conversationID => {
    const checkpoint = doc.pending!.checkpoints.find(item => item.key === documentWatchKey(conversationID))
    const value = checkpoint && documentWatchCheckpointSchema.parse(checkpoint.value)
    const source = value?.source
    if (!source || source.conversationID !== conversationID || checkpoint!.kind !== "conversation-message"
      || checkpoint!.placementDigest !== recurrenceSourceLocationDigest(source)
      || !config.roots.some(root => root.directory === source.directory)) throw new Error("Frozen document source coverage unavailable")
    return source
  })
}

export function documentPassageStartInput(doc: MissionDocument) {
  const pending = doc.pending
  if (!pending) throw new Error("Document passage unavailable")
  const sources = documentPassageSources(doc)
  const text = pending.configuration.objective + (sources.length ? RECURRENCE_SOURCE_CONTEXT_HEADER + canonicalAuthority(sources, 48 * 1024) : "")
  if (!text.length || text.length > MISSION_LIFECYCLE_TEXT_LIMIT) throw new Error("Document passage input capacity")
  return { sessionID: pending.coordinatorSessionID, id: pending.messageID, text, description: "CodeNomad scheduled mission start",
    delivery: "queue" as const, resume: true as const,
    metadata: { "codenomad.mission": { version: 1, missionID: pending.missionID, kind: "lifecycle", taskMode: pending.configuration.taskMode,
      operationID: controlOperationID(pending.missionID, pending.id), document: { missionID: doc.id, passageID: pending.id } } } }
}
