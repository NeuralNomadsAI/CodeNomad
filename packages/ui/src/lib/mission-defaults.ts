import { parseMissionProfiles, missionProfileRoles, type MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import type { MissionTemplateId } from "../../../server/src/missions/model"

export type MissionTaskMode = "native" | "independent"
export interface MissionProfileDefault { template: MissionTemplateId; profiles: MissionProfiles; taskMode?: MissionTaskMode }
const templates: MissionTemplateId[] = ["custom", "pocock-fix-bug", "wayfinder"]

/** Preferences carry selectors only, never credentials, execution authority or sessions. */
export function normalizeMissionDefaults(value: unknown): MissionProfileDefault[] {
  if (!Array.isArray(value) || value.length > templates.length) return []
  const result: MissionProfileDefault[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).some(key => !["template", "profiles", "taskMode"].includes(key))
      || (entry.taskMode !== undefined && !["native", "independent"].includes(entry.taskMode))
      || !templates.includes(entry.template) || result.some(item => item.template === entry.template)) return []
    try {
      const profiles = parseMissionProfiles(entry.profiles)
      if (!profiles || Object.keys(profiles.roles ?? {}).some(role => !(missionProfileRoles[entry.template as MissionTemplateId] as readonly string[]).includes(role))) return []
      result.push({ template: entry.template, profiles, ...(entry.taskMode === undefined ? {} : { taskMode: entry.taskMode }) })
    } catch { return [] }
  }
  return result
}

export function validMissionDefaults(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && (value.length === 0 || normalizeMissionDefaults(value).length === value.length))
}

export function missionTaskModeFor(value: readonly MissionProfileDefault[], template: MissionTemplateId): MissionTaskMode {
  return value.find(item => item.template === template)?.taskMode ?? value.find(item => item.template === "custom")?.taskMode ?? "native"
}

/** Resolve a copy when the creation form opens. Existing missions never consult defaults. */
export function missionDefaultsFor(value: readonly MissionProfileDefault[], template: MissionTemplateId): MissionProfiles | undefined {
  const base = value.find(item => item.template === "custom")?.profiles
  const specific = value.find(item => item.template === template)?.profiles
  const coordinator = specific?.coordinator ?? base?.coordinator
  const roles = Object.fromEntries(missionProfileRoles[template].flatMap(role => {
    const execution = specific?.roles?.[role] ?? base?.roles?.specialist
    return execution ? [[role, execution]] : []
  }))
  if (!coordinator && !Object.keys(roles).length) return undefined
  return structuredClone({ ...(coordinator ? { coordinator } : {}), ...(Object.keys(roles).length ? { roles } : {}) })
}
