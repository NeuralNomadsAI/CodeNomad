import type { MissionMap } from "../../../server/src/api-types"

/** Fixed application-authored request. Objective/notes stay native data, not interpolated instructions. */
export function missionBriefingRequestText(mission: MissionMap, requestID: string, locale: string): string {
  return `CodeNomad project briefing request.
Mission ID: ${mission.id}
Request ID: ${requestID}
Response language: ${locale}

Make a short user-facing assessment of the whole project, including every requested workstream. Inspect this exact mission's current map and use actual returned results and existing evidence. Do not perform new tests, run or replay tasks, restart the mission, change its plan or priorities, install anything, or publish anything in order to answer this request. This request grants no additional execution or human-consent authority.

Publish through mission.briefing with this exact requestID and missionID, and the freshly inspected revision as basedOnRevision. Provide a plain-language summary (what is usable versus still unverified) and up to three concise entries in each section: achieved, ongoing, obstacles, next. Entries have text and exact live source taskKeys (an empty array if no task supports the statement). Preserve distinctions between past obstacles and current ones, preparation and delivery, conversation activity and task execution. State uncertainty instead of inventing progress, percentages, completion or human approval. Include the next step towards the user's objective; use native Forms/permissions for any actual question, not a fabricated response alert.

This is an on-demand readout, not a request for periodic updates or a report after every task. If the map revision changes before publication, inspect again and update the readout; never replay work. If the briefing tool is unavailable, explain that in the conversation; do not create a substitute task or claim that the Missions panel has been updated.`
}
