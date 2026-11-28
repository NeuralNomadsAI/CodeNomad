import { z } from "zod"

const id = z.string().regex(/^[A-Za-z0-9_-]{3,100}$/)
const request = z.string().trim().min(1).max(128)
const revision = z.number().int().positive().safe()
export const projectControlActions = ["read", "play", "resume", "pause", "interrupt", "stop", "recover-coordinator", "recover-report", "request-update"] as const
const common = { missionID: id, requestID: request.optional(), expectedRevision: revision.optional(), retry: z.literal(true).optional() }
export const projectControlInput = z.object({
  ...common, action: z.enum(projectControlActions), taskKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/).optional(),
  language: z.enum(["en", "de", "es", "fr", "he", "ja", "ne", "ru", "tr", "zh-Hans"]).optional(),
}).strict().superRefine((v, c) => {
  if (v.action !== "read" && (!v.requestID || !v.expectedRevision)
    || v.action === "read" && v.expectedRevision !== undefined && !v.requestID
    || (v.action === "recover-report") !== (v.taskKey !== undefined)
    || v.language !== undefined && v.action !== "request-update"
    || v.action === "request-update" && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v.requestID ?? "")
    || v.retry && !["play", "resume", "pause", "interrupt", "stop"].includes(v.action))
    c.addIssue({ code: "custom", message: "Invalid Mission control fields" })
})
export const projectConfigureInput = z.object({
  ...common, action: z.enum(["read", "save"]), objective: z.string().trim().min(1).max(20_000).optional(),
  notes: z.string().max(20_000).optional(),
}).strict().superRefine((v, c) => {
  if (v.action === "save" && (!v.requestID || !v.expectedRevision || v.objective === undefined)
    || v.action === "read" && (v.objective !== undefined || v.notes !== undefined)
    || v.action === "read" && v.expectedRevision !== undefined && !v.requestID
    || v.retry)
    c.addIssue({ code: "custom", message: "Supply the Mission's text" })
})
export const projectDeleteInput = z.object({
  ...common, action: z.enum(["read", "delete"]), deleteManagedSessions: z.boolean().optional(),
}).strict().superRefine((v, c) => {
  if (v.action === "delete" && (!v.requestID || !v.expectedRevision)
    || v.action === "read" && v.expectedRevision !== undefined && !v.requestID
    || v.action === "read" && (v.deleteManagedSessions !== undefined || v.retry))
    c.addIssue({ code: "custom", message: "Invalid Mission deletion fields" })
})
export const projectToolCommand = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("control"), input: projectControlInput }).strict(),
  z.object({ tool: z.literal("configure"), input: projectConfigureInput }).strict(),
  z.object({ tool: z.literal("delete"), input: projectDeleteInput }).strict(),
])
export type ProjectToolCommand = z.infer<typeof projectToolCommand>
const text = { type: "string", minLength: 1, maxLength: 128 } as const
const wireCommon = { missionID: { ...text, minLength: 3, maxLength: 100 }, requestID: text,
  expectedRevision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, retry: { type: "boolean", const: true } } as const
export const projectControlWire = { type: "object", properties: {
  ...wireCommon, action: { type: "string", enum: projectControlActions },
  taskKey: { type: "string", minLength: 2, maxLength: 64 },
  language: { type: "string", enum: ["en", "de", "es", "fr", "he", "ja", "ne", "ru", "tr", "zh-Hans"] },
}, required: ["missionID", "action"], additionalProperties: false } as const
export const projectConfigureWire = { type: "object", properties: {
  ...wireCommon, action: { type: "string", enum: ["read", "save"] },
  objective: { type: "string", minLength: 1, maxLength: 20_000 }, notes: { type: "string", maxLength: 20_000 },
}, required: ["missionID", "action"], additionalProperties: false } as const
export const projectDeleteWire = { type: "object", properties: { ...wireCommon,
  action: { type: "string", enum: ["read", "delete"] }, deleteManagedSessions: { type: "boolean" },
}, required: ["missionID", "action"], additionalProperties: false } as const
export const projectToolCommandWire = { oneOf: [
  { type: "object", properties: { tool: { const: "control" }, input: projectControlWire }, required: ["tool", "input"], additionalProperties: false },
  { type: "object", properties: { tool: { const: "configure" }, input: projectConfigureWire }, required: ["tool", "input"], additionalProperties: false },
  { type: "object", properties: { tool: { const: "delete" }, input: projectDeleteWire }, required: ["tool", "input"], additionalProperties: false },
] } as const
