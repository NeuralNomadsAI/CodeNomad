import { z } from "zod"
import { documentCounter, documentTimestamp, nativeDocumentID, missionConfigurationSchema } from "./launch-policy"
import { missionCalendarWhenSchema } from "./mission-calendar-plan"
import { missionCalendarPlacementSchema } from "./mission-calendar-placement"

export const missionCalendarOwnerSlotSchema = z.object({ role: z.enum(["principal", "reconciliation"]), slot: documentCounter.max(7),
  timeGeneration: documentCounter.positive(), sessionID: nativeDocumentID, name: z.string().min(1).max(128),
  when: missionCalendarWhenSchema, endsAt: documentTimestamp.nullable(),
  anchorAt: documentTimestamp.optional(),
  creation: z.enum(["prepared", "attempted", "adopted"]), scheduleID: nativeDocumentID.nullable(),
  ambiguous: z.array(nativeDocumentID).max(16),
}).strict().refine(item => (item.creation === "adopted") === (item.scheduleID !== null)
  && (item.role !== "reconciliation" || item.slot === 0))
export type MissionCalendarOwnerSlot = z.infer<typeof missionCalendarOwnerSlotSchema>
const retired = z.object({ descriptor: missionCalendarOwnerSlotSchema, highWater: documentCounter,
  scheduleRemoved: z.boolean(), sessionRemoved: z.boolean(), indexRemoved: z.boolean() }).strict()
export type MissionCalendarRetired = z.infer<typeof retired>
export const missionPassageTextIntentSchema = z.object({ passageID: nativeDocumentID, missionID: nativeDocumentID,
  coordinatorSessionID: nativeDocumentID, expectedJournalRevision: documentCounter.positive(), createdAt: documentTimestamp,
  configuration: missionConfigurationSchema }).strict()
export type MissionPassageTextIntent = z.infer<typeof missionPassageTextIntentSchema>
const operation = z.object({ requestID: z.string().min(1).max(128), expectedRevision: documentCounter, fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  action: z.enum(["play", "resume", "pause", "stop", "configure", "delete", "check", "reconcile"]), pending: z.boolean(), startedAt: documentTimestamp,
  textEdit: missionPassageTextIntentSchema.optional(),
}).strict()
export const missionCalendarOwnerSchema = z.object({ version: z.literal(1),
  installation: z.object({ registrationFile: z.string().min(1).max(4096), provider: z.object({ file: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    runtime: z.object({ file: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }).strict(),
  profileSource: z.object({ profileID: nativeDocumentID, executionHost: nativeDocumentID, configYamlPath: z.string().min(1).max(4096) }).strict(),
  placement: missionCalendarPlacementSchema,
  operation, receipts: z.array(operation.refine(value => !value.pending && value.action !== "reconcile" && !value.textEdit)).max(16).default([]),
  checks: z.array(z.object({ requestID: z.string().min(1).max(128), expectedRevision: documentCounter,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/), originalRequestID: z.string().min(1).max(128) }).strict()).max(16).default([]),
  slots: z.array(missionCalendarOwnerSlotSchema).max(9), retired: z.array(retired).max(9),
  auxiliaryReady: z.boolean(),
  error: z.enum(["native-uncertain", "ambiguous-create", "wake-unresolved", "claim-held", "cleanup-pending"]).nullable(),
}).strict().refine(owner => (!owner.operation.textEdit || owner.operation.pending && owner.operation.action === "configure")
  && new Set(owner.slots.map(item => item.sessionID)).size === owner.slots.length
  && new Set(owner.slots.map(item => `${item.role}:${item.slot}`)).size === owner.slots.length
  && new Set(owner.retired.map(item => item.descriptor.sessionID)).size === owner.retired.length
  && owner.slots.filter(item => item.role === "principal").length <= 8)
export type MissionCalendarOwnerState = z.infer<typeof missionCalendarOwnerSchema>
