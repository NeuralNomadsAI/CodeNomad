import type { MissionExecution } from "../../../server/src/missions/execution"
import type { MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import type { MissionTemplateId } from "../../../server/src/missions/model"
import { missionProfileRoles } from "../../../server/src/missions/playbook-profiles"
export { missionProfileRoles }

export interface ProfileAgent { id: string; mode: string; hidden?: boolean }
export interface ProfileModel { providerID: string; id: string; variants: readonly { id: string }[] }

export function legalProfileAgents(agents: readonly ProfileAgent[], kind: "coordinator" | "native" | "independent"): ProfileAgent[] {
  const modes = kind === "native" ? ["subagent", "all"] : ["primary", "all"]
  return agents.filter(agent => !agent.hidden && modes.includes(agent.mode))
}

export function modelSelectionKey(model?: MissionExecution["model"]): string {
  return model ? JSON.stringify([model.providerID, model.id]) : ""
}

export function changeProfileModel(execution: MissionExecution | undefined, key: string, models: readonly ProfileModel[]): MissionExecution {
  const model = models.find(model => modelSelectionKey(model) === key)
  // A model switch cannot carry an incompatible variant into the new model.
  return { ...(execution?.agent ? { agent: execution.agent } : {}), ...(model ? { model: { providerID: model.providerID, id: model.id } } : {}) }
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

/** An explicit template change drops only presets that are not legal there. */
export function profilesForTemplate(profiles: MissionProfiles | undefined, template: MissionTemplateId): MissionProfiles | undefined {
  if (!profiles) return undefined
  const allowed: readonly string[] = missionProfileRoles[template]
  const roles = Object.fromEntries(Object.entries(profiles.roles ?? {}).filter(([role]) => allowed.includes(role)))
  return profiles.coordinator || Object.keys(roles).length ? {
    ...(profiles.coordinator ? { coordinator: profiles.coordinator } : {}), ...(Object.keys(roles).length ? { roles } : {}),
  } : undefined
}
