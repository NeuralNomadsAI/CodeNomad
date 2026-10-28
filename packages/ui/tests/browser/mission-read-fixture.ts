import type { MissionMap } from "../../../server/src/api-types"

/** The single-mission reads (`GET …/missions/:missionID` and its `/admission`
 * full-snapshot form) answered from a fixture's maps; undefined for any other path. */
export function missionReadFixture(pathname: string, method: string, values: readonly MissionMap[], projectID = "project") {
  const match = /\/missions\/([^/]+)(?:\/admission)?$/.exec(pathname)
  if (!match || match[1] === "recurrence" || method !== "GET") return undefined
  const mission = values.find(value => value.id === decodeURIComponent(match[1]))
  return { available: true, version: 1, projectID, generatedAt: 1, cleanups: [], ...(mission ? { mission } : {}) }
}
