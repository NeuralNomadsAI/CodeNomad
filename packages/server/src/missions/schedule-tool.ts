import { z } from "zod"
import { documentID, missionConfigurationSchema, missionCriteriaLaunchPolicySchema } from "./launch-policy"
import { criteriaLaunchPolicyWire } from "./mission-document-wire"
import { missionConfigurationWire } from "./mission-schedule-contract"

const { roots: _roots, profileID: _profile, executionHost: _host, coordinatorSelectionAuthor: _author, ...fields } = missionConfigurationSchema.shape
export const scheduleToolConfiguration = z.object({ ...fields, launch: missionCriteriaLaunchPolicySchema }).strict()
const actions = ["list", "read", "capabilities", "activation-read", "activate", "play", "pause", "stop", "resume", "run-now", "check", "configure", "delete"] as const
export const scheduleToolInput = z.object({
  action: z.enum(actions), missionID: documentID.optional(), requestID: documentID.optional(),
  expectedRevision: z.number().int().nonnegative().safe().optional(),
  configuration: scheduleToolConfiguration.optional(), deleteManagedSessions: z.boolean().optional(),
  after: documentID.optional(), limit: z.number().int().min(1).max(8).optional(),
  retry: z.literal(true).optional(),
}).strict().superRefine((value, ctx) => {
  const global = value.action === "list" || value.action === "capabilities"
  const mutation = !["list", "read", "capabilities"].includes(value.action)
  if ((global ? value.missionID !== undefined || value.requestID !== undefined : !value.missionID)
    || mutation && (!value.requestID || value.expectedRevision === undefined)
    || (value.action === "configure") !== (value.configuration !== undefined)
    || value.action !== "delete" && value.deleteManagedSessions !== undefined
     || value.action !== "list" && (value.after !== undefined || value.limit !== undefined)
     || value.retry !== undefined && value.action !== "configure"
    || !mutation && value.expectedRevision !== undefined)
    ctx.addIssue({ code: "custom", message: "Invalid Mission schedule action fields" })
})
export type ScheduleToolInput = z.infer<typeof scheduleToolInput>
const { roots: _wireRoots, profileID: _wireProfile, executionHost: _wireHost, coordinatorSelectionAuthor: _wireAuthor, ...wireFields } = missionConfigurationWire.properties
const text = { type: "string", minLength: 3, maxLength: 100 } as const
export const scheduleToolWire = { type: "object", properties: {
  action: { type: "string", enum: actions }, missionID: text, requestID: text, after: text,
  expectedRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  limit: { type: "integer", minimum: 1, maximum: 8 }, deleteManagedSessions: { type: "boolean" },
  retry: { type: "boolean", const: true },
  configuration: { type: "object", properties: { ...wireFields, launch: criteriaLaunchPolicyWire },
    required: missionConfigurationWire.required.filter(key => !["roots", "profileID", "executionHost"].includes(key)),
    additionalProperties: false },
}, required: ["action"], additionalProperties: false } as const
