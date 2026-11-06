import { missionDefaultsFor, type MissionProfileDefault } from "../../../server/src/missions/profile-defaults"
import { freezeCompareProfiles, type MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import type { MissionTemplateId } from "../../../server/src/missions/model"

export { encodeMissionDefaults, globalMissionTaskMode, missionDefaultsFor, missionTaskModeFor,
  normalizeMissionDefaults, validMissionDefaults } from "../../../server/src/missions/profile-defaults"
export type { MissionDefaultScope, MissionProfileDefault, MissionTaskMode } from "../../../server/src/missions/profile-defaults"

/** Keep the editable choices separate from Compare's creation-time judge inheritance. */
export function effectiveMissionProfiles(template: MissionTemplateId,
  input: { defaults: readonly MissionProfileDefault[] } | { profiles: MissionProfiles | undefined }) {
  const draft = "defaults" in input ? missionDefaultsFor(input.defaults, template) : input.profiles
  return { draft, payload: freezeCompareProfiles(template, draft) }
}
