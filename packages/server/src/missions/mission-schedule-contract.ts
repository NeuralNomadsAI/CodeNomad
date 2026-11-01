import { z } from "zod"
import { canonicalAuthority } from "./authority-protocol"
import { documentID, documentCounter, missionConfigurationSchema } from "./launch-policy"
import { missionDocumentSummaryWire } from "./mission-document-wire"
import { missionProfilesSchema } from "./playbook-profiles"
import { missionTaskModeSchema } from "./task-execution-mode"
import { stableToken } from "./receipt-identity"
import { MISSION_SCHEDULE_PAGE_MAX } from "./mission-schedule-list"

export const missionScheduleActions = ["create", "play", "pause", "resume", "stop", "check", "run-now", "configure", "delete"] as const
export type MissionScheduleAction = typeof missionScheduleActions[number]
export const missionScheduleTransportSchema = z.object({ sessionID: z.string().min(1).max(256), workspaceID: z.string().min(1).max(200),
  requestID: z.string().min(1).max(128), location: z.object({ directory: z.string().min(1).max(4096), workspaceID: z.string().optional() }).strict(),
  scheduleID: documentID, expectedRevision: documentCounter, action: z.enum(missionScheduleActions),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: documentCounter, proof: z.string().regex(/^[a-f0-9]{64}$/),
  profileSource: z.object({ profileID: z.string().min(1).max(240), executionHost: z.string().min(1).max(240),
    configYamlPath: z.string().min(1).max(4096) }).strict(),
}).strict()
export const missionScheduleRequestSchema = z.object({
  missionID: documentID, requestID: z.string().regex(/^[A-Za-z0-9_-]{3,100}$/), expectedRevision: documentCounter,
  action: z.enum(missionScheduleActions), configuration: missionConfigurationSchema.optional(),
  deleteManagedSessions: z.boolean().optional(), retry: z.boolean().optional(),
  transport: missionScheduleTransportSchema,
}).strict().superRefine((input, ctx) => {
  if (["create", "configure"].includes(input.action) !== (input.configuration !== undefined)
    || input.deleteManagedSessions !== undefined && input.action !== "delete"
    || input.action === "create" && input.expectedRevision !== 0)
    ctx.addIssue({ code: "custom", message: "Mission schedule action payload differs" })
  const transport = input.transport
  if (transport.scheduleID !== input.missionID || transport.requestID !== input.requestID
    || transport.expectedRevision !== input.expectedRevision || transport.action !== input.action)
    ctx.addIssue({ code: "custom", message: "Mission schedule proof identity differs" })
  if (["create", "configure", "delete"].includes(input.action)
    && transport.configDigest !== missionSchedulePayloadDigest(input))
    ctx.addIssue({ code: "custom", message: "Mission schedule proof payload differs" })
})
export type MissionScheduleRequest = z.infer<typeof missionScheduleRequestSchema>
export const missionScheduleID = (projectID: string, canonical: string, requestID: string) =>
  `msn_${stableToken(canonicalAuthority([projectID, canonical, requestID]), 40)}`
export const missionSchedulePayloadDigest = (input: Pick<MissionScheduleRequest, "configuration" | "deleteManagedSessions">) =>
  stableToken(canonicalAuthority(input.configuration ?? { deleteManagedSessions: input.deleteManagedSessions ?? false }), 64)

const text = { type: "string" } as const
const counter = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const
const location = { type: "object", properties: { directory: text, workspaceID: text }, required: ["directory"], additionalProperties: false } as const
const root = { type: "object", properties: { mode: { type: "string", enum: ["directory-only", "git"] }, directory: text, checkout: text, family: text },
  required: ["mode", "directory"], additionalProperties: false } as const
