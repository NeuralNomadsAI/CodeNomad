import { z } from "zod"
import { documentID, missionConfigurationSchema, missionCriteriaLaunchPolicySchema } from "./launch-policy"
import { criteriaLaunchPolicyWire } from "./mission-document-wire"
import { missionConfigurationWire } from "./mission-schedule-contract"
import { recurrenceCreateSchema } from "./recurrence-create-input"
import { MISSION_LIFECYCLE_TEXT_LIMIT } from "./lifecycle-input"

const { roots: _roots, profileID: _profile, executionHost: _host, coordinatorSelectionAuthor: _author, ...fields } = missionConfigurationSchema.shape
export const scheduleToolConfiguration = z.object({ ...fields, launch: missionCriteriaLaunchPolicySchema }).strict()
const actions = ["list", "read", "create", "capabilities", "activation-read", "activate", "play", "pause", "stop", "resume", "run-now", "check", "configure", "delete"] as const
export const scheduleToolInput = z.object({
  action: z.enum(actions), missionID: documentID.optional(), requestID: documentID.optional(),
  owner: z.literal("daily").optional(), creation: recurrenceCreateSchema.omit({ requestID: true, directory: true }).optional(),
  receiptAction: z.enum(["play", "pause", "stop", "resume", "run-now", "check"]).optional(),
  expectedRevision: z.number().int().nonnegative().safe().optional(),
  configuration: scheduleToolConfiguration.optional(), deleteManagedSessions: z.boolean().optional(),
  after: documentID.optional(), limit: z.number().int().min(1).max(8).optional(),
  retry: z.literal(true).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.owner === "daily") {
    const read = value.action === "read", list = value.action === "list", create = value.action === "create"
    const creationRead = read && value.creation !== undefined
    if (!["list", "read", "create", "play", "pause", "stop", "resume", "run-now", "check"].includes(value.action)
      || ((list || create || creationRead) ? value.missionID !== undefined : !value.missionID)
      || (!list && !read && (!value.requestID || !create && value.expectedRevision === undefined))
      || list && (value.requestID !== undefined || value.expectedRevision !== undefined)
      || read && !creationRead && (Boolean(value.requestID) !== Boolean(value.receiptAction) || Boolean(value.requestID) !== (value.expectedRevision !== undefined))
      || (create || creationRead) !== (value.creation !== undefined) || create && value.expectedRevision !== undefined
      || creationRead && (!value.requestID || value.expectedRevision !== undefined || value.receiptAction !== undefined)
      || !read && value.receiptAction !== undefined || value.configuration !== undefined || value.deleteManagedSessions !== undefined
      || !list && (value.after !== undefined || value.limit !== undefined)
      || value.retry && !["pause", "stop"].includes(value.action))
      ctx.addIssue({ code: "custom", message: "Invalid daily Mission action fields" })
    return
  }
  const global = value.action === "list" || value.action === "capabilities"
  const mutation = !["list", "read", "capabilities"].includes(value.action)
  if ((global ? value.missionID !== undefined || value.requestID !== undefined : !value.missionID)
    || mutation && (!value.requestID || value.expectedRevision === undefined)
    || (value.action === "configure") !== (value.configuration !== undefined)
    || value.action !== "delete" && value.deleteManagedSessions !== undefined
     || value.action !== "list" && (value.after !== undefined || value.limit !== undefined)
     || value.retry !== undefined && value.action !== "configure"
     || value.action === "create" || value.creation !== undefined || value.receiptAction !== undefined
    || !mutation && value.expectedRevision !== undefined)
    ctx.addIssue({ code: "custom", message: "Invalid Mission schedule action fields" })
})
export type ScheduleToolInput = z.infer<typeof scheduleToolInput>
const { roots: _wireRoots, profileID: _wireProfile, executionHost: _wireHost, coordinatorSelectionAuthor: _wireAuthor, ...wireFields } = missionConfigurationWire.properties
const text = { type: "string", minLength: 3, maxLength: 100 } as const
export const scheduleToolWire = { type: "object", properties: {
  action: { type: "string", enum: actions }, missionID: text, requestID: text, after: text,
  owner: { type: "string", const: "daily" },
  receiptAction: { type: "string", enum: ["play", "pause", "stop", "resume", "run-now", "check"] },
  expectedRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  limit: { type: "integer", minimum: 1, maximum: 8 }, deleteManagedSessions: { type: "boolean" },
  retry: { type: "boolean", const: true },
  creation: { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 60 },
    instructions: { type: "string", minLength: 1, maxLength: MISSION_LIFECYCLE_TEXT_LIMIT }, notes: { type: "string", maxLength: 20_000 },
    clock: { type: "object", properties: { time: { type: "string", minLength: 5, maxLength: 5 }, zone: { type: "string", minLength: 1, maxLength: 100 } },
      required: ["time", "zone"], additionalProperties: false },
    template: wireFields.template, profiles: wireFields.profiles, taskMode: wireFields.taskMode, watchedConversationIDs: wireFields.watchedConversationIDs },
    required: ["instructions", "clock", "template", "profiles", "taskMode", "watchedConversationIDs"], additionalProperties: false },
  configuration: { type: "object", properties: { ...wireFields, launch: criteriaLaunchPolicyWire },
    required: missionConfigurationWire.required.filter(key => !["roots", "profileID", "executionHost"].includes(key)),
    additionalProperties: false },
}, required: ["action"], additionalProperties: false } as const
