import { parseMissionProfiles, missionProfileRoles, type MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import type { MissionTemplateId } from "../../../server/src/missions/model"
import { normalizeStoredTemplateId } from "../../../server/src/missions/template-id"

export type MissionTaskMode = "native" | "independent"
/** `all` is the global default; a mission type entry is an exception overriding it. */
export type MissionDefaultScope = "all" | MissionTemplateId
export interface MissionProfileDefault { template: MissionDefaultScope; profiles: MissionProfiles; taskMode?: MissionTaskMode }
const scopes: MissionDefaultScope[] = ["all", "custom", "debug", "wayfinder"]
// The global default carries one task profile, like the Flexible specialist.
const scopeRoles = (scope: MissionDefaultScope): readonly string[] => missionProfileRoles[scope === "all" ? "custom" : scope]

/** Preferences carry selectors only, never credentials, execution authority or sessions. */
export function normalizeMissionDefaults(value: unknown): MissionProfileDefault[] {
  if (!Array.isArray(value) || value.length > scopes.length) return []
  const result: MissionProfileDefault[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return []
    const template = normalizeStoredTemplateId(entry.template) as MissionDefaultScope
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
    const execution = specific?.roles?.[role] ?? base?.roles?.specialist
    return execution ? [[role, execution]] : []
  }))
  if (!coordinator && !Object.keys(roles).length) return undefined
  return structuredClone({ ...(coordinator ? { coordinator } : {}), ...(Object.keys(roles).length ? { roles } : {}) })
}
