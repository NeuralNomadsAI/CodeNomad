import { homedir } from "node:os"
import path from "node:path"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import type { Plugin } from "@opencode/plugin"
import { MISSION_CALENDAR_CARRIER, MISSION_CALENDAR_TOOL, missionCalendarKey, missionCalendarOccurrence, runMissionCalendar,
  type MissionCalendarControl } from "../../missions/calendar-run"
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
    mission: missionID => rpc.mission({ missionID }, options) } as MissionCalendarControl
}

/** The tool every Mission calendar's Automation calls. Visible to Code Mode, it accepts
 * only an Automation run of a calendar carrier. `registered` keeps Missions registered
 * for the whole run, with or without a CodeNomad backend. */
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
        const { objective, title, notes, template, taskMode, profiles, coordinatorGoal, permissions } = input as Record<string, unknown>
        const mission = parseCreateMissionInput({ objective, title, notes, template, taskMode, profiles, coordinatorGoal, permissions, requestID: occurrence.automationID })
        const key = missionCalendarKey(stableToken(`${ctx.location.project.id}\0${ctx.location.project.canonical}`, 24), occurrence.automationID)
        return { content: JSON.stringify(await registered(async () => runMissionCalendar(await ownMissions(ctx.location.directory), ctx.storage, key, occurrence, mission))) }
      } catch (error) {
        // Fixed codes only: native errors and credentials stay out of the automation's output.
        throw new Error(error instanceof Error && /^mission-calendar-[a-z-]+$/.test(error.message) ? error.message : "mission-calendar-failed")
      }
    },
  }))
