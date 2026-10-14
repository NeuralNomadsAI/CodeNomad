import type { MissionExecution } from "../../../server/src/missions/execution"
import { missionProfileRoles, type MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import type { MissionTemplateId } from "../../../server/src/missions/model"

export interface MissionProfileSummaryGroup { roles: string[]; execution?: MissionExecution }

/** Requested agent/model/variant text, or undefined for the native default. */
export function missionExecutionLabel(execution: MissionExecution | undefined): string | undefined {
  return [execution?.agent, execution?.model && `${execution.model.providerID}/${execution.model.id}`, execution?.model?.variant].filter(Boolean).join(" / ") || undefined
}

/** Group effective requested tuples only, without reading catalog or live actors. */
export function groupMissionProfileSummary(profiles: MissionProfiles | undefined, template: MissionTemplateId): MissionProfileSummaryGroup[] {
  const groups = new Map<string, MissionProfileSummaryGroup>()
  for (const role of ["coordinator", ...missionProfileRoles[template]]) {
    const requested = role === "coordinator" ? profiles?.coordinator : profiles?.roles?.[role]
    const execution = requested?.agent || requested?.model ? requested : undefined
    const key = JSON.stringify([execution?.agent ?? null, execution?.model?.providerID ?? null,
      execution?.model?.id ?? null, execution?.model?.variant ?? null])
    const existing = groups.get(key)
    if (existing) existing.roles.push(role)
    else groups.set(key, { roles: [role], ...(execution ? { execution } : {}) })
  }
  return [...groups.values()]
}
