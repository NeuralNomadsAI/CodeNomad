import { parseMissionProfiles, missionProfileRoles, freezeCompareProfiles, validateMissionProfiles, type MissionProfiles } from "./playbook-profiles"
import type { MissionTemplateId } from "./model"
import type { MissionExecution } from "./execution"
import { parseMissionTaskMode, type MissionTaskMode } from "./task-execution-mode"

export type { MissionTaskMode } from "./task-execution-mode"
/** `all` is the global default; a mission type entry is an exception overriding it. */
export type MissionDefaultScope = "all" | MissionTemplateId
export interface MissionProfileDefault { template: MissionDefaultScope; profiles: MissionProfiles; taskMode?: MissionTaskMode }
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
      || (entry.taskMode !== undefined && !["native", "independent"].includes(entry.taskMode))
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
  return value.find(item => item.template === template)?.taskMode ?? globalMissionTaskMode(value)
}

export function globalMissionTaskMode(value: readonly MissionProfileDefault[]): MissionTaskMode {
  return value.find(item => item.template === "all")?.taskMode ?? "native"
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

export type MissionDefaultOrigin = "explicit" | "preference" | "opencode-default"
export interface MissionCreationDefaults {
  profiles: Required<MissionProfiles>
  taskMode: MissionTaskMode
  origins: { coordinator: MissionDefaultOrigin; roles: Record<string, MissionDefaultOrigin>; taskMode: MissionDefaultOrigin }
}

/** Resolve whole slots, then freeze Compare's missing judge model against the coordinator. */
export function resolveMissionCreationDefaults(input: {
  template: MissionTemplateId
  preferences: unknown
  profiles?: MissionProfiles
  taskMode?: MissionTaskMode
  coordinatorModel?: MissionExecution["model"]
}): MissionCreationDefaults {
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
  const preferredTaskMode = preferences.find(item => item.template === input.template)?.taskMode
    ?? preferences.find(item => item.template === "all")?.taskMode
  return structuredClone({
    profiles: freezeCompareProfiles(input.template, { coordinator: coordinator.execution, roles }, input.coordinatorModel) as Required<MissionProfiles>,
    taskMode: parseMissionTaskMode(input.taskMode === undefined ? preferredTaskMode : input.taskMode),
    origins: { coordinator: coordinator.origin, roles: origins,
      taskMode: input.taskMode !== undefined ? "explicit" : preferredTaskMode !== undefined ? "preference" : "opencode-default" },
  })
}
