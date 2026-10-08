import { archivedRecurrencePassage } from "./recurrence-passage"
import type { MissionStorage } from "./journal"
import type { RecurrenceDocument } from "./recurrence-contract"
import { recurrenceReadInput, recurrenceReadPage, RECURRENCE_READER_MAX_SECTIONS, RECURRENCE_READER_SECTIONS } from "./recurrence-reader-contract"
import { missionMarkdownPage } from "./markdown-pages"

/** Read the isolated journal authorized by an archived receipt, not an arbitrary
 * browser mission/session. Native text is projected unchanged and paged once. */
export async function readArchivedRecurrencePage(storage: MissionStorage, document: RecurrenceDocument, raw: unknown) {
  const input = recurrenceReadInput.parse(raw)
  if (input.scheduleID !== document.id) throw new Error("Recurrence schedule changed")
  const { receipt, missionID, journal } = archivedRecurrencePassage(storage, document, input.passageID)
  if (!("missionID" in receipt.result)) throw new Error("Archived result unavailable")
  const snapshot = await journal.snapshot()
  const mission = snapshot.missions[0]
  if (snapshot.missions.length !== 1 || snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable
    || !mission || mission.id !== missionID || mission.projectID !== document.projectID
    || mission.projectCanonical !== document.projectCanonical || mission.coordinatorSessionId !== receipt.result.conversationID
    || mission.status !== receipt.result.outcome || input.revision !== undefined && input.revision !== mission.revision) {
    throw new Error("Archived recurrence journal unavailable or changed")
  }
  const history = await journal.events()
  if (history.discardedEvents || !history.events.some(event => event.type === "mission.created"
    && event.missionID === missionID && event.requestID === receipt.passage.id)) throw new Error("Archived recurrence creation binding unavailable")

  const sections: Array<{ label: typeof recurrenceReadPage._type.sections[number]["label"]; title: string; text: string; raw: boolean }> = []
  const add = (label: typeof sections[number]["label"], text: string | undefined, title = "", raw = false) => {
    if (text) {
      if (text.length > 576_000 || sections.length >= RECURRENCE_READER_MAX_SECTIONS) throw new Error("Archived result section capacity")
      sections.push({ label, text, title, raw })
    }
  }
  add("summary", mission.summary)
  const reports = new Map([...mission.reports, ...mission.tasks.flatMap(task => [...(task.report ? [task.report] : []), ...(task.lateReports ?? [])])]
    .sort((a, b) => b.createdAt - a.createdAt).map(report => [report.id, report]))
  for (const report of reports.values()) {
    const title = mission.tasks.find(task => task.key === report.taskKey)?.title ?? report.taskKey
    add("summary", report.summary, title)
    add("evidence", report.evidence.join("\n\n"), title)
    add("next", report.next.join("\n\n"), title)
    if (report.artifact !== undefined) add("artifact", JSON.stringify(report.artifact, null, 2), title, true)
  }
  if (mission.briefing) {
    add("summary", mission.briefing.summary)
    for (const label of ["achieved", "ongoing", "obstacles", "next"] as const) add(label, mission.briefing[label].map(item => item.text).join("\n\n"))
  }
  add("objective", mission.objective)
  add("notes", mission.notes)
  for (const task of mission.tasks) add("brief", task.brief, task.title)
  const section = sections[input.section]
  if (!section) throw new Error("Archived result section unavailable")
  const pageCount = Math.max(1, Math.ceil(section.text.length / 9_000))
  if (input.page >= pageCount) throw new Error("Archived result page unavailable")
  const offset = Math.floor(input.section / RECURRENCE_READER_SECTIONS) * RECURRENCE_READER_SECTIONS
  return recurrenceReadPage.parse({ version: 1, projectID: document.projectID, scheduleID: document.id,
    passageID: receipt.passage.id, missionID, conversationID: receipt.result.conversationID, revision: mission.revision,
    section: input.section, sectionCount: sections.length, sections: sections.slice(offset, offset + RECURRENCE_READER_SECTIONS)
      .map((item, index) => ({ index: offset + index, label: item.label, title: item.title, raw: item.raw })),
    page: input.page, pageCount, ...missionMarkdownPage(section.text, input.page),
  })
}
