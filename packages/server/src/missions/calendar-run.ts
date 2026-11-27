import { z } from "zod"
import type { MissionControl } from "./control"
import type { MissionCreateInput } from "./control-types"
import { runMissionExclusive } from "./exclusive"
import { missionConditionSchema, type MissionCondition } from "./launch-policy"
import { missionCheckpointsSchema, missionSourceKey, type MissionSourceCheckpoint } from "./mission-document"
import { isMissionGithubCondition } from "./mission-github-condition"
import { readMissionGithubSource } from "./mission-github-source"
import { readMissionLocalSource } from "./mission-local-sources"
import { readMissionRemoteBranch, readMissionRepositorySource } from "./mission-repository-source"
import type { MissionJsonValue, MissionMap } from "./model"
import type { MissionPanelMap } from "./mission-panel-map"

/** A Mission calendar is an OpenCode Automation whose program is this one call: its
 * `args` are the Mission to launch, and the tool does everything else. */
export const MISSION_CALENDAR_TOOL = Object.freeze({ namespace: "codenomad", name: "mission_calendar_run", permission: "codenomad_mission_calendar_run" })
// The run's answer becomes the Automation's state, where any client reads what the calendar last did.
export const MISSION_CALENDAR_CODE = `return { state: { last: await tools.${MISSION_CALENDAR_TOOL.namespace}.${MISSION_CALENDAR_TOOL.name}(args) } }`
/** Rules of the conversation that carries calendars, so OpenCode runs the program unattended. */
export const MISSION_CALENDAR_PERMISSIONS = Object.freeze([
  Object.freeze({ action: "execute", resource: "*", effect: "allow" as const }),
  Object.freeze({ action: MISSION_CALENDAR_TOOL.permission, resource: "*", effect: "allow" as const }),
])
/** Metadata key of a conversation allowed to carry calendars. */
export const MISSION_CALENDAR_CARRIER = "codenomad.mission-calendar"

const slotSchema = z.object({ version: z.literal(1),
  // `ended`: seen no longer active, so later runs need not ask Missions again.
  launched: z.object({ automationID: z.string().min(1).max(100), run: z.number().int().positive(), missionID: z.string().min(1).max(100),
    ended: z.literal(true).optional() }).strict().optional(),
  checkpoints: missionCheckpointsSchema.optional() }).strict()
/** A calendar with several date rules is several Automations naming the same calendar: they share its slot. */
export const missionCalendarIDSchema = z.string().regex(/^[A-Za-z0-9_-]{3,100}$/)
/** The calendar's latest Mission and event checkpoints, per project and calendar (its only Automation's ID when it names none). */
export const missionCalendarKey = (projectToken: string, calendar: string) => `codenomad-missions/calendar-v1/${projectToken}/${calendar}`

/** OpenCode names an Automation run's message `msg_<automationID>_<run>`; nothing else is a calendar run. */
export function missionCalendarOccurrence(messageID: string): { automationID: string; run: number } | undefined {
  const match = /^msg_(aut_[A-Za-z0-9]+)_([1-9]\d{0,14})$/.exec(messageID)
  return match ? { automationID: match[1]!, run: Number(match[2]) } : undefined
}

type MissionCalendarEvent = Exclude<MissionCondition, { kind: "schedule-success" | "mission-completed" | "conversation-message" }>
/** Events a calendar can wait for: those read from Git and the forges with this machine's own access. */
export const missionCalendarEventsSchema = z.array(missionConditionSchema).max(8).refine((events): events is MissionCalendarEvent[] =>
  events.every(event => !["schedule-success", "mission-completed", "conversation-message"].includes(event.kind)))
export type MissionCalendarNews = (previous: readonly MissionSourceCheckpoint[]) => Promise<{ checkpoints: MissionSourceCheckpoint[]; changed: boolean }>

