import { parseMissionProfiles, missionProfileRoles, freezeCompareProfiles, validateMissionProfiles, type MissionProfiles } from "./playbook-profiles"
import type { MissionTemplateId } from "./model"
import type { MissionExecution } from "./execution"
import { missionTaskModeInputSchema, parseMissionTaskMode, type MissionTaskMode } from "./task-execution-mode"

export type { MissionTaskMode } from "./task-execution-mode"
/** `all` is the global default; a mission type entry is an exception overriding it. */
export type MissionDefaultScope = "all" | MissionTemplateId
export interface MissionProfileDefault { template: MissionDefaultScope; profiles: MissionProfiles; taskMode?: MissionTaskMode }
export const MISSION_DEFAULT_ORIGINS = ["explicit", "preference", "opencode-default"] as const
export const MISSION_PREFERENCES_UNAVAILABLE = "unavailable"
export type MissionDefaultOrigin = typeof MISSION_DEFAULT_ORIGINS[number]
const scopes: MissionDefaultScope[] = ["all", "custom", "debug", "wayfinder", "delivery", "compare"]
// The global default carries one task profile, like the Flexible specialist.
const scopeRoles = (scope: MissionDefaultScope): readonly string[] => missionProfileRoles[scope === "all" ? "custom" : scope]

/** Preferences carry selectors only, never credentials, execution authority or sessions. */
export function normalizeMissionDefaults(value: unknown): MissionProfileDefault[] {
  if (!Array.isArray(value) || value.length > scopes.length) return []
  const result: MissionProfileDefault[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return []
    const template = entry.template as MissionDefaultScope
    if (Object.keys(entry).some(key => !["template", "profiles", "taskMode"].includes(key))
      || (entry.taskMode !== undefined && !missionTaskModeInputSchema.safeParse(entry.taskMode).success)
      || !scopes.includes(template) || result.some(item => item.template === template)) return []
    try {
      const profiles = parseMissionProfiles(entry.profiles)
      if (!profiles || Object.keys(profiles.roles ?? {}).some(role => !scopeRoles(template).includes(role))) return []
      result.push({ template, profiles, ...(entry.taskMode === undefined ? {} : { taskMode: entry.taskMode }) })
    } catch { return [] }
  }
  // Before the explicit global entry existed, the Flexible entry was the global base:
  // read it as such so no saved choice changes meaning; the next save writes `all`.
  const legacy = result.find(item => item.template === "custom")
  if (legacy && !result.some(item => item.template === "all")) legacy.template = "all"
  return result
}

/** Document to write: a Flexible exception always travels with the explicit global
 * entry, so the legacy decoding above never turns it into the global default. */
export function encodeMissionDefaults(value: readonly MissionProfileDefault[]): MissionProfileDefault[] {
  const flexibleOnly = value.some(item => item.template === "custom") && !value.some(item => item.template === "all")
  return normalizeMissionDefaults(flexibleOnly ? [{ template: "all", profiles: {} }, ...value] : value)
}

export function validMissionDefaults(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && (value.length === 0 || normalizeMissionDefaults(value).length === value.length))
}

/** Type exception ?? global default ?? native. */
export function missionTaskModeFor(value: readonly MissionProfileDefault[], template: MissionTemplateId): MissionTaskMode {
  return resolveTaskMode(value, template).taskMode
}

export function globalMissionTaskMode(value: readonly MissionProfileDefault[]): MissionTaskMode {
  return resolveTaskMode(value, "all").taskMode
}

function resolveTaskMode(value: readonly MissionProfileDefault[], template: MissionDefaultScope, explicit?: MissionTaskMode): {
  taskMode: MissionTaskMode; origin: MissionDefaultOrigin
} {
  const preferred = value.find(item => item.template === template)?.taskMode
    ?? (template === "all" ? undefined : value.find(item => item.template === "all")?.taskMode)
  return { taskMode: parseMissionTaskMode(explicit === undefined ? preferred : explicit),
    origin: explicit !== undefined ? "explicit" : preferred !== undefined ? "preference" : "opencode-default" }
}

