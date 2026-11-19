import { z } from "zod"
import type { missionPanelHeader } from "./mission-panel-header"
import type { missionTaskPage } from "./mission-compact-map"
import type { MissionContentRequest } from "./mission-content-wire"
import type { MissionEvent } from "./model"
import { contentDigest } from "./content-digest"
import { contentText } from "./inspect-view"

const descriptor = z.object({ characters: z.number().int().nonnegative(), digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
const sources = z.object({ objective: z.string().optional(), notes: z.string().optional() })
const schema = z.object({
  header: z.object({
    root: z.object({ id: z.string(), projectID: z.string(), revision: z.number(), coordinatorSessionId: z.string(),
      bodies: z.object({ notes: descriptor.optional(), objective: descriptor.optional() }).optional() }).passthrough(),
    collections: z.record(z.string(), descriptor.extend({ total: z.number(), array: z.boolean() }).passthrough()),
    tasks: z.object({ page: z.object({}).passthrough(), pins: z.array(z.string()), reportPins: z.array(z.string()), version: z.string() }),
  }).passthrough(),
  damage: z.object({ discardedEvents: z.literal(0), controlUnavailable: z.literal(false),
    notificationUnavailable: z.literal(false), cleanupUnavailable: z.literal(false) }),
  revision: z.number().int().positive(), coordinator: z.string(), sources,
})

export function decodeJournalDisplay(value: string, projectID: string, missionID: string) {
  let raw: unknown
  try { raw = JSON.parse(value) } catch { return undefined }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) return undefined
  const data = parsed.data, root = data.header.root
  if (root.id !== missionID || root.projectID !== projectID || root.revision !== data.revision || root.coordinatorSessionId !== data.coordinator) return undefined
  // Validation must not normalize the header: its serialized bytes name the
  // panel continuation, and other body descriptors must survive intact.
  return { ...data, header: (raw as { header: ReturnType<typeof missionPanelHeader> }).header, bodies: root.bodies ?? {} }
}

const windowSchema = z.object({
  projectID: z.string(), missionID: z.string(), revision: z.number().int().positive(),
  page: z.object({ taskPage: z.object({ offset: z.literal(0), order: z.string() }),
    tasks: z.array(z.object({ key: z.string() })).max(50), reports: z.array(z.object({ id: z.string() })) }),
  taskSources: z.record(z.string(), z.string()), reportSources: z.record(z.string(), z.string()),
  pinSelection: z.string().optional(),
})

export function decodeJournalTaskWindow(value: string, projectID: string, missionID: string) {
  let raw: unknown
  try { raw = JSON.parse(value) } catch { return undefined }
  const parsed = windowSchema.safeParse(raw)
  if (!parsed.success || parsed.data.projectID !== projectID || parsed.data.missionID !== missionID) return undefined
  return { ...parsed.data, page: (raw as { page: ReturnType<typeof missionTaskPage> }).page }
}

export function namedWindowBody(window: NonNullable<ReturnType<typeof decodeJournalTaskWindow>>, request: MissionContentRequest) {
  if (request.kind === "task" && request.field === "brief") {
    const row = window.page.tasks.find(task => task.key === request.taskKey)
    return { id: window.taskSources[request.taskKey], descriptor: row?.bodies?.brief }
  }
  if (request.kind === "report" && ["summary", "evidence", "next", "artifact"].includes(request.field)) {
    const row = window.page.reports.find(report => report.id === request.reportId)
    return { id: window.reportSources[request.reportId], descriptor: row?.bodies?.[request.field] }
  }
}

export function verifiedWindowBody(window: NonNullable<ReturnType<typeof decodeJournalTaskWindow>>, request: MissionContentRequest, event: MissionEvent) {
  const descriptor = namedWindowBody(window, request)?.descriptor
  if (!descriptor) return undefined
  const value = request.kind === "task" ? (event.type === "task.created" && event.task.key === request.taskKey ? event.task.brief
    : event.type === "mission.revised" ? event.addedTasks.find(task => task.key === request.taskKey)?.brief : undefined)
    : request.kind === "report" && event.type === "task.reported" && event.report.id === request.reportId
      ? event.report[request.field as "summary" | "evidence" | "next" | "artifact"] : undefined
  if (value === undefined) return undefined
  const text = contentText(value)
  return text.length === descriptor.characters && contentDigest(text) === descriptor.digest ? { value } : undefined
}
