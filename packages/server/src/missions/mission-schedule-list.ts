import { z } from "zod"
import { canonicalAuthority } from "./authority-protocol"
import type { MissionStorage } from "./journal"
import { documentID, MISSION_DOCUMENT_MAX_BYTES } from "./launch-policy"
import { MISSION_DOCUMENT_PREFIX, missionTombstoneSchema, parseMissionDocument, type MissionDocument, type MissionDocumentTombstone } from "./mission-document"
import type { MissionScheduleObservation } from "./mission-schedule-display"
import { stableToken } from "./receipt-identity"
import { missionScheduleView } from "./mission-schedule-view"

export const MISSION_SCHEDULE_PAGE_MAX = 8
const MISSION_SCHEDULE_FILTERED_SCAN_MAX = 64
export const missionScheduleListInput = z.object({ after: documentID.optional(),
  limit: z.number().int().min(1).max(MISSION_SCHEDULE_PAGE_MAX).default(MISSION_SCHEDULE_PAGE_MAX),
  kind: z.literal("schedule").optional() }).strict()

/** One bounded key-ordered page, preserving tombstones for preparation replay. */
export async function readMissionDocumentPage(storage: Pick<MissionStorage, "scan">,
  project: { id: string; canonical: string }, raw: unknown, scanLimit?: number) {
  const input = missionScheduleListInput.parse(raw)
  const limit = scanLimit ?? input.limit
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

/** Display pages omit tombstones while counting them toward capacity and cursor progress.
 * When `kind: "schedule"` is requested, a wider bounded scan skips tombstones and one-time
 * documents so recurring schedules load without empty intermediate pages. */
export async function readMissionSchedulePage(storage: Pick<MissionStorage, "scan">,
  project: { id: string; canonical: string }, raw: unknown, observe?: (doc: MissionDocument) => Promise<MissionScheduleObservation>) {
  const input = missionScheduleListInput.parse(raw)
  const filtered = input.kind === "schedule"
  const page = await readMissionDocumentPage(storage, project, input, filtered ? MISSION_SCHEDULE_FILTERED_SCAN_MAX : undefined)
  const schedules: NonNullable<ReturnType<typeof missionScheduleView>["document"]>[] = []
  let next = page.next
  for (let index = 0; index < page.documents.length; index++) {
    const doc = page.documents[index]!
    if ("deletedAt" in doc) continue
    if (filtered && doc.oneTime && !doc.dormantJournal) continue
    schedules.push(missionScheduleView(doc, undefined, await observe?.(doc)).document!)
    if (schedules.length === input.limit) {
      next = index + 1 < page.documents.length || page.next !== undefined ? doc.id : undefined
      break
    }
  }
  return { version: 1 as const, projectID: project.id, schedules, ...(next === undefined ? {} : { next }) }
}
export type MissionScheduleList = Awaited<ReturnType<typeof readMissionSchedulePage>>
