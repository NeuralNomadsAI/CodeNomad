import type { AutomationInfo, OpenCodeClient } from "@opencode/client"
import { MISSION_CALENDAR_CARRIER, MISSION_CALENDAR_CODE, MISSION_CALENDAR_PERMISSIONS, missionCalendarIDSchema } from "../missions/calendar-run"
import type { MissionCalendarAutomation } from "../missions/calendar-automation"
import { MISSION_SCHEDULE_CARRIER_SESSION_PREFIX } from "../missions/mission-schedule-carrier-identity"
import { stableToken } from "../missions/receipt-identity"
import { locationRequestOptions } from "./compatibility/location"

type Client = { experimental: Pick<OpenCodeClient["experimental"], "automation">; session: Pick<OpenCodeClient["session"], "get" | "create"> }
/** What a calendar's last run did, from its Automation's state. */
export type MissionCalendarLast = { missionID: string; status: string } | { waiting: string } | { idle: true }
export type MissionCalendarView = {
  id: string; title: string; paused: boolean
  /** The Mission each launch creates and the events it waits for, as given at creation. */
  mission: Record<string, unknown>
  rules: Array<{ automationID: string; trigger: AutomationInfo["trigger"]; tz: string; nextDueAt?: number; lastRunAt?: number
    lastOutcome?: string; lastOutput?: string; runCount: number }>
  last?: MissionCalendarLast & { at: number }
}

const TITLE = "Mission calendars"
function last(info: AutomationInfo): MissionCalendarLast | undefined {
  const text = (info.state as { last?: unknown } | null | undefined)?.last
  if (typeof text !== "string") return undefined
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (typeof value.waiting === "string") return { waiting: value.waiting }
    if (typeof value.missionID === "string" && typeof value.status === "string") return { missionID: value.missionID, status: value.status }
    return value.idle === true ? { idle: true } : undefined
  } catch { return undefined }
}

/** Mission calendars of one Location: the native Automations that run the calendar
 * program in the Location's carrier conversation. The only code that speaks
 * OpenCode's Automation API for them. */
export function missionCalendars(client: Client, location: { directory: string; workspaceID?: string }, projectID: string, signal?: AbortSignal) {
  // The reserved prefix keeps ordinary sends, favourites and permission modes off the carrier.
  const carrier = `${MISSION_SCHEDULE_CARRIER_SESSION_PREFIX}calendar_${stableToken(`${projectID}\0${location.directory}`, 24)}`
  const options = { ...locationRequestOptions(location), signal }
  const own = async () => (await client.experimental.automation.list({ sessionID: carrier, directory: location.directory }, options))
    .filter(info => info.sessionID === carrier && info.action.type === "code" && info.action.code === MISSION_CALENDAR_CODE)
  const calendarOf = (info: AutomationInfo) => {
    const args = info.action.type === "code" ? info.action.args as { calendar?: unknown } | undefined : undefined
    return typeof args?.calendar === "string" ? args.calendar : info.id
  }
  const members = async (calendar: string) => {
    const found = (await own()).filter(info => calendarOf(info) === calendar)
    if (!found.length) throw new MissionCalendarMissing()
    return found
  }
  const ensureCarrier = async () => {
    const existing = await client.session.get({ sessionID: carrier }, options).catch(() => undefined)
    if (existing) {
      if (!existing.metadata?.[MISSION_CALENDAR_CARRIER] || existing.location.directory !== location.directory) throw new Error("Mission calendar carrier differs")
      return
    }
    await client.session.create({ id: carrier, title: TITLE, location: { directory: location.directory },
      metadata: { [MISSION_CALENDAR_CARRIER]: { version: 1 } }, permissions: MISSION_CALENDAR_PERMISSIONS.map(rule => ({ ...rule })) }, options)
  }
  return {
    carrier,
    async list(): Promise<MissionCalendarView[]> {
      const groups = new Map<string, AutomationInfo[]>()
      for (const info of await own()) groups.set(calendarOf(info), [...groups.get(calendarOf(info)) ?? [], info])
      return [...groups].map(([id, infos]) => {
        const { calendar: _calendar, ...mission } = (infos[0]!.action as { args?: Record<string, unknown> }).args ?? {}
        // The calendar's latest run, whichever rule made it.
        const latest = infos.filter(info => info.lastRunAt !== undefined && last(info)).sort((a, b) => b.lastRunAt! - a.lastRunAt!)[0]
        return { id, title: infos[0]!.name, paused: infos.every(info => info.status !== "active"), mission,
          rules: infos.map(info => ({ automationID: info.id, trigger: info.trigger, tz: info.tz, runCount: info.runCount,
            ...(info.nextDueAt === undefined ? {} : { nextDueAt: info.nextDueAt }), ...(info.lastRunAt === undefined ? {} : { lastRunAt: info.lastRunAt }),
            ...(info.lastOutcome === undefined ? {} : { lastOutcome: info.lastOutcome }), ...(info.lastOutput ? { lastOutput: info.lastOutput } : {}) })),
          ...(latest ? { last: { ...last(latest)!, at: latest.lastRunAt! } } : {}) }
      }).sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
    },
    /** Creates the calendar's Automations, or replaces them: its identity, and so its latest Mission and checkpoints, stay. */
    async save(calendar: string, automations: readonly MissionCalendarAutomation[]): Promise<void> {
      missionCalendarIDSchema.parse(calendar)
      if (!automations.length) throw new Error("Mission calendar needs a rule")
      await ensureCarrier()
      const previous = (await own()).filter(info => calendarOf(info) === calendar), created: string[] = []
      try {
        for (const automation of automations) created.push((await client.experimental.automation.create({ sessionID: carrier, directory: location.directory,
          name: automation.name, trigger: automation.trigger, action: automation.action as never }, options)).id)
      } catch (error) {
        // Nothing half-made stays: the previous rules were not touched yet.
        await Promise.allSettled(created.map(automationID => client.experimental.automation.delete({ automationID }, options)))
        throw error
      }
      // A paused calendar stays paused through an edit.
      if (previous.length && previous.every(info => info.status !== "active"))
        for (const automationID of created) await client.experimental.automation.pause({ automationID }, options)
      for (const info of previous) await client.experimental.automation.delete({ automationID: info.id }, options)
    },
    async pause(calendar: string): Promise<void> {
      for (const info of await members(calendar)) if (info.status === "active") await client.experimental.automation.pause({ automationID: info.id }, options)
    },
    async resume(calendar: string): Promise<void> {
      for (const info of await members(calendar)) if (info.status === "paused") await client.experimental.automation.resume({ automationID: info.id }, options)
    },
    async delete(calendar: string): Promise<void> {
      for (const info of await members(calendar)) await client.experimental.automation.delete({ automationID: info.id }, options)
    },
  }
}

export class MissionCalendarMissing extends Error { constructor() { super("Mission calendar not found") } }
