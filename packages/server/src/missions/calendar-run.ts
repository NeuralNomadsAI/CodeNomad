import { z } from "zod"
import type { MissionControl } from "./control"
import type { MissionCreateInput } from "./control-types"
import type { MissionJsonValue, MissionMap } from "./model"
import type { MissionPanelMap } from "./mission-panel-map"

/** A Mission calendar is an OpenCode Automation whose program is this one call: its
 * `args` are the Mission to launch, and the tool does everything else. */
export const MISSION_CALENDAR_TOOL = Object.freeze({ namespace: "codenomad", name: "mission_calendar_run", permission: "codenomad_mission_calendar_run" })
// OpenCode accepts only nothing or a CodeResult: without `return null` the tool's output would be the result.
export const MISSION_CALENDAR_CODE = `await tools.${MISSION_CALENDAR_TOOL.namespace}.${MISSION_CALENDAR_TOOL.name}(args); return null`
/** Rules of the conversation that carries calendars, so OpenCode runs the program unattended. */
export const MISSION_CALENDAR_PERMISSIONS = Object.freeze([
  Object.freeze({ action: "execute", resource: "*", effect: "allow" as const }),
  Object.freeze({ action: MISSION_CALENDAR_TOOL.permission, resource: "*", effect: "allow" as const }),
])
/** Metadata key of a conversation allowed to carry calendars. */
export const MISSION_CALENDAR_CARRIER = "codenomad.mission-calendar"

const slotSchema = z.object({ version: z.literal(1), run: z.number().int().positive(), missionID: z.string().min(1).max(100) }).strict()
/** The calendar's latest Mission, per project and Automation. */
export const missionCalendarKey = (projectToken: string, automationID: string) => `codenomad-missions/calendar-v1/${projectToken}/${automationID}`

/** OpenCode names an Automation run's message `msg_<automationID>_<run>`; nothing else is a calendar run. */
export function missionCalendarOccurrence(messageID: string): { automationID: string; run: number } | undefined {
  const match = /^msg_(aut_[A-Za-z0-9]+)_([1-9]\d{0,14})$/.exec(messageID)
  return match ? { automationID: match[1]!, run: Number(match[2]) } : undefined
}

export type MissionCalendarResult = { missionID: string; status: MissionMap["status"] } | { waiting: string }
/** What a run needs of Missions: `MissionControl` itself, or its registered RPC. */
export type MissionCalendarControl = Pick<MissionControl, "create" | "lifecycle" | "mission">
type Storage = { get(key: string): Promise<MissionJsonValue | undefined>; set(key: string, value: MissionJsonValue): Promise<void> }

/** One occurrence: an ordinary one-time Mission, created and started, unless the
 * calendar's previous Mission is still active. Repeating a run changes nothing. */
export async function runMissionCalendar(control: MissionCalendarControl, storage: Storage,
  key: string, occurrence: { automationID: string; run: number },
  mission: Omit<MissionCreateInput, "requestID" | "prepared">): Promise<MissionCalendarResult> {
  // A Mission created by a run that never started it is started by whichever run finds it.
  const start = async (map: MissionPanelMap | MissionMap) => {
    const pending = map.control?.pending.length ? map.control : undefined
    if (map.runState !== "prepared" && pending?.action !== "start") return map
    return (await control.lifecycle({ missionID: map.id, action: "start", requestID: pending?.requestID ?? "calendar-start",
      expectedRevision: pending?.expectedRevision ?? map.revision })).mission
  }
  const slot = slotSchema.safeParse(await storage.get(key)).data
  if (slot && slot.run !== occurrence.run) {
    const previous = (await control.mission(slot.missionID)).mission
    if (previous?.status === "active") return { waiting: (await start(previous)).id }
  }
  const created = (await control.create({ ...mission, prepared: true, requestID: `calendar_${occurrence.automationID}_${occurrence.run}` })).mission
  await storage.set(key, { version: 1, run: occurrence.run, missionID: created.id })
  const started = await start(created)
  return { missionID: started.id, status: started.status }
}