export const missionConfigurationWire = { type: "object", properties: {
  title: text, objective: text, notes: text, template: { type: "string", enum: ["custom", "debug", "wayfinder", "delivery", "compare"] },
  profiles: missionProfilesSchema, taskMode: missionTaskModeSchema,
  profileID: { type: ["string", "null"] }, executionHost: { type: ["string", "null"] },
  roots: { type: "array", minItems: 1, maxItems: 32, items: root },
  watchedConversationIDs: { type: "array", maxItems: 64, items: text }, launch: missionDocumentSummaryWire.properties.launch,
}, required: ["title", "objective", "template", "taskMode", "profileID", "executionHost", "roots", "watchedConversationIDs", "launch"], additionalProperties: false } as const
const proof = { type: "object", properties: { sessionID: text, workspaceID: text, requestID: text, location,
  scheduleID: text, expectedRevision: counter, action: { type: "string", enum: missionScheduleActions },
  configDigest: text, digest: text, issuedAt: counter, proof: text,
  profileSource: { type: "object", properties: { profileID: text, executionHost: text, configYamlPath: text },
    required: ["profileID", "executionHost", "configYamlPath"], additionalProperties: false },
}, required: ["sessionID", "workspaceID", "requestID", "location", "scheduleID", "expectedRevision", "action", "digest", "issuedAt", "proof", "profileSource"], additionalProperties: false } as const
const wake = { type: "object", properties: { scheduleID: text, run: counter, messageID: text, dueAt: counter },
  required: ["scheduleID", "run", "messageID", "dueAt"], additionalProperties: false } as const
const missionScheduleHistoryWire = { type: "object", properties: { id: text, missionID: text, coordinatorSessionID: text, messageID: text,
  configurationGeneration: counter, timeGeneration: counter, createdAt: counter, dueAt: counter,
  origin: { oneOf: [
    { type: "object", properties: { kind: { const: "wake" }, wakes: { type: "array", minItems: 1, maxItems: 8, items: wake } }, required: ["kind", "wakes"], additionalProperties: false },
    ...["manual", "immediate"].map(kind => ({ type: "object", properties: { kind: { const: kind }, requestID: text }, required: ["kind", "requestID"], additionalProperties: false })),
  ] }, admittedAt: { type: ["integer", "null"], minimum: 0 }, manualAllowed: { type: "boolean" }, admissionAttempted: { type: "boolean" },
  manualExpectedRevision: counter, configurationDigest: text, settledAt: counter,
  outcome: { type: "string", enum: ["completed", "failed", "ended-without-report"] }, reason: { const: "not-started" },
}, required: ["id", "missionID", "coordinatorSessionID", "messageID", "configurationGeneration", "timeGeneration", "createdAt", "dueAt", "origin", "admittedAt", "configurationDigest", "settledAt", "outcome"], additionalProperties: false } as const
const summary = { ...missionDocumentSummaryWire, properties: { ...missionDocumentSummaryWire.properties,
  kind: { type: "string", enum: ["one-time", "schedule"] },
  observation: { type: "object", properties: { state: { type: "string", enum: ["unarmed", "known", "unknown"] },
    nativeStatus: { type: ["string", "null"], enum: ["active", "paused", "done", "mixed", null] },
    nextDueAt: { type: ["integer", "null"], minimum: 0 }, wakeCount: { type: ["integer", "null"], minimum: 0 },
    timeGeneration: counter, kind: { type: "string", enum: ["check", "launch"] } },
    required: ["state", "nativeStatus", "nextDueAt", "wakeCount", "timeGeneration", "kind"], additionalProperties: false },
  availableActions: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string", enum: missionScheduleActions.filter(action => action !== "create") } },
  technical: { type: "object", properties: { cleanupPending: { type: "boolean" }, carriers: { type: "array", maxItems: 18,
    items: { type: "object", properties: { role: { type: "string", enum: ["principal", "reconciliation"] }, slot: counter, timeGeneration: counter,
      sessionID: text, scheduleID: { type: ["string", "null"] }, retiring: { type: "boolean" }, cleanupPending: { type: "boolean" } },
    required: ["role", "slot", "timeGeneration", "sessionID", "scheduleID", "retiring", "cleanupPending"], additionalProperties: false } } },
    required: ["cleanupPending", "carriers"], additionalProperties: false },
  blockReason: { type: ["string", "null"], enum: ["deleting", "synchronizing", "failed", "ended-without-report", "unknown", "native-uncertain", "ambiguous-create", "wake-unresolved", "claim-held", "cleanup-pending", null] },
  oneShotAt: { type: ["integer", "null"], minimum: 0 }, slotEndsAt: { type: ["integer", "null"], minimum: 0 }, successfulCount: counter,
  checks: { type: ["object", "null"], properties: { count: counter, since: counter }, required: ["count", "since"], additionalProperties: false },
  pendingPassage: { type: ["object", "null"], properties: { id: text, missionID: text, coordinatorSessionID: text,
    admittedAt: { type: ["integer", "null"], minimum: 0 } }, required: ["id", "missionID", "coordinatorSessionID", "admittedAt"], additionalProperties: false },
  latestResult: { ...missionScheduleHistoryWire, type: ["object", "null"] },
  history: { type: "array", maxItems: 30, items: missionScheduleHistoryWire },
  id: text, configuration: missionConfigurationWire, remaining: { type: ["integer", "null"], minimum: 0 },
  settledCount: counter, blocked: { type: ["string", "null"], enum: ["failed", "ended-without-report", "unknown", null] },
  edit: { type: "object", properties: { structural: { type: "boolean" }, template: { type: "boolean" }, reason: { type: ["string", "null"] },
    templateReason: { type: ["string", "null"] } }, required: ["structural", "template", "reason", "templateReason"], additionalProperties: false },
  control: { type: ["object", "null"], properties: { requestID: text, expectedRevision: counter, action: text, pending: { type: "boolean" } },
    required: ["requestID", "expectedRevision", "action", "pending"], additionalProperties: false },
}, required: [...missionDocumentSummaryWire.required, "id", "configuration", "remaining", "settledCount", "blocked", "edit", "control",
   "kind", "oneShotAt", "slotEndsAt", "successfulCount", "checks", "pendingPassage", "latestResult", "history", "observation", "availableActions", "blockReason", "technical"] } as const
