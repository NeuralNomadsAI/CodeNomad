import { z } from "zod"
import { canonicalAuthority } from "./authority-protocol"
import type { MissionStorage } from "./journal"
import { documentID, MISSION_DOCUMENT_MAX_BYTES } from "./launch-policy"
import { MISSION_DOCUMENT_PREFIX, missionTombstoneSchema, parseMissionDocument, type MissionDocument, type MissionDocumentTombstone } from "./mission-document"
import { stableToken } from "./receipt-identity"

const PAGE_MAX = 8
const pageInput = z.object({ after: documentID.optional(), limit: z.number().int().min(1).max(PAGE_MAX).default(PAGE_MAX) }).strict()

/** One bounded key-ordered page, preserving tombstones for preparation replay. */
export async function readMissionDocumentPage(storage: Pick<MissionStorage, "scan">,
  project: { id: string; canonical: string }, raw: unknown) {
  const input = pageInput.parse(raw), limit = input.limit
  const prefix = `${MISSION_DOCUMENT_PREFIX}/project/${stableToken(`${project.id}\0${project.canonical}`, 24)}/missions/`
  const after = input.after === undefined ? undefined : `${prefix}${input.after}`
  const page = await storage.scan({ prefix, after, limit })
  if (page.entries.length > limit) throw new Error("Mission schedule page exceeds bound")
  let previous = after ?? prefix
  const documents: Array<MissionDocument | MissionDocumentTombstone> = []
  for (const entry of page.entries) {
    if (!entry.key.startsWith(prefix) || entry.key <= previous) throw new Error("Mission schedule page order differs")
    const id = documentID.parse(entry.key.slice(prefix.length))
    previous = entry.key
    const value = JSON.parse(canonicalAuthority(entry.value, MISSION_DOCUMENT_MAX_BYTES))
    if (value && typeof value === "object" && "deletedAt" in value) {
      const tombstone = missionTombstoneSchema.parse(value)
      if (tombstone.id !== id || tombstone.projectID !== project.id || tombstone.projectCanonical !== project.canonical)
        throw new Error("Foreign Mission schedule tombstone")
      documents.push(tombstone)
      continue
    }
    const doc = parseMissionDocument(value, { id, projectID: project.id, projectCanonical: project.canonical })
    documents.push(doc)
  }
  if (page.next !== undefined && (!page.entries.length || page.next !== previous))
    throw new Error("Mission schedule cursor differs")
  return { documents,
    ...(page.next === undefined ? {} : { next: documentID.parse(page.next.slice(prefix.length)) }) }
}