/** Reads every event against its checkpoint: any one changed is news. The first read of an event only records where it stands. */
export const missionCalendarNews = (events: readonly MissionCalendarEvent[], root: string, signal: AbortSignal): MissionCalendarNews => async previous => {
  const reads = await Promise.all(events.map(event => {
    const old = previous.find(item => item.key === missionSourceKey(event))
    if (event.kind === "repository-activity") return readMissionRepositorySource(event, root, old, signal)
    if (event.kind === "remote-branch-commits") return readMissionRemoteBranch(event, root, old, signal)
    if (isMissionGithubCondition(event)) return readMissionGithubSource(event, root, old, signal)
    return readMissionLocalSource(event, event.kind === "branch-commits" ? event.directory : root, old, signal)
  }))
  for (const read of reads) read.current()
  return { checkpoints: reads.map(read => read.checkpoint), changed: reads.some(read => read.changed) }
}

export type MissionCalendarResult = { missionID: string; status: MissionMap["status"] } | { waiting: string } | { idle: true }
/** What a run needs of Missions: `MissionControl` itself, or its registered RPC. */
export type MissionCalendarControl = Pick<MissionControl, "create" | "lifecycle" | "mission">
type Storage = { get(key: string): Promise<MissionJsonValue | undefined>; set(key: string, value: MissionJsonValue): Promise<void> }

/** One occurrence: an ordinary one-time Mission, created and started, unless the
 * calendar's previous Mission is still active or its events (`news`) brought nothing
 * new since the calendar's last launch. An active Mission leaves the events unread, so their news waits for it.
 * Repeating a run changes nothing, and the runs of one calendar follow one another. */
export function runMissionCalendar(control: MissionCalendarControl, storage: Storage,
  key: string, occurrence: { automationID: string; run: number },
  mission: Omit<MissionCreateInput, "requestID" | "prepared">, news?: MissionCalendarNews): Promise<MissionCalendarResult> {
  return runMissionExclusive(`calendar:${key}`, () => runOccurrence(control, storage, key, occurrence, mission, news))
}

async function runOccurrence(control: MissionCalendarControl, storage: Storage,
  key: string, occurrence: { automationID: string; run: number },
  mission: Omit<MissionCreateInput, "requestID" | "prepared">, news?: MissionCalendarNews): Promise<MissionCalendarResult> {
  // A Mission created by a run that never started it is started by whichever run finds it.
  const start = async (map: MissionPanelMap | MissionMap) => {
    const pending = map.control?.pending.length ? map.control : undefined
    if (map.runState !== "prepared" && pending?.action !== "start") return map
    return (await control.lifecycle({ missionID: map.id, action: "start", requestID: pending?.requestID ?? "calendar-start",
      expectedRevision: pending?.expectedRevision ?? map.revision })).mission
  }
  const slot = slotSchema.safeParse(await storage.get(key)).data
  const repeated = slot?.launched?.automationID === occurrence.automationID && slot.launched.run === occurrence.run
  let launched = slot?.launched, checkpoints = slot?.checkpoints
  if (launched && !repeated && !launched.ended) {
    const previous = (await control.mission(launched.missionID)).mission
    if (previous?.status === "active") return { waiting: (await start(previous)).id }
    launched = { ...launched, ended: true }
  }
  if (news && !repeated) {
    const read = await news(checkpoints ?? [])
    checkpoints = read.checkpoints
    if (!read.changed) {
      await storage.set(key, { version: 1, ...(launched ? { launched } : {}), checkpoints } as MissionJsonValue)
      return { idle: true }
    }
  }
  const created = (await control.create({ ...mission, prepared: true, requestID: `calendar_${occurrence.automationID}_${occurrence.run}` })).mission
  await storage.set(key, { version: 1, launched: { ...occurrence, missionID: created.id }, ...(checkpoints ? { checkpoints } : {}) } as MissionJsonValue)
  const started = await start(created)
  return { missionID: started.id, status: started.status }
}