const result = { type: "object", properties: { document: { ...summary, type: ["object", "null"] },
  deleted: { type: "boolean" }, pending: { type: "boolean" },
  deletionReceipt: { type: "object", properties: { id: text, requestID: text, expectedRevision: counter, deleteManagedSessions: { type: "boolean" } },
    required: ["id", "requestID", "expectedRevision", "deleteManagedSessions"], additionalProperties: false },
}, required: ["document", "pending"], additionalProperties: false } as const

/** Native RPC validates the wire first; the strict domain codec and signed action
 * are revalidated before any document or native effect. */
export const missionScheduleRpcMethods = {
  scheduleList: { input: { type: "object", properties: { after: text, limit: { type: "integer", minimum: 1, maximum: MISSION_SCHEDULE_PAGE_MAX } }, additionalProperties: false },
    output: { type: "object", properties: { version: { const: 1 }, projectID: text, next: text,
      schedules: { type: "array", maxItems: MISSION_SCHEDULE_PAGE_MAX, items: summary } }, required: ["version", "projectID", "schedules"], additionalProperties: false } },
  scheduleRead: { input: { type: "object", properties: { missionID: text, requestID: text }, required: ["missionID"], additionalProperties: false }, output: result },
  scheduleControl: { input: { type: "object", properties: { missionID: text, requestID: text, expectedRevision: counter,
    action: { type: "string", enum: missionScheduleActions }, configuration: missionConfigurationWire,
    deleteManagedSessions: { type: "boolean" }, retry: { type: "boolean" }, transport: proof },
    required: ["missionID", "requestID", "expectedRevision", "action", "transport"], additionalProperties: false }, output: result },
  scheduleCarrierRead: { input: { type: "object", properties: { sessionID: text }, required: ["sessionID"], additionalProperties: false },
    output: { type: "object", properties: { owned: { type: "boolean" } }, required: ["owned"], additionalProperties: false } },
} as const
