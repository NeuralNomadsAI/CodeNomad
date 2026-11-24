import type { MissionExecution } from "../../../server/src/missions/execution"
import type { MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import type { MissionTemplateId } from "../../../server/src/missions/model"
import { missionProfileRoles } from "../../../server/src/missions/playbook-profiles"
import { compareCatalogModels, type CatalogModel } from "../lib/model-catalog"
export { missionProfileRoles }

export interface ProfileAgent { id: string; mode: string; hidden?: boolean }
/** A tool-capable catalog model, named as the conversation's model selector names it. */
export type ProfileModel = CatalogModel

export function legalProfileAgents(agents: readonly ProfileAgent[], kind: "coordinator" | "native" | "independent"): ProfileAgent[] {
  const modes = kind === "native" ? ["subagent", "all"] : ["primary", "all"]
  return agents.filter(agent => !agent.hidden && modes.includes(agent.mode))
}

export function modelSelectionKey(model?: MissionExecution["model"]): string {
  return model ? JSON.stringify([model.providerID, model.id]) : ""
}

export function profileModelKey(model: Pick<ProfileModel, "providerId" | "id">): string {
  return modelSelectionKey({ providerID: model.providerId, id: model.id })
}

export function changeProfileModel(execution: MissionExecution | undefined, key: string, models: readonly ProfileModel[]): MissionExecution {
  const model = models.find(model => profileModelKey(model) === key)
  // A model switch cannot carry an incompatible variant into the new model.
  return { ...(execution?.agent ? { agent: execution.agent } : {}), ...(model ? { model: { providerID: model.providerId, id: model.id } } : {}) }
}

export interface ProfileModelGroup { providerId: string; providerName: string; models: ProfileModel[] }

/** The Model select's provider groups: the conversation selector's list, plus a saved
 *  catalog model it leaves out (hidden, or not a favorite) so that choice stays shown. */
export function profileModelGroups(shown: readonly ProfileModel[], saved?: ProfileModel): ProfileModelGroup[] {
  const models = saved && !shown.some(model => profileModelKey(model) === profileModelKey(saved))
    ? [...shown, saved].sort(compareCatalogModels) : shown
  const groups: ProfileModelGroup[] = []
  for (const model of models) {
    const last = groups.at(-1)
    if (last?.providerId === model.providerId) last.models.push(model)
    else groups.push({ providerId: model.providerId, providerName: model.providerName, models: [model] })
  }
  return groups
}

export function changeMissionProfile(profiles: MissionProfiles | undefined, role: string, execution: MissionExecution): MissionProfiles | undefined {
  const selected = execution.agent !== undefined || execution.model !== undefined
  const coordinator = role === "coordinator" ? (selected ? execution : undefined) : profiles?.coordinator
  const roles = { ...profiles?.roles }
  if (role !== "coordinator") {
    if (selected) roles[role] = execution
    else delete roles[role]
  }
  return coordinator || Object.keys(roles).length ? {
    ...(coordinator ? { coordinator } : {}), ...(Object.keys(roles).length ? { roles } : {}),
  } : undefined
}

/** A mission type's own choice for one role: any execution, even the all-native `{}`,
 *  overrides the inherited global one; `undefined` inherits it again. */
export function setMissionProfileRole(profiles: MissionProfiles | undefined, role: string, execution?: MissionExecution): MissionProfiles | undefined {
  const choice = execution && { ...(execution.agent ? { agent: execution.agent } : {}), ...(execution.model ? { model: execution.model } : {}) }
  const coordinator = role === "coordinator" ? choice : profiles?.coordinator
  const roles = { ...profiles?.roles }
  if (role !== "coordinator") {
    if (choice) roles[role] = choice
    else delete roles[role]
  }
  return coordinator || Object.keys(roles).length ? {
    ...(coordinator ? { coordinator } : {}), ...(Object.keys(roles).length ? { roles } : {}),
  } : undefined
}

/** An explicit template change drops only presets that are not legal there. */
export function profilesForTemplate(profiles: MissionProfiles | undefined, template: MissionTemplateId): MissionProfiles | undefined {
  if (!profiles) return undefined
  const allowed: readonly string[] = missionProfileRoles[template]
  const roles = Object.fromEntries(Object.entries(profiles.roles ?? {}).filter(([role]) => allowed.includes(role)))
  return profiles.coordinator || Object.keys(roles).length ? {
    ...(profiles.coordinator ? { coordinator: profiles.coordinator } : {}), ...(Object.keys(roles).length ? { roles } : {}),
  } : undefined
}
