import type { MissionCalendarView } from "../../../server/src/opencode/mission-calendars"
import type { MissionPanelMap } from "../../../server/src/api-types"
import type { MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import type { MissionEditorDraft } from "../stores/mission-editor-state"
import type { MissionMark } from "./mission-picker-model"
import { generateUUID } from "../lib/client-identity"
import { decodeMissionSchedulingPolicy } from "./mission-scheduling-decode"
import { describeMissionCriteria, missionCriteriaZone } from "./mission-scheduling-summary"

type Translate = (key: string, params?: Record<string, string>) => string
const RUN_OUTCOMES = ["completed", "failed", "stopped"]

/** What the panel shows of a programmed Mission's programming. */
export function missionProgramming(calendar: MissionCalendarView, t: Translate, locale: string) {
  const policy = calendar.launch
  const zone = policy && missionCriteriaZone(policy)
  const date = (at: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", ...(zone ? { timeZone: zone } : {}) }).format(at)
  const due = calendar.rules.flatMap(rule => rule.nextDueAt === undefined ? [] : [rule.nextDueAt])
  // Events alone are looked at on an interval; a date is a wake.
  const nextLabel = t(calendar.rules.every(rule => rule.trigger.type === "every") ? "missions.scheduleList.nextCheck" : "missions.scheduleList.nextWake")
  const next = calendar.paused || !due.length ? t("missions.scheduleList.none") : date(Math.min(...due))
  const criteria = policy ? describeMissionCriteria(policy, t, locale).join("; ") : ""
  return {
    criteria, nextLabel, next, launches: calendar.last?.launches ?? 0,
    state: t(`missions.scheduleList.state.${calendar.paused ? "paused" : "running"}`),
    /** The row's mark: the launch's own while it is under way, asks or awaits review; `between` launches, the programming's. */
    mark: (launch: MissionMark, between: boolean): MissionMark => !between || launch !== "idle" && launch !== "prepared" ? launch
      : calendar.paused ? "paused" : due.length ? "waiting" : launch,
    /** The Mission row's additions. */
    row: [criteria, calendar.paused ? t("missions.scheduleList.state.paused") : `${nextLabel} · ${next}`].filter(Boolean),
    /** Past launches, newest first: a Mission removed before it ended reads as stopped. */
    runs: [...calendar.last?.history ?? []].reverse().map(run =>
      `${date(run.at)} · ${t(`missionsPanel.run.${RUN_OUTCOMES.includes(run.outcome) ? run.outcome : "stopped"}`)}`),
  }
}

/** Follows a programmed Mission to its next launch: the Mission that replaced `selected`, when one did. */
export function missionProgrammingSuccessor(before: readonly Pick<MissionCalendarView, "id" | "missionID">[],
  after: readonly Pick<MissionCalendarView, "id" | "missionID">[], selected: string | undefined): string | undefined {
  const calendar = selected && before.find(item => item.missionID === selected)?.id
  const next = calendar ? after.find(item => item.id === calendar)?.missionID : undefined
  return next && next !== selected ? next : undefined
}

/** The creation form filled with a programmed Mission, to save it again under its identity. */
export function missionProgrammingDraft(calendar: MissionCalendarView, directory?: string): MissionEditorDraft | undefined {
  const { objective, notes, template, taskMode, profiles, coordinatorGoal, coordinatorSessionID } = calendar.mission
  if (!calendar.launch || typeof objective !== "string" || typeof template !== "string") return undefined
  // A local branch was entered against the directory the service knows this project by.
  const local = "when" in calendar.launch ? calendar.launch.when.find(item => item.kind === "branch-commits") : undefined
  const scheduling = decodeMissionSchedulingPolicy(calendar.launch, local && "directory" in local ? local.directory : directory)
  return { mode: "recurring", titleOverride: calendar.title, time: "09:00", zone: scheduling.zone, watched: [], objective,
    notes: typeof notes === "string" ? notes : "", template: template as MissionPanelMap["template"], profiles: profiles as MissionProfiles | undefined,
    customProfiles: true, taskMode: taskMode === "independent" ? "independent" : "native", customTaskMode: true, defaults: [], defaultsReady: true,
    optionsOpen: true, profileDetailsOpen: false, coordinatorGoal: coordinatorGoal === true,
    ...(typeof coordinatorSessionID === "string" ? { coordinatorSessionID } : {}), scheduling, calendarID: calendar.id,
    requestId: generateUUID(), lastPayload: "", deleteManagedSessions: false, deleteAttempted: false }
}