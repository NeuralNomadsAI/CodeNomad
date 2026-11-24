import { executionSchema, parseExecution, sameExecution, type MissionExecution } from "./execution"
import type { MissionTemplateId } from "./model"
import { z } from "zod"
import type { MissionTaskMode } from "./task-execution-mode"

/** Creation-time requests, not proof of a mutable session's current profile. */
export interface MissionProfiles {
  coordinator?: MissionExecution
  roles?: Record<string, MissionExecution>
}

export const missionProfileRoles = {
  custom: ["specialist"],
  debug: ["review-standards", "review-spec", "validator", "diagnostician", "implementer", "resolver"],
  wayfinder: ["cartographer", "research", "prototype", "grilling", "decision"],
  delivery: ["business-analyst", "technical-architect", "tech-lead", "developer", "qa-engineer", "ui-ux-designer"],
  compare: ["model-a", "model-b", "comparator"],
} as const satisfies Record<MissionTemplateId, readonly string[]>
const allowedRoles: readonly string[] = [...new Set(Object.values(missionProfileRoles).flat())]
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)

export const missionProfilesSchema = {
  type: "object",
  properties: {
    coordinator: executionSchema,
    roles: {
      type: "object", maxProperties: allowedRoles.length,
      properties: Object.fromEntries(allowedRoles.map(role => [role, executionSchema])),
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error("Invalid mission profiles")
  return input as Record<string, unknown>
}

function selection(input: unknown): MissionExecution {
  const value = record(input)
  if (value.model !== undefined) record(value.model)
  const execution = parseExecution(input)
  if (!execution) throw new Error("Invalid mission profile selection")
  return {
    ...(execution.agent === undefined ? {} : { agent: execution.agent }),
    ...(execution.model === undefined ? {} : { model: { ...execution.model } }),
  }
}

/** Unknown fields/roles fail closed; no migration or default injection. */
export function parseMissionProfiles(input: unknown): MissionProfiles | undefined {
  if (input === undefined) return undefined
  const value = record(input)
  if (Object.keys(value).some(key => key !== "coordinator" && key !== "roles")) throw new Error("Unknown mission profile field")
  const result: MissionProfiles = {}
  if (hasOwn(value, "coordinator")) result.coordinator = selection(value.coordinator)
  if (hasOwn(value, "roles")) {
    const roles = record(value.roles), entries = Object.entries(roles)
    if (entries.length > allowedRoles.length || entries.some(([role]) => !allowedRoles.includes(role))) {
      throw new Error("Unknown mission profile role")
    }
    result.roles = Object.fromEntries(entries.map(([role, execution]) => [role, selection(execution)]))
  }
  return result
}

/** HTTP and signed intent inputs use the same strict durable codec. */
export const missionProfilesInputSchema = z.unknown().transform((input, context) => {
  try { return parseMissionProfiles(input) }
  catch { context.addIssue({ code: "custom", message: "Invalid mission profiles" }); return z.NEVER }
}).optional()

export function validateMissionProfiles(template: MissionTemplateId, profiles?: MissionProfiles): void {
  const roles: readonly string[] = missionProfileRoles[template]
  if (Object.keys(profiles?.roles ?? {}).some(role => !roles.includes(role))) throw new Error("Mission profile role does not belong to this playbook")
}

export function sameCompareModel(a?: MissionExecution["model"], b?: MissionExecution["model"]): boolean {
  return Boolean(a && b && a.providerID === b.providerID && a.id === b.id)
}

export function compareModelError(profiles?: MissionProfiles): "compare-models-required" | "compare-models-identical" | undefined {
  const a = profiles?.roles?.["model-a"]?.model, b = profiles?.roles?.["model-b"]?.model
  if (!a || !b) return "compare-models-required"
  if (sameCompareModel(a, b)) return "compare-models-identical"
}

export function missionRoleProfile(template: MissionTemplateId, profiles: MissionProfiles | undefined, role: string): MissionExecution | undefined {
  const own = profiles?.roles?.[role]
  if (template !== "compare" || role !== "comparator") return own
  return own || profiles?.coordinator?.model ? { ...own, model: own?.model ?? profiles?.coordinator?.model } : undefined
}

/** Freeze only at creation/payload construction, never against a later actor model.
 * With no known coordinator model, leave both on the same native default. */
export function freezeCompareProfiles(template: MissionTemplateId, profiles: MissionProfiles | undefined,
  coordinatorModel?: MissionExecution["model"]): MissionProfiles | undefined {
  if (template !== "compare") return profiles
  const judge = missionRoleProfile(template, profiles, "comparator")
  const model = judge?.model ?? (coordinatorModel?.variant === "default"
    ? { providerID: coordinatorModel.providerID, id: coordinatorModel.id } : coordinatorModel)
  return model ? { ...profiles, roles: { ...profiles?.roles, comparator: { ...judge, model: structuredClone(model) } } } : profiles
}

export function compareModelNames(profiles?: MissionProfiles): [string, string] {
  return ["model-a", "model-b"].map(role => {
    const model = profiles?.roles?.[role]?.model
    return model ? `${model.providerID}/${model.id}` : role
  }) as [string, string]
}

/** Exact logical retry identity, independent of object/key insertion order. */
export function sameMissionProfiles(left?: MissionProfiles, right?: MissionProfiles): boolean {
  if (!left || !right) return left === right
  if (Boolean(left.coordinator) !== Boolean(right.coordinator) || !sameExecution(left.coordinator, right.coordinator)) return false
  if (Boolean(left.roles) !== Boolean(right.roles)) return false
  const leftRoles = Object.keys(left.roles ?? {}), rightRoles = Object.keys(right.roles ?? {})
  return leftRoles.length === rightRoles.length && leftRoles.every(role => hasOwn(right.roles ?? {}, role)
    && sameExecution(left.roles![role], right.roles![role]))
}

/** Caller supplies one fresh owned native catalog; presets target future children. */
export function validateMissionProfileCatalog(profiles: MissionProfiles | undefined, catalog: {
  agents: readonly { id: string; mode: string; hidden?: boolean }[]
  models: readonly { providerID: string; id: string; variants: readonly string[] }[]
}, taskMode: MissionTaskMode = "native"): void {
  if (!profiles || (!profiles.coordinator && !Object.keys(profiles.roles ?? {}).length)) return
  const validate = (execution: MissionExecution, child: boolean) => {
    if (execution.agent !== undefined) {
      const agent = catalog.agents.find(agent => agent.id === execution.agent && !agent.hidden)
      if (!agent || !(child ? ["subagent", "all"] : ["primary", "all"]).includes(agent.mode)) {
        throw new Error(child ? "Choose a visible subagent/all agent for a native task profile" : "Choose a visible primary/all agent for a coordinator or independent task profile")
      }
    }
    if (execution.model) {
      const model = catalog.models.find(model => model.providerID === execution.model!.providerID && model.id === execution.model!.id)
      if (!model || (execution.model.variant !== undefined && !model.variants.includes(execution.model.variant))) {
        throw new Error("Choose an enabled tool-capable model and variant from the native catalog")
      }
    }
  }
  if (profiles.coordinator) validate(profiles.coordinator, false)
  for (const execution of Object.values(profiles.roles ?? {})) validate(execution, taskMode === "native")
}
