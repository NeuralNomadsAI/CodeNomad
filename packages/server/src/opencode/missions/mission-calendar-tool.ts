import { homedir } from "node:os"
import path from "node:path"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import type { Plugin } from "@opencode/plugin"
import { MISSION_CALENDAR_CARRIER, MISSION_CALENDAR_TOOL, missionCalendarEventsSchema, missionCalendarIDSchema, missionCalendarKey, missionCalendarNews, missionCalendarOccurrence,
  runMissionCalendar, type MissionCalendarControl } from "../../missions/calendar-run"
import { stableToken } from "../../missions/receipt-identity"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { parseCreateMissionInput } from "../missions-plugin"
import { readNativeScheduleIncarnation } from "./native-schedule-transport-identity"

type Context = Parameters<Plugin.Plugin["setup"]>[0]

/** A Code Mode program's graph has no Mission storage, so each step goes through this
 * service's own HTTP RPC, as CodeNomad's Create and Play do. Only the default
 * registration of this very process is accepted. */
async function ownMissions(directory: string): Promise<MissionCalendarControl> {
  const file = path.join(process.env["XDG_STATE_HOME"] ?? path.join(homedir(), ".local", "state"), "opencode", "service.json")
  const endpoint = await (async () => readNativeScheduleIncarnation(file).pid === process.pid ? Service.discover({ file }) : undefined)().catch(() => undefined)
  if (!endpoint) throw new Error("mission-calendar-service")
  const rpc = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) }).rpc(CODENOMAD_MISSIONS_RPC), options = { location: { directory } }
  // JSON drops the absent fields the RPC schema refuses as `undefined`.
  return { create: input => rpc.create(JSON.parse(JSON.stringify(input)), options), lifecycle: input => rpc.lifecycle(input, options),
    mission: missionID => rpc.mission({ missionID }, options), delete: input => rpc.delete(input, options) } as MissionCalendarControl
}

/** The tool every Mission calendar's Automation calls. Visible to Code Mode, it accepts
 * only an Automation run of a calendar carrier. `registered` keeps Missions registered
 * for one step, with or without a CodeNomad backend. */
export const registerMissionCalendarTool = (ctx: Context, registered: <T>(work: () => Promise<T>) => Promise<T>) =>
  ctx.tool.transform(draft => draft.add({
    name: MISSION_CALENDAR_TOOL.name,
    description: "Internal CodeNomad Mission calendar run. Only a Mission calendar's own automation can call it.",
    input: { type: "object" },
    options: { namespace: MISSION_CALENDAR_TOOL.namespace, codemode: true, permission: MISSION_CALENDAR_TOOL.permission },
    execute: async (input, tool) => {
      try {
        const occurrence = missionCalendarOccurrence(tool.messageID)
        if (!occurrence || !(await ctx.session.get({ sessionID: tool.sessionID })).metadata?.[MISSION_CALENDAR_CARRIER]) throw new Error("mission-calendar-caller")
        const { objective, title, notes, template, taskMode, profiles, coordinatorGoal, coordinatorSessionID, permissions, when, calendar, prepared } = input as Record<string, unknown>
        const mission = parseCreateMissionInput({ objective, title, notes, template, taskMode, profiles, coordinatorGoal, coordinatorSessionID, permissions, requestID: occurrence.automationID })
        const events = missionCalendarEventsSchema.parse(when ?? [])
        const key = missionCalendarKey(stableToken(`${ctx.location.project.id}\0${ctx.location.project.canonical}`, 24),
          calendar === undefined ? occurrence.automationID : missionCalendarIDSchema.parse(calendar))
        // OpenCode gives the whole program 30 seconds.
        const read = events.length ? missionCalendarNews(events, ctx.location.directory, AbortSignal.timeout(20_000)) : undefined
        const news = read && ((previous: Parameters<typeof read>[0]) => read(previous).catch(() => { throw new Error("mission-calendar-source") }))
        // Missions registers only for the steps that need it: a run without news costs no registration.
        let own: Promise<MissionCalendarControl> | undefined
        const step = <K extends keyof MissionCalendarControl>(name: K) => ((input: never) => registered(async () =>
          (await (own ??= ownMissions(ctx.location.directory)))[name](input))) as MissionCalendarControl[K]
        return { content: JSON.stringify(await runMissionCalendar({ create: step("create"), lifecycle: step("lifecycle"), mission: step("mission"), delete: step("delete") },
          ctx.storage, key, occurrence, mission, { news, ...(typeof prepared === "string" && prepared.length <= 100 ? { prepared } : {}) })) }
      } catch (error) {
        // Fixed codes only: native errors and credentials stay out of the automation's output.
        throw new Error(error instanceof Error && /^mission-calendar-[a-z-]+$/.test(error.message) ? error.message : "mission-calendar-failed")
      }
    },
  }))
