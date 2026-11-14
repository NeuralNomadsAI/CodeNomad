import { z } from "zod"
import { canonicalAuthority } from "./authority-protocol"
import type { MissionStorage } from "./journal"
import { documentID, MISSION_DOCUMENT_MAX_BYTES } from "./launch-policy"
import { MISSION_DOCUMENT_PREFIX, missionTombstoneSchema, parseMissionDocument, type MissionDocument } from "./mission-document"
import type { MissionScheduleObservation } from "./mission-schedule-display"
import { stableToken } from "./receipt-identity"
import { missionScheduleView } from "./mission-schedule-view"

export const MISSION_SCHEDULE_PAGE_MAX = 8
export const missionScheduleListInput = z.object({ after: documentID.optional(),
  limit: z.number().int().min(1).max(MISSION_SCHEDULE_PAGE_MAX).default(MISSION_SCHEDULE_PAGE_MAX) }).strict()

/** One key-ordered display page, including immediate unified documents. The
 * cursor advances across tombstones; readers never scan until a page is full. */
export async function readMissionSchedulePage(storage: Pick<MissionStorage, "scan">,
  project: { id: string; canonical: string }, raw: unknown, observe?: (doc: MissionDocument) => Promise<MissionScheduleObservation>) {
  const input = missionScheduleListInput.parse(raw)
  const prefix = `${MISSION_DOCUMENT_PREFIX}/project/${stableToken(`${project.id}\0${project.canonical}`, 24)}/missions/`
  const after = input.after === undefined ? undefined : `${prefix}${input.after}`
  const page = await storage.scan({ prefix, after, limit: input.limit })
  if (page.entries.length > input.limit) throw new Error("Mission schedule page exceeds bound")
  let previous = after ?? prefix
  const schedules: NonNullable<ReturnType<typeof missionScheduleView>["document"]>[] = []
  for (const entry of page.entries) {
    if (!entry.key.startsWith(prefix) || entry.key <= previous) throw new Error("Mission schedule page order differs")
    const id = documentID.parse(entry.key.slice(prefix.length))
    previous = entry.key
    const value = JSON.parse(canonicalAuthority(entry.value, MISSION_DOCUMENT_MAX_BYTES))
    if (value && typeof value === "object" && "deletedAt" in value) {
      const tombstone = missionTombstoneSchema.parse(value)
      if (tombstone.id !== id || tombstone.projectID !== project.id || tombstone.projectCanonical !== project.canonical)
        throw new Error("Foreign Mission schedule tombstone")
      continue
    }
    const doc = parseMissionDocument(value, { id, projectID: project.id, projectCanonical: project.canonical })
    schedules.push(missionScheduleView(doc, undefined, await observe?.(doc)).document!)
  }
  if (page.next !== undefined && (!page.entries.length || page.next !== previous))
    throw new Error("Mission schedule cursor differs")
  return { version: 1 as const, projectID: project.id, schedules,
    ...(page.next === undefined ? {} : { next: documentID.parse(page.next.slice(prefix.length)) }) }
}
export type MissionScheduleList = Awaited<ReturnType<typeof readMissionSchedulePage>>
