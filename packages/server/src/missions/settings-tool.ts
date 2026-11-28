import { z } from "zod"
import { missionProfilesInputSchema } from "./playbook-profiles"
import { missionProgramConfigurationWire } from "./program-tool"
import { parseMissionModel } from "./model-library"
import { validMissionDefaults } from "./profile-defaults"

const expectation = z.string().regex(/^[a-f0-9]{64}$/)
const actions = ["read", "save", "delete", "reset"] as const
const fields = {
  action: z.enum(actions), expectation: expectation.optional(),
}
const configuration = z.object({
  id: z.string().min(36).max(36), name: z.string().min(1).max(80), objective: z.string().min(1).max(20_000),
  notes: z.string().max(20_000), template: z.enum(["custom", "debug", "wayfinder", "delivery", "compare"]),
  profiles: missionProfilesInputSchema.optional(), taskMode: z.enum(["native", "independent"]).optional(),
}).strict().superRefine((value, ctx) => {
  try { parseMissionModel({ version: 1, ...value }) }
  catch { ctx.addIssue({ code: "custom", message: "Invalid saved Mission configuration" }) }
})
const defaults = z.array(z.object({
  template: z.enum(["all", "custom", "debug", "wayfinder", "delivery", "compare"]),
  profiles: missionProfilesInputSchema, taskMode: z.enum(["native", "independent"]).optional(),
}).strict()).max(6).superRefine((value, ctx) => {
  if (!validMissionDefaults(value)) ctx.addIssue({ code: "custom", message: "Invalid Mission profile defaults" })
})
export const missionSettingsInput = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("configurations"), ...fields, configuration: configuration.optional(),
    configurationID: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).optional() }).strict(),
  z.object({ scope: z.literal("preferences"), ...fields,
    field: z.enum(["missionProfileDefaults", "missionDeleteSessions"]),
    defaults: defaults.optional(), deleteSessions: z.boolean().optional() }).strict(),
  z.object({ scope: z.literal("depth"), ...fields, depth: z.number().int().min(1).max(10).nullable().optional() }).strict(),
]).superRefine((v, c) => {
  if ((v.action === "read") !== (v.expectation === undefined)
    || v.scope === "configurations" && ((v.action === "save") !== (v.configuration !== undefined)
      || (v.action === "delete") !== (v.configurationID !== undefined))
    || v.scope === "preferences" && (v.action === "delete"
      || (v.action === "save" && v.field === "missionProfileDefaults") !== (v.defaults !== undefined)
      || (v.action === "save" && v.field === "missionDeleteSessions") !== (v.deleteSessions !== undefined))
    || v.scope === "depth" && (v.action === "delete" || v.action === "reset"
      || (v.action === "save") !== (v.depth !== undefined)))
    c.addIssue({ code: "custom", message: "Supply only the fields for this settings action; mutations require the read's expectation" })
})
export type MissionSettingsInput = z.infer<typeof missionSettingsInput>

const configWire = missionProgramConfigurationWire.properties
export const missionSettingsWire = {
  type: "object",
  properties: {
    scope: { type: "string", enum: ["configurations", "preferences", "depth"] },
    action: { type: "string", enum: actions },
    expectation: { type: "string", minLength: 64, maxLength: 64 },
    configurationID: { type: "string", minLength: 36, maxLength: 36 },
    configuration: { type: "object", properties: {
      id: { type: "string", minLength: 36, maxLength: 36 }, name: { type: "string", minLength: 1, maxLength: 80 },
      objective: { type: "string", minLength: 1, maxLength: 20_000 }, notes: { type: "string", maxLength: 20_000 },
      template: configWire.template, profiles: configWire.profiles, taskMode: configWire.taskMode,
    }, required: ["id", "name", "objective", "notes", "template"], additionalProperties: false },
    field: { type: "string", enum: ["missionProfileDefaults", "missionDeleteSessions"] },
    deleteSessions: { type: "boolean" },
    defaults: { type: "array", maxItems: 6, items: { type: "object", properties: {
      template: { type: "string", enum: ["all", "custom", "debug", "wayfinder", "delivery", "compare"] },
      profiles: configWire.profiles, taskMode: configWire.taskMode,
    }, required: ["template", "profiles"], additionalProperties: false } },
    depth: { oneOf: [{ type: "integer", minimum: 1, maximum: 10 }, { type: "null" }] },
  },
  required: ["scope", "action"],
  additionalProperties: false,
} as const
