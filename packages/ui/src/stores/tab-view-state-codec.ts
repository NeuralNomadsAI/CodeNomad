import { historyUrl, parseBrowserHistory, type BrowserHistory } from "../lib/browser-history"
import type { MissionReaderTarget, MissionTaskSelectionKey } from "./mission-view-state"
import type { FilesPanelMode } from "../components/instance/shell/right-panel/files-panel-state"
import type { BrowserViewportPreset } from "../components/browser-frame"
import { missionProfileRoles } from "../../../server/src/missions/playbook-profiles"

export interface RestorableTabPreview {
  mode: "preview" | "chat"
  targetUrl?: string
  history?: BrowserHistory
  viewport?: BrowserViewportPreset
}
export interface RestorableBrowserPreview extends RestorableTabPreview { targetUrl: string }
export const SESSION_BROWSER_STATE_KEY = "opencode-session-browser-state-v1"
export interface RestorableTabMissionView {
  selected?: string
  selectedScheduled?: string
  selectedTask?: MissionTaskSelectionKey
  reader?: MissionReaderTarget
  expanded?: readonly string[]
  disclosures?: Record<string, boolean>
}
export interface RestorableTabViewState {
  version: 1
  previews?: Record<string, RestorableTabPreview>
  missions?: RestorableTabMissionView
  rightPanelTab?: string
  filesMode?: FilesPanelMode
}
export const LEGACY_SESSION_PREVIEWS_KEY = "opencode-session-previews-v1"
export const MAX_TAB_PREVIEW_STORAGE = 4_000
export const MAX_TAB_PREVIEWS = 32
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
  && value.length <= 512 && !["__proto__", "constructor", "prototype"].includes(value)

function normalizeTabPreview(value: unknown): RestorableTabPreview | undefined {
  if (!record(value) || (value.mode !== "chat" && value.mode !== "preview")) return
  if (value.targetUrl === undefined) return { mode: value.mode }
  const targetUrl = historyUrl(value.targetUrl)
  if (!targetUrl || targetUrl.length > 2048) return
  const parsedHistory = parseBrowserHistory(value.history, targetUrl)
  const history = parsedHistory.urls.every(url => url.length <= 2048) ? parsedHistory : { urls: [targetUrl], index: 0 }
  return { targetUrl, mode: value.mode,
    ...(value.history === undefined ? {} : { history }),
    ...(["responsive", "desktop", "tablet", "tabletLandscape", "mobile", "mobileLandscape"].includes(String(value.viewport))
      ? { viewport: value.viewport as BrowserViewportPreset } : {}) }
}

export function parseLegacySessionPreviews(value: string | null): Array<[string, RestorableBrowserPreview]> {
  if (!value || value.length > 4096) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!record(parsed)) return []
    return Object.entries(parsed).slice(0, MAX_TAB_PREVIEWS).flatMap(([key, value]) => {
      const preview = normalizeTabPreview(value)
      return key && key.length <= 4096 && preview?.targetUrl ? [[key, preview as RestorableBrowserPreview] as [string, RestorableBrowserPreview]] : []
    })
  } catch { return [] }
}

/** Most recent/active sources go first. Persist resources before stripping imported URLs. */
export function mergeSessionBrowsers(views: readonly (RestorableTabViewState | undefined)[], stored: string | null) {
  const previews: Record<string, RestorableTabPreview> = Object.fromEntries(parseLegacySessionPreviews(stored))
  for (const view of [...views].reverse()) for (const [id, preview] of Object.entries(view?.previews ?? {})) {
    if (preview.targetUrl) { delete previews[id]; previews[id] = { ...preview, mode: "chat" } }
  }
  return JSON.stringify(normalizeTabViewState({ version: 1, previews })?.previews ?? {})
}

export function tabPreviewModes(view: RestorableTabViewState): RestorableTabViewState {
  return view.previews ? { ...view, previews: Object.fromEntries(Object.entries(view.previews).map(([id, p]) => [id, { mode: p.mode }])) } : view
}