/** Resolve a copy when the creation form opens. Existing missions never consult defaults. */
export function missionDefaultsFor(value: readonly MissionProfileDefault[], template: MissionTemplateId, exceptions = true): MissionProfiles | undefined {
  const base = value.find(item => item.template === "all")?.profiles
  const specific = exceptions ? value.find(item => item.template === template)?.profiles : undefined
  const coordinator = specific?.coordinator ?? base?.coordinator
  const roles = Object.fromEntries(missionProfileRoles[template].flatMap(role => {
    const execution = specific?.roles?.[role] ?? (template === "compare" && role === "comparator" ? undefined : base?.roles?.specialist)
    return execution ? [[role, execution]] : []
  }))
  if (!coordinator && !Object.keys(roles).length) return undefined
  return structuredClone({ ...(coordinator ? { coordinator } : {}), ...(Object.keys(roles).length ? { roles } : {}) })
}

export class MissionPreferencesError extends Error {
  readonly code = "mission-preferences-invalid"
  constructor() {
    super("Invalid mission profile defaults")
    this.name = "MissionPreferencesError"
  }
}

export interface MissionCreationSelection {
  preferences?: typeof MISSION_PREFERENCES_UNAVAILABLE
  profiles: Required<MissionProfiles>
  taskMode: MissionTaskMode
  origins: { coordinator: MissionDefaultOrigin; roles: Record<string, MissionDefaultOrigin>; taskMode: MissionDefaultOrigin }
}

/** Whole explicit slots and an explicit policy leave nothing for preferences to supply. */
export function hasExplicitMissionCreationChoices(input: {
  template: MissionTemplateId; profiles?: MissionProfiles; taskMode?: MissionTaskMode
}): boolean {
  return input.taskMode !== undefined && input.profiles?.coordinator !== undefined
    && missionProfileRoles[input.template].every(role => input.profiles?.roles?.[role] !== undefined)
}

/** Resolve whole slots, then freeze Compare's missing judge model against the coordinator. */
export function resolveMissionCreationDefaults(input: {
  template: MissionTemplateId
  preferences: unknown
  profiles?: MissionProfiles
  taskMode?: MissionTaskMode
  coordinatorModel?: MissionExecution["model"]
}): MissionCreationSelection {
  if (!validMissionDefaults(input.preferences)) throw new MissionPreferencesError()
  const preferences = normalizeMissionDefaults(input.preferences)
  const defaults = missionDefaultsFor(preferences, input.template)
  const explicit = parseMissionProfiles(input.profiles)
  validateMissionProfiles(input.template, explicit)
  const slot = (requested?: MissionExecution, preferred?: MissionExecution): { execution: MissionExecution; origin: MissionDefaultOrigin } => ({
    execution: requested ?? preferred ?? {},
    origin: requested !== undefined ? "explicit" : preferred !== undefined ? "preference" : "opencode-default",
  })
  const coordinator = slot(explicit?.coordinator, defaults?.coordinator)
  const roles: Record<string, MissionExecution> = {}
  const origins: Record<string, MissionDefaultOrigin> = {}
  for (const role of missionProfileRoles[input.template]) {
    const selected = slot(explicit?.roles?.[role], defaults?.roles?.[role])
    if (input.template === "compare" && role === "comparator" && selected.origin === "opencode-default") {
      selected.origin = coordinator.origin
    }
    roles[role] = selected.execution
    origins[role] = selected.origin
  }
  const taskMode = resolveTaskMode(preferences, input.template, input.taskMode)
  return structuredClone({
    profiles: freezeCompareProfiles(input.template, { coordinator: coordinator.execution, roles }, input.coordinatorModel) as Required<MissionProfiles>,
    taskMode: taskMode.taskMode,
    origins: { coordinator: coordinator.origin, roles: origins, taskMode: taskMode.origin },
  })
}
