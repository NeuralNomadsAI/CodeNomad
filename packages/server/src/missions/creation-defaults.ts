import { z } from "zod"
import type { MissionMap, MissionTemplateId } from "./model"
import { missionProfileRoles, missionProfilesInputSchema, missionProfilesSchema, sameMissionProfiles, validateMissionProfiles, type MissionProfiles } from "./playbook-profiles"
import { missionTaskModeInputSchema, missionTaskModeSchema, type MissionTaskMode } from "./task-execution-mode"

const origin = z.enum(["explicit", "preference", "opencode-default"])
export const missionCreationChoicesSchema = z.object({ profiles: missionProfilesInputSchema, taskMode: missionTaskModeInputSchema.optional() }).strict()
const originsSchema = z.object({ coordinator: origin, roles: z.record(z.string(), origin), taskMode: origin }).strict()
export const missionCreationDefaultsSchema = z.object({ request: missionCreationChoicesSchema, profiles: missionProfilesInputSchema,
  taskMode: missionTaskModeInputSchema, origins: originsSchema }).strict()
const resolutionSchema = z.object({ profiles: missionProfilesInputSchema, taskMode: missionTaskModeInputSchema, origins: originsSchema }).strict()
export type MissionCreationChoices = z.infer<typeof missionCreationChoicesSchema>
export type MissionCreationDefaults = z.infer<typeof missionCreationDefaultsSchema>
export type MissionCreationSelection = { profiles: MissionProfiles; taskMode: MissionTaskMode; origins: MissionCreationDefaults["origins"] }

export function missionCreationChoices(input: MissionCreationChoices): MissionCreationChoices {
  return structuredClone({ ...(input.profiles === undefined ? {} : { profiles: input.profiles }), ...(input.taskMode === undefined ? {} : { taskMode: input.taskMode }) })
}
export function sameMissionCreationChoices(left: MissionCreationChoices, right: MissionCreationChoices): boolean {
  return left.taskMode === right.taskMode && sameMissionProfiles(left.profiles, right.profiles)
}

function validateOrigins(template: MissionTemplateId, origins: MissionCreationDefaults["origins"]) {
  const roles: readonly string[] = missionProfileRoles[template]
  if (Object.keys(origins.roles).length !== roles.length || roles.some(role => origins.roles[role] === undefined)) throw new Error("Invalid Mission profile origins")
}

/** Trusted transport and durable journal use the same bounded selector codec. */
export function parseMissionCreationDefaults(template: MissionTemplateId, input: unknown): MissionCreationDefaults {
  const value = missionCreationDefaultsSchema.parse(input)
  validateMissionProfiles(template, value.request.profiles)
  parseMissionCreationSelection(template, { profiles: value.profiles, taskMode: value.taskMode, origins: value.origins })
  return value
}

export function parseMissionCreationSelection(template: MissionTemplateId, input: unknown): MissionCreationSelection {
  const value = resolutionSchema.parse(input)
  validateOrigins(template, value.origins)
  validateMissionProfiles(template, value.profiles)
  if (!value.profiles?.coordinator || Object.keys(value.profiles.roles ?? {}).length !== missionProfileRoles[template].length) throw new Error("Incomplete Mission profile selection")
  return value as MissionCreationSelection
}

/** Historical missions retain absent provenance; reads never consult preferences. */
export function missionCreationSelection(mission: Pick<MissionMap, "profiles" | "taskMode" | "creationDefaults">): MissionCreationSelection | undefined {
  if (!mission.creationDefaults) return undefined
  return structuredClone({ profiles: mission.creationDefaults.profiles!, taskMode: mission.creationDefaults.taskMode, origins: mission.creationDefaults.origins })
}

const originWire = { type: "string", enum: ["explicit", "preference", "opencode-default"] } as const
export const missionCreationDefaultsWire = {
  type: "object", properties: {
    request: { type: "object", properties: { profiles: missionProfilesSchema, taskMode: missionTaskModeSchema }, additionalProperties: false },
    profiles: missionProfilesSchema, taskMode: missionTaskModeSchema,
    origins: { type: "object", properties: { coordinator: originWire, taskMode: originWire,
      roles: { type: "object", maxProperties: 6, additionalProperties: originWire } }, required: ["coordinator", "roles", "taskMode"], additionalProperties: false },
  }, required: ["request", "profiles", "taskMode", "origins"], additionalProperties: false,
} as const
