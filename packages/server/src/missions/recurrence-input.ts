import { authorityDigest, canonicalAuthority, rejectAuthority } from "./authority-protocol"
import { recurrenceEffectID, type RecurrenceAuthorityArchive, type RecurrenceChildRecord, type RecurrenceEffect, type RecurrenceEffectReceipt } from "./recurrence-authority-contract"
import { controlOperationID } from "./receipt-identity"
import { RECURRENCE_SOURCE_CONTEXT_HEADER } from "./recurrence-read-budget"
import { MISSION_LIFECYCLE_TEXT_LIMIT, recurrenceStartText } from "./lifecycle-input"

export function recurrenceReadEvidence(effect: RecurrenceEffect, messages: NonNullable<RecurrenceEffectReceipt["sourceMessages"]>) {
  return `rread_${authorityDigest({ effect, messages }).slice(0, 48)}`
}

export function recurrenceSourceLocationDigest(source: { directory: string; workspaceID?: string }) {
  return authorityDigest({ directory: source.directory, workspaceID: source.workspaceID ?? null })
}

/** Archived, bounded reference context; native transcripts remain the output owner.
 * Never project tool inputs/results, provider state, credentials or file/image bytes. */
export function recurrenceSources(child: Readonly<RecurrenceChildRecord>) {
  const watches = child.parent.body.config.watchedConversationIDs
  const reads = child.effects.filter(item => item.effect.kind === "inbox-read")
  if (reads.length !== watches.length) rejectAuthority("observation-unavailable")
  const result = watches.map(conversationID => {
    const matches = reads.filter(item => item.effect.kind === "inbox-read" && item.effect.conversationID === conversationID)
    const item = matches[0], effect = item?.effect, receipt = item?.receipt
    if (matches.length !== 1 || effect?.kind !== "inbox-read" || !effect.read || !receipt?.sourceMessages
      || receipt.outcome !== "applied" || receipt.operationID !== item.operationID
      || receipt.evidenceID !== recurrenceReadEvidence(effect, receipt.sourceMessages)
      || receipt.sourceMessages.length > effect.read.limit
      || canonicalAuthority(receipt.sourceMessages, 64 * 1024).length > effect.read.contextLimit
      || new Set(receipt.sourceMessages.map(message => message.id)).size !== receipt.sourceMessages.length
      || receipt.sourceMessages.some((message, index) => message.needsDecision && index !== receipt.sourceMessages!.length - 1)
      || receipt.sourceMessages.some(message => message.id === effect.read!.afterMessageID)) rejectAuthority("observation-unavailable")
    return { conversationID, ...effect.read, messages: receipt.sourceMessages }
  })
  canonicalAuthority(result, 48 * 1024)
  return result
}

/** Shared exact input for admission, its invocation fence and terminal observation.
 * The signed consigne is unchanged; source prose is quoted as untrusted data. */
export function recurrenceInput(child: Readonly<RecurrenceChildRecord>) {
  const grant = child.grant, config = child.parent.body.config, sources = recurrenceSources(child)
  const text = recurrenceStartText(config) + (sources.length ? RECURRENCE_SOURCE_CONTEXT_HEADER + canonicalAuthority(sources, 48 * 1024) : "")
  if (text.length > MISSION_LIFECYCLE_TEXT_LIMIT) rejectAuthority("capacity")
  return { sessionID: grant.coordinatorSessionID, id: grant.messageID, text,
    description: "CodeNomad recurring mission start", delivery: "queue" as const, resume: true as const,
    metadata: { "codenomad.mission": { version: 1 as const, missionID: grant.missionID, kind: "lifecycle" as const,
      operationID: controlOperationID(grant.missionID, grant.passage.id), taskMode: config.taskMode,
      recurrence: { grantID: grant.grantID, passageID: grant.passage.id, messageID: grant.messageID,
        coordinatorSessionID: grant.coordinatorSessionID } } } }
}

/** Current readers require the same complete frozen input as native admission. */
export function assertRecurrenceStartupReceipts(child: Readonly<RecurrenceChildRecord>) {
  const input = recurrenceInput(child), grant = child.grant
  const startup: RecurrenceEffect[] = [{ kind: "create" }, { kind: "start" },
    { kind: "coordinator-message", messageID: grant.messageID, contentDigest: authorityDigest(input.text) }]
  if (child.effects.filter(item => ["create", "start", "coordinator-message"].includes(item.effect.kind)).length !== startup.length)
    rejectAuthority("observation-unavailable")
  for (const effect of startup) {
    const operationID = recurrenceEffectID(grant, effect), matches = child.effects.filter(item => item.operationID === operationID)
    const item = matches[0], receipt = item?.receipt
    if (matches.length !== 1 || canonicalAuthority(item.effect) !== canonicalAuthority(effect)
      || receipt?.operationID !== operationID || receipt.outcome !== "applied"
      || receipt.evidenceID !== (effect.kind === "coordinator-message" ? grant.messageID : grant.coordinatorSessionID))
      rejectAuthority("observation-unavailable")
  }
  return input
}

/** Only call after a positively committed authority archive, never after admission. */
export function recurrenceSourceCursors(archive: Readonly<RecurrenceAuthorityArchive>) {
  const { child, settlement } = archive
  if (settlement.grantID !== child.grant.grantID
    || settlement.effects.length !== child.effects.length || child.effects.some(item => !item.receipt
      || !settlement.effects.some(receipt => canonicalAuthority(receipt) === canonicalAuthority(item.receipt)))) rejectAuthority("observation-unavailable")
  // Positive read/admission/ENV evidence is not model consumption. A qualified
  // failed/stopped archive retires its charged effects, not watched source work.
  if (settlement.outcome !== "completed") return []
  return recurrenceSources(child).flatMap(source => {
    const messageID = source.messages.filter(message => !message.needsDecision).at(-1)?.id
    return messageID ? [{ conversationID: source.conversationID, messageID, locationDigest: recurrenceSourceLocationDigest(source) }] : []
  })
}
