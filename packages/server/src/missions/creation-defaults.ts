import { z } from "zod"
import type { MissionMap, MissionTemplateId } from "./model"
import { missionProfileRoles, missionProfilesInputSchema, missionProfilesSchema, sameMissionProfiles, validateMissionProfiles } from "./playbook-profiles"
import { missionTaskModeInputSchema, missionTaskModeSchema } from "./task-execution-mode"
import { MISSION_DEFAULT_ORIGINS, MISSION_PREFERENCES_UNAVAILABLE, missionCreationSelectionSchema, type MissionCreationSelection } from "./profile-defaults"
import { MissionControlError } from "./control-error"
import { parseExecution } from "./execution"
import { MISSION_DEFAULTS_REQUEST_INVALID } from "./recovery-error"

export const MISSION_CREATION_REQUEST_CONFLICT = "Creation request ID was already used with a different mission"
export const missionCreationTemplateSchema = z.enum(Object.keys(missionProfileRoles) as [MissionTemplateId, ...MissionTemplateId[]])
export const missionCreationChoicesSchema = z.object({ profiles: missionProfilesInputSchema, taskMode: missionTaskModeInputSchema.optional() }).strict()
const defaultsInputSchema = missionCreationChoicesSchema.extend({
  template: missionCreationTemplateSchema,
  coordinatorModel: z.unknown().transform((model, context) => {
    try { return parseExecution({ model })?.model }
    catch { context.addIssue({ code: "custom", message: "Invalid coordinator model" }); return z.NEVER }
  }).optional(),
}).strict()

export function parseMissionCreationDefaultsInput(input: unknown) {
  const parsed = defaultsInputSchema.safeParse(input)
  if (!parsed.success) throw new MissionControlError(MISSION_DEFAULTS_REQUEST_INVALID, "invalid-execution")
  try { validateMissionProfiles(parsed.data.template, parsed.data.profiles) }
  catch { throw new MissionControlError("Correct profiles.roles to use roles from the selected playbook", "invalid-execution") }
  return parsed.data
}
export const missionCreationDefaultsSchema = missionCreationSelectionSchema.extend({ request: missionCreationChoicesSchema }).strict()
export type MissionCreationChoices = z.infer<typeof missionCreationChoicesSchema>
export type MissionCreationMetadata = z.infer<typeof missionCreationDefaultsSchema>

export function missionCreationChoices(input: MissionCreationChoices): MissionCreationChoices {
  return structuredClone({ ...(input.profiles === undefined ? {} : { profiles: input.profiles }), ...(input.taskMode === undefined ? {} : { taskMode: input.taskMode }) })
}
export function sameMissionCreationChoices(left: MissionCreationChoices, right: MissionCreationChoices): boolean {
  return left.taskMode === right.taskMode && sameMissionProfiles(left.profiles, right.profiles)
}

function validateOrigins(template: MissionTemplateId, origins: MissionCreationSelection["origins"]) {
  const roles: readonly string[] = missionProfileRoles[template]
  if (Object.keys(origins.roles).length !== roles.length || roles.some(role => origins.roles[role] === undefined)) throw new Error("Invalid Mission profile origins")
}

/** Trusted transport and durable journal use the same bounded selector codec. */
export function parseMissionCreationDefaults(template: MissionTemplateId, input: unknown): MissionCreationMetadata {
  const value = missionCreationDefaultsSchema.parse(input)
  validateMissionProfiles(template, value.request.profiles)
  parseMissionCreationSelection(template, { profiles: value.profiles, taskMode: value.taskMode, origins: value.origins })
  return value
}

export function parseMissionCreationSelection(template: MissionTemplateId, input: unknown): MissionCreationSelection {
  const value = missionCreationSelectionSchema.parse(input)
  validateOrigins(template, value.origins)
  validateMissionProfiles(template, value.profiles)
  if (Object.keys(value.profiles.roles).length !== missionProfileRoles[template].length) throw new Error("Incomplete Mission profile selection")
  return value
}

/** Historical missions retain absent provenance; reads never consult preferences. */
export function missionCreationSelection(mission: Pick<MissionMap, "profiles" | "taskMode" | "creationDefaults">): MissionCreationSelection | undefined {
  if (!mission.creationDefaults) return undefined
  return structuredClone({ profiles: mission.creationDefaults.profiles,
    taskMode: mission.creationDefaults.taskMode, origins: mission.creationDefaults.origins,
    ...(mission.creationDefaults.preferences === undefined ? {} : { preferences: mission.creationDefaults.preferences }) })
}

const originWire = { type: "string", enum: MISSION_DEFAULT_ORIGINS } as const
export const missionCreationDefaultsWire = {
  type: "object", properties: {
    request: { type: "object", properties: { profiles: missionProfilesSchema, taskMode: missionTaskModeSchema }, additionalProperties: false },
    profiles: missionProfilesSchema, taskMode: missionTaskModeSchema,
    preferences: { type: "string", enum: [MISSION_PREFERENCES_UNAVAILABLE] },
    origins: { type: "object", properties: { coordinator: originWire, taskMode: originWire,
      roles: { type: "object", maxProperties: Math.max(...Object.values(missionProfileRoles).map(roles => roles.length)), additionalProperties: originWire } }, required: ["coordinator", "roles", "taskMode"], additionalProperties: false },
  }, required: ["request", "profiles", "taskMode", "origins"], additionalProperties: false,
} as const
