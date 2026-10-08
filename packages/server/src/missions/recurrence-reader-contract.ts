import { z } from "zod"
import { recurrenceIDSchema } from "./recurrence-contract"
import { recurrenceNativeControlWire, recurrenceControlRequestWire } from "./recurrence-control-contract"

export const RECURRENCE_READER_SECTIONS = 32
export const RECURRENCE_READER_MAX_SECTIONS = 8_400
export const recurrenceReadInput = z.object({ scheduleID: recurrenceIDSchema, passageID: recurrenceIDSchema,
  section: z.number().int().min(0).max(RECURRENCE_READER_MAX_SECTIONS - 1).default(0),
  page: z.number().int().min(0).max(63).default(0), revision: z.number().int().positive().safe().optional(),
}).strict()
const labels = ["summary", "objective", "notes", "evidence", "next", "brief", "artifact", "achieved", "ongoing", "obstacles"] as const
export const recurrenceReadPage = z.object({ version: z.literal(1), projectID: z.string().min(1).max(240),
  scheduleID: recurrenceIDSchema, passageID: recurrenceIDSchema, missionID: z.string().min(1).max(240),
  conversationID: z.string().min(1).max(240), revision: z.number().int().positive().safe(),
  section: z.number().int().nonnegative().max(RECURRENCE_READER_MAX_SECTIONS - 1),
  sectionCount: z.number().int().positive().max(RECURRENCE_READER_MAX_SECTIONS),
  sections: z.array(z.object({ index: z.number().int().nonnegative().max(RECURRENCE_READER_MAX_SECTIONS - 1),
    label: z.enum(labels), title: z.string().max(240), raw: z.boolean() }).strict()).min(1).max(RECURRENCE_READER_SECTIONS),
  page: z.number().int().nonnegative().max(63), pageCount: z.number().int().positive().max(64),
  sourceText: z.string().max(9_001), markdownText: z.string().max(9_116).nullable(),
}).strict()
export type MissionRecurrenceReadPage = z.infer<typeof recurrenceReadPage>

const id = { type: "string", minLength: 1, maxLength: 240 } as const
const recurrenceID = { type: "string", minLength: 3, maxLength: 100, pattern: "^[A-Za-z0-9_-]{3,100}$" } as const
const counter = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const
const timestamp = { ...counter, maximum: Date.parse("9999-12-28T00:00:00Z") } as const
const nullableID = { anyOf: [recurrenceID, { type: "null" }] } as const
const location = { type: "object", properties: { directory: { type: "string", minLength: 1, maxLength: 4096 }, workspaceID: id },
  required: ["directory"], additionalProperties: false } as const
const receipt = { type: "object", properties: { passageID: recurrenceID, messageID: recurrenceID,
  dueAt: timestamp, settledAt: timestamp, status: { type: "string", enum: ["completed", "failed", "stopped", "rejected-before-effect"] },
  missionID: id, conversationID: id, artifactMessageIDs: { type: "array", maxItems: 8, uniqueItems: true, items: id },
}, required: ["passageID", "messageID", "dueAt", "settledAt", "status"], additionalProperties: false,
  oneOf: [
    { properties: { status: { const: "rejected-before-effect" } }, not: { anyOf: [{ required: ["missionID"] }, { required: ["conversationID"] }, { required: ["artifactMessageIDs"] }] } },
    { properties: { status: { enum: ["completed", "failed", "stopped"] } }, required: ["missionID", "conversationID", "artifactMessageIDs"] },
  ],
} as const

/** The single registered native output contract: bounded references, no permissive additionalProperties. */
export const recurrenceSnapshotOutput = { type: "object", properties: {
  version: { type: "integer", const: 1 }, projectID: id, projectCanonical: { type: "string", minLength: 1, maxLength: 4096 }, location,
  schedules: { type: "array", maxItems: 64, items: { type: "object", properties: {
    id: recurrenceID, revision: counter, scheduleRevision: counter,
    state: { type: "string", enum: ["running", "paused", "interrupted", "unavailable", "stopped"] },
    epoch: { anyOf: [counter, { type: "null" }] },
    controlCapability: { type: "object", properties: { version: { type: "integer", const: 1 },
      actions: { type: "array", maxItems: 3, uniqueItems: true, items: { type: "string", enum: ["play", "pause", "stop"] } } },
      required: ["version", "actions"], additionalProperties: false },
    nativeControl: recurrenceNativeControlWire,
    controlRetry: { ...recurrenceControlRequestWire, properties: { ...recurrenceControlRequestWire.properties,
      action: { type: "string", enum: ["pause", "stop"] } } }, controlsComplete: { type: "boolean" },
    clock: { type: "object", properties: { time: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" }, zone: { type: "string", minLength: 1, maxLength: 240 } }, required: ["time", "zone"], additionalProperties: false },
    pendingPassageID: nullableID, pendingStatus: { type: ["string", "null"], enum: ["unknown", "admitted", null] },
    pendingAdmission: { anyOf: [{ type: "null" }, { type: "object", properties: { missionID: id, conversationID: id }, required: ["missionID", "conversationID"], additionalProperties: false }] },
    settledCount: counter, latestResult: { anyOf: [receipt, { type: "null" }] }, history: { type: "array", maxItems: 30, items: receipt },
  }, required: ["id", "revision", "scheduleRevision", "state", "clock", "pendingPassageID", "pendingStatus", "pendingAdmission", "settledCount", "latestResult", "history"], additionalProperties: false } },
}, required: ["version", "projectID", "projectCanonical", "location", "schedules"], additionalProperties: false } as const

export const recurrencePassageReadWire = {
  input: { type: "object", properties: { scheduleID: recurrenceID, passageID: recurrenceID,
    section: { ...counter, maximum: RECURRENCE_READER_MAX_SECTIONS - 1 }, page: { ...counter, maximum: 63 }, revision: { ...counter, minimum: 1 },
  }, required: ["scheduleID", "passageID"], additionalProperties: false },
  output: { type: "object", properties: { version: { type: "integer", const: 1 }, projectID: id,
    projectCanonical: { type: "string", minLength: 1, maxLength: 4096 }, location,
    scheduleID: recurrenceID, passageID: recurrenceID, missionID: id, conversationID: id, revision: { ...counter, minimum: 1 },
    section: { ...counter, maximum: RECURRENCE_READER_MAX_SECTIONS - 1 }, sectionCount: { ...counter, minimum: 1, maximum: RECURRENCE_READER_MAX_SECTIONS },
    sections: { type: "array", minItems: 1, maxItems: RECURRENCE_READER_SECTIONS, items: { type: "object", properties: {
      index: { ...counter, maximum: RECURRENCE_READER_MAX_SECTIONS - 1 }, label: { type: "string", enum: labels }, title: { type: "string", maxLength: 240 }, raw: { type: "boolean" },
    }, required: ["index", "label", "title", "raw"], additionalProperties: false } },
    page: { ...counter, maximum: 63 }, pageCount: { ...counter, minimum: 1, maximum: 64 }, sourceText: { type: "string", maxLength: 9001 }, markdownText: { type: ["string", "null"], maxLength: 9116 },
  }, required: ["version", "projectID", "projectCanonical", "location", "scheduleID", "passageID", "missionID", "conversationID", "revision", "section", "sectionCount", "sections", "page", "pageCount", "sourceText", "markdownText"], additionalProperties: false },
} as const
