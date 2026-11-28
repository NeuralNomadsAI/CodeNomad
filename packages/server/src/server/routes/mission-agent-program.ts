import { missionProgramInput } from "../../missions/program-tool"
import { MissionCalendarMissing } from "../../opencode/mission-calendars"
import type { WorkspaceManager } from "../../workspaces/manager"
import { ownedMissionAgent } from "./mission-agent-owner"
import { missionCalendarConfigurationSchema, runMissionCalendarOperation, type MissionCalendarDeps } from "./mission-calendars"
import { MissionMapMutationError } from "./mission-map-mutation"

type Deps = MissionCalendarDeps & { workspaceManager: MissionCalendarDeps["workspaceManager"] & Pick<WorkspaceManager, "list"> }

/** `mission.program` from a conversation of the project: the programmed Missions of that conversation's
 * directory, through the same operation as the panel. A refusal is an answer; anything else throws. */
export async function controlAgentMissionProgram(deps: Deps, sessionID: string, raw: unknown, signal: AbortSignal) {
  const input = missionProgramInput.parse(raw)
  const agent = await ownedMissionAgent(deps.workspaceManager, sessionID, signal)
  try {
    const outcome = await runMissionCalendarOperation(deps, { workspaceID: agent.workspace.id, directory: agent.session.location.directory, signal,
      wait: operation => operation },
    input.action === "list" ? { kind: "list" }
      : input.action === "save" ? { kind: "save", calendar: input.id!, configuration: missionCalendarConfigurationSchema.parse(input.configuration), paused: input.paused }
        : { kind: input.action, calendar: input.id! })
    await agent.refresh()
    if (!("calendars" in outcome)) return outcome
    return { programs: outcome.calendars.map(calendar => {
      const due = calendar.rules.flatMap(rule => rule.nextDueAt === undefined ? [] : [rule.nextDueAt])
      return { id: calendar.id, title: calendar.title, paused: calendar.paused, ...(calendar.missionID ? { missionID: calendar.missionID } : {}),
        ...(calendar.launch ? { launch: calendar.launch } : {}), ...(due.length && !calendar.paused ? { nextDueAt: Math.min(...due) } : {}),
        ...(calendar.last ? { last: { at: calendar.last.at, outcome: calendar.last.outcome, launches: calendar.last.launches,
          ...(calendar.last.status ? { status: calendar.last.status } : {}) } } : {}) }
    }) }
  } catch (error) {
    if (error instanceof MissionCalendarMissing) return { refused: "calendar-missing" }
    if (error instanceof MissionMapMutationError) return { refused: "calendar-unavailable" }
    throw error
  }
}
