import type { MissionMap } from "../../../server/src/api-types"
import type { MissionExecution } from "../../../server/src/missions/execution"
import type { MissionProfiles } from "../../../server/src/missions/playbook-profiles"

export interface UncertainMissionCreation {
  requestId: string
  objective: string
  notes: string
  template: MissionMap["template"]
  directory?: string
  profiles?: MissionProfiles
}

// Window-memory only, not native settlement authority or restart persistence.
// Retain unknown operations by their original scope/request; reads cannot clear
// these holds. No drafts are written into the identity-only native view layout.
const held = new Map<string, Map<string, Readonly<UncertainMissionCreation>>>()

export function retainUncertainMissionCreation(scope: string, operation: UncertainMissionCreation): void {
  const operations = held.get(scope) ?? new Map<string, Readonly<UncertainMissionCreation>>()
  if (!operations.has(operation.requestId)) operations.set(operation.requestId, Object.freeze({
    ...operation, ...(operation.profiles === undefined ? {} : { profiles: copyMissionProfiles(operation.profiles) }),
  }))
  held.set(scope, operations)
}

export function uncertainMissionCreation(scope: string): Readonly<UncertainMissionCreation> | undefined {
  return held.get(scope)?.values().next().value
}

/** Copy before freezing: the caller's editable signals remain caller-owned. */
export function copyMissionProfiles(profiles?: MissionProfiles): MissionProfiles | undefined {
  if (!profiles) return undefined
  const copy = (execution: MissionExecution): MissionExecution => Object.freeze({
    ...(execution.agent === undefined ? {} : { agent: execution.agent }),
    ...(execution.model === undefined ? {} : { model: Object.freeze({ ...execution.model }) }),
  })
  return Object.freeze({
    ...(profiles.coordinator === undefined ? {} : { coordinator: copy(profiles.coordinator) }),
    ...(profiles.roles === undefined ? {} : { roles: Object.freeze(Object.fromEntries(Object.entries(profiles.roles).map(([role, execution]) => [role, copy(execution)]))) }),
  })
}

/** Stable request identity includes every profile field and optional absence. */
export function missionCreationPayloadIdentity(operation: Omit<UncertainMissionCreation, "requestId">): string {
  const execution = (value?: MissionExecution) => value === undefined ? null : [value.agent ?? null,
    value.model ? [value.model.providerID, value.model.id, value.model.variant ?? null] : null]
  const profiles = operation.profiles
  return JSON.stringify([operation.objective, operation.notes, operation.template, operation.directory ?? null,
    profiles === undefined ? null : [execution(profiles.coordinator), profiles.roles === undefined ? null
      : Object.keys(profiles.roles).sort().map(role => [role, execution(profiles.roles![role])])]])
}