function normalizeMissionView(value: unknown): RestorableTabMissionView | undefined {
  if (!record(value)) return
  const result: RestorableTabMissionView = {}
  if (record(value.disclosures)) result.disclosures = Object.fromEntries(Object.entries(value.disclosures)
    .filter((entry): entry is [string, boolean] => /^[a-zA-Z0-9_-]{11}$/.test(entry[0]) && typeof entry[1] === "boolean").slice(-160))
  for (const key of ["selected", "selectedScheduled"] as const) {
    if (id(value[key])) result[key] = value[key]
  }
  if (record(value.selectedTask) && id(value.selectedTask.missionId) && id(value.selectedTask.taskId)) {
    result.selectedTask = { missionId: value.selectedTask.missionId, taskId: value.selectedTask.taskId }
  }
  if (Array.isArray(value.expanded)) result.expanded = value.expanded.filter(id).slice(-30)
  const r = value.reader
  if (!record(r) || !id(r.missionId)
    || !["overview", "task", "report", "change", "recurrence", "playbook"].includes(String(r.kind))
    || (r.itemId !== undefined && !id(r.itemId))
    || (r.kind === "recurrence" && (!id(r.instanceId) || !id(r.projectID) || r.scheduleOwner !== "scheduled"))
    || (r.taskMode !== undefined && r.taskMode !== "native" && r.taskMode !== "independent")
    || (r.scheduleOwner !== undefined && r.scheduleOwner !== "scheduled")) return result
  if (r.kind === "playbook" && !Object.prototype.hasOwnProperty.call(missionProfileRoles, r.missionId)) return result
  const reader: MissionReaderTarget = { missionId: r.missionId, kind: r.kind as MissionReaderTarget["kind"] }
  for (const key of ["itemId", "instanceId", "projectID"] as const) if (id(r[key])) reader[key] = r[key]
  if (r.taskMode === "native" || r.taskMode === "independent") reader.taskMode = r.taskMode
  if (r.scheduleOwner === "scheduled") reader.scheduleOwner = r.scheduleOwner
  if (r.recurrence !== undefined) {
    const recurrence = r.recurrence
    if (!record(recurrence) || !["instanceId", "projectID", "scheduleID", "passageID"].every(key => id(recurrence[key]))
      || recurrence.owner !== "scheduled"
      || r.kind === "playbook") return result
    reader.recurrence = {
      instanceId: recurrence.instanceId as string, projectID: recurrence.projectID as string,
      scheduleID: recurrence.scheduleID as string, passageID: recurrence.passageID as string,
      owner: recurrence.owner,
    }
  }
  result.reader = reader
  return result
}

/** One preview budget is shared by all descriptors in a captured window. */
export function normalizeTabViewState(
  value: unknown,
  budget = { remaining: MAX_TAB_PREVIEW_STORAGE },
): RestorableTabViewState | undefined {
  if (!record(value) || value.version !== 1) return
  const result: RestorableTabViewState = { version: 1 }
  if (record(value.previews)) {
    const entries = Object.entries(value.previews).filter(([key]) => id(key)).slice(-MAX_TAB_PREVIEWS)
      .flatMap(([key, value]) => {
        const preview = normalizeTabPreview(value)
        return preview ? [[key, preview] as const] : []
      })
    let size = JSON.stringify(Object.fromEntries(entries)).length
    while (size > budget.remaining) {
      const preview = entries.find(([, preview]) => (preview.history?.urls.length ?? 0) > 1)?.[1]
      const history = preview?.history
      if (!history) break
      const before = JSON.stringify(preview).length
      if (history.index > 0) { history.urls.shift(); history.index-- }
      else history.urls.pop()
      size -= before - JSON.stringify(preview).length
    }
    while (entries.length && size > budget.remaining) {
      const [key, preview] = entries.shift()!
      size -= JSON.stringify(key).length + JSON.stringify(preview).length + 1 + (entries.length ? 1 : 0)
    }
    if (entries.length) {
      result.previews = Object.fromEntries(entries)
      budget.remaining -= size
    }
  }
  const missions = normalizeMissionView(value.missions)
  if (missions?.disclosures) {
    for (const key of Object.keys(missions.disclosures)) {
      if (JSON.stringify(missions).length <= 4096) break
      delete missions.disclosures[key]
    }
  }
  if (missions && JSON.stringify(missions).length <= 4096) result.missions = missions
  if (id(value.rightPanelTab)) result.rightPanelTab = value.rightPanelTab
  if (value.filesMode === "workspace" || value.filesMode === "changes" || value.filesMode === "history") result.filesMode = value.filesMode
  return result
}
