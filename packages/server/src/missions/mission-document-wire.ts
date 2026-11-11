const counter = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const
const nullableTime = { type: ["integer", "null"], minimum: 0 } as const
const text = { type: "string" } as const
const calendar = { type: "object", properties: { expression: text, zone: text }, required: ["expression", "zone"], additionalProperties: false } as const
const cron = { ...calendar, properties: { ...calendar.properties, kind: { const: "cron" } }, required: ["kind", ...calendar.required] } as const
const events = [
  { type: "object", properties: { kind: { const: "repository-activity" }, provider: { enum: ["github", "gitlab", "gitea"] }, host: text,
    repository: text, event: { enum: ["pull-request-created", "pull-request-merged", "issue-created"] }, author: text },
    required: ["kind", "provider", "host", "repository", "event"], additionalProperties: false },
  ...["schedule-success", "mission-completed"].map(kind => ({ type: "object", properties: { kind: { const: kind }, missionID: text }, required: ["kind", "missionID"], additionalProperties: false })),
  { type: "object", properties: { kind: { const: "branch-commits" }, directory: text, ref: text }, required: ["kind", "directory", "ref"], additionalProperties: false },
  { type: "object", properties: { kind: { const: "conversation-message" }, conversationID: text }, required: ["kind", "conversationID"], additionalProperties: false },
  { type: "object", properties: { kind: { const: "files-changed" }, paths: { type: "array", maxItems: 128, items: text } }, required: ["kind", "paths"], additionalProperties: false },
  { type: "object", properties: { kind: { const: "github-notification" }, repository: text }, required: ["kind"], additionalProperties: false },
  { type: "object", properties: { kind: { const: "github-security-alert" }, repository: text }, required: ["kind", "repository"], additionalProperties: false },
  ...["github-pull-request", "github-issue"].map(kind => ({ type: "object", properties: { kind: { const: kind }, repository: text, author: text }, required: ["kind", "repository"], additionalProperties: false })),
] as const
/** One ordered criteria list (roles by position); the strict domain codec checks counts and uniqueness. */
const criteriaLaunchPolicyWire = { type: "object", properties: {
  when: { type: "array", maxItems: 16, items: { oneOf: [
    { type: "object", properties: { kind: { const: "now" } }, required: ["kind"], additionalProperties: false }, cron, ...events,
  ] } },
}, required: ["when"], additionalProperties: false } as const
const legacyLaunchPolicyWire = { type: "object", properties: {
  timing: { oneOf: [
    { type: "object", properties: { kind: { const: "immediate" } }, required: ["kind"], additionalProperties: false },
    { type: "object", properties: { kind: { const: "at" }, at: counter, zone: text }, required: ["kind", "at", "zone"], additionalProperties: false },
    { type: "object", properties: { kind: { const: "in" }, delayMs: counter }, required: ["kind", "delayMs"], additionalProperties: false },
    { type: "object", properties: { kind: { const: "every" }, intervalMs: counter }, required: ["kind", "intervalMs"], additionalProperties: false },
    cron,
    { type: "object", properties: { kind: { const: "multi" }, calendars: { type: "array", maxItems: 8, items: calendar } }, required: ["kind", "calendars"], additionalProperties: false },
  ] },
  condition: { oneOf: [{ type: "null" }, ...events] },
  ends: { type: "object", properties: { maxLaunches: nullableTime, afterMs: nullableTime, at: nullableTime }, required: ["maxLaunches", "afterMs", "at"], additionalProperties: false },
}, required: ["timing", "condition", "ends"], additionalProperties: false } as const
/** Both stored shapes stay valid on the wire; documents keep the shape they were written in. */
export const missionLaunchPolicyWire = { oneOf: [criteriaLaunchPolicyWire, legacyLaunchPolicyWire] } as const

export const missionScheduleActivationWire = { type: "object", properties: { requestID: text, expectedRevision: counter, authority: text,
  state: { type: "string", enum: ["prepared", "partial", "ready", "failed"] },
  targets: { type: "array", maxItems: 2, items: { type: "object", properties: { scope: { type: "string", enum: ["global", "project"] }, path: text,
    expectation: text,
    resultDigest: text, attempted: { type: "boolean" }, acknowledged: { type: "boolean" } },
    required: ["scope", "path", "expectation", "resultDigest", "attempted", "acknowledged"], additionalProperties: false } },
  effectiveOrigin: { type: ["string", "null"] }, errorCode: text,
}, required: ["requestID", "expectedRevision", "authority", "state", "targets"], additionalProperties: false } as const

export const missionDocumentSummaryWire = { type: "object", properties: { revision: counter, configurationGeneration: counter, timeGeneration: counter,
  state: { type: "string", enum: ["paused", "running", "stopped", "finished"] }, firstPlayedAt: nullableTime, launchedCount: counter,
  everCreatedTask: { type: "boolean" }, dormant: { const: true }, launch: missionLaunchPolicyWire,
  firstPlay: { type: ["object", "null"], properties: { requestID: text, expectedRevision: counter, operationID: text, messageID: text,
    requestedAt: counter, admittedAt: nullableTime, inputDigest: { type: "string", minLength: 64, maxLength: 64 } }, required: ["requestID", "expectedRevision", "operationID", "messageID", "requestedAt", "admittedAt"], additionalProperties: false },
  scheduleActivation: { ...missionScheduleActivationWire, type: ["object", "null"] },
  deletion: { type: ["object", "null"], properties: { requestID: text, expectedRevision: counter, deleteManagedSessions: { type: "boolean" }, requestedAt: counter },
    required: ["requestID", "expectedRevision", "deleteManagedSessions", "requestedAt"], additionalProperties: false },
}, required: ["revision", "configurationGeneration", "timeGeneration", "state", "firstPlayedAt", "launchedCount", "everCreatedTask", "launch", "firstPlay", "scheduleActivation"], additionalProperties: false } as const
