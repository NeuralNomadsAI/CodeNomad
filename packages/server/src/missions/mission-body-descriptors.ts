import { contentDigest, contentText } from "./inspect-view"
import { MISSION_BODY_FIELDS, type MissionBodyDescriptors } from "./mission-content-wire"
import type { MissionMap } from "./model"

/** A descriptor of each of `fields` that `owner` holds. */
export function describe(owner: object, fields: readonly string[]): MissionBodyDescriptors {
  const bodies: MissionBodyDescriptors = {}
  for (const field of fields) {
    const value = (owner as Record<string, unknown>)[field]
    if (value === undefined) continue
    // The text and digest a content read of this field slices and repeats.
    const text = contentText(value)
    bodies[field] = { characters: text.length, digest: contentDigest(text) }
  }
  return bodies
}

/** `mission` as the list and mission reads return it: a descriptor beside each body
 * field (`MISSION_BODY_FIELDS`) of the mission, its tasks, its own `reports` and its
 * plan changes. A copy: the reduced map is unchanged, so content values, which are read
 * from reduced maps, never include descriptors. Each body is serialized once. */
export function describeMissionBodies(mission: MissionMap): MissionMap {
  return {
    ...mission,
    bodies: describe(mission, MISSION_BODY_FIELDS.mission),
    tasks: mission.tasks.map(task => ({ ...task, bodies: describe(task, MISSION_BODY_FIELDS.task) })),
    reports: mission.reports.map(report => ({ ...report, bodies: describe(report, MISSION_BODY_FIELDS.report) })),
    history: mission.history.map(change => ({ ...change, bodies: describe(change, MISSION_BODY_FIELDS.change) })),
  }
}
