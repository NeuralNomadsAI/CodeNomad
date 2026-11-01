import { executionSchema } from "./execution"
import { missionProfilesSchema } from "./playbook-profiles"
import { missionTaskModeSchema } from "./task-execution-mode"
import { missionMutationErrors } from "./rpc-errors"
import { lifecycleInputSchema, lifecycleOperationSchema } from "./lifecycle-schema"
import { MAX_PROJECTED_CLEANUPS, missionCleanupSchema } from "./cleanup-projection"
import { MISSION_TITLE_MAX } from "./mission-title"
import { MISSION_LIST_MAX_INCLUDE, MISSION_SUMMARY_OBJECTIVE, missionSummarySchema } from "./mission-summary"
import { missionPanelPageInputSchema, missionPanelPageOutputSchema } from "./mission-panel-page"
import { MISSION_BODY_FIELDS } from "./mission-content-wire"
import { MISSION_BRIEFING_CONTENT, MISSION_EXCERPT_MAX, MISSION_LATE_REPORT_ROWS, MISSION_PINNED_REPORTS, MISSION_TASK_PAGE, MISSION_TASK_PINS,
  MISSION_TASK_REPORT_ROWS } from "./mission-panel-map"
import { missionBriefingResponsesSchema, missionBriefingSnapshotSchema } from "./briefing"
import { taskExecutionModeRpcSchema, taskGenerationSchema, nativeTaskBindingSchema, nativeTaskExecutionSchema, nativeCallBindingSchema } from "./native-wire-schema"
import { recurrenceCurrentContentWire } from "./recurrence-current"
import { recurrencePassageReadWire } from "./recurrence-reader-contract"
import { recurrenceScheduleChangedSchema } from "./recurrence-events"
import { recurrenceNativeControlWire, recurrenceSnapshotOutput, recurrenceControlStatusWire, recurrenceControlRequestWire } from "./recurrence-control-contract"
import { RECURRENCE_RUN_NOW_STATUS_INPUT, RECURRENCE_RUN_NOW_STATUS_REQUEST, RECURRENCE_RUN_NOW_OUTPUT } from "./recurrence-manual-rpc"

export const CODENOMAD_MISSIONS_RPC_ID = "codenomad.missions"
export const CODENOMAD_MISSIONS_CHANGED_EVENT = `rpc.${CODENOMAD_MISSIONS_RPC_ID}.changed`

const stringArray = {
  type: "array",
  items: { type: "string" },
} as const

const location = {
  type: "object",
  properties: {
    directory: { type: "string" },
    workspaceID: { type: "string" },
  },
  required: ["directory"],
  additionalProperties: false,
} as const

// Body descriptors (`describeMissionBodies`), keyed by body field: in compact maps only.
const bodies = {
  type: "object",
  additionalProperties: {
    type: "object", properties: { characters: { type: "integer", minimum: 0 }, digest: { type: "string", minLength: 43, maxLength: 43 } },
    required: ["characters", "digest"], additionalProperties: false,
  },
} as const

const report = {
  type: "object",
  properties: {
    id: { type: "string" },
    taskKey: { type: "string" },
    sessionId: { type: "string" },
    outcome: { type: "string", enum: ["completed", "blocked", "failed"] },
    summary: { type: "string" },
    evidence: stringArray,
    next: stringArray,
    artifact: {},
    late: { type: "boolean" },
    nativeCall: nativeCallBindingSchema,
    delivery: { type: "string", enum: ["coordinator-notification", "native-return", "coordinator-readout"] },
    notificationStatus: { type: "string", enum: ["pending", "admitted"] },
    createdAt: { type: "number" },
  },
  required: ["id", "taskKey", "sessionId", "outcome", "summary", "evidence", "next", "createdAt"],
  additionalProperties: false,
} as const

const mission = {
  type: "object",
  properties: {
    version: { type: "number", const: 1 },
    id: { type: "string" },
    projectID: { type: "string" },
    projectCanonical: { type: "string" },
    title: { type: "string", minLength: 1, maxLength: MISSION_TITLE_MAX },
    preparedBy: { type: "object", properties: { missionId: { type: "string" }, coordinatorSessionId: { type: "string" } },
      required: ["missionId", "coordinatorSessionId"], additionalProperties: false },
    objective: { type: "string" },
    notes: { type: "string" },
    template: { type: "string", enum: ["custom", "debug", "wayfinder", "delivery", "compare"] },
    profiles: missionProfilesSchema,
    taskMode: missionTaskModeSchema,
    status: { type: "string", enum: ["active", "completed", "failed", "stopped"] },
    runState: { type: "string", enum: ["prepared", "running", "paused", "stopped"] },
    control: lifecycleOperationSchema,
    controlUnavailable: { type: "boolean" },
    notificationUnavailable: { type: "boolean" },
    summary: { type: "string" },
    finishSequence: { type: "integer", minimum: 1 },
    coordinatorSessionId: { type: "string" },
    briefing: missionBriefingSnapshotSchema,
    briefingResponses: missionBriefingResponsesSchema,
    actors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          kind: { type: "string", enum: ["coordinator", "specialist"] },
          managed: { type: "boolean" },
          title: { type: "string" },
          roles: stringArray,
          location,
          joinedAt: { type: "number" },
        },
        required: ["sessionId", "kind", "managed", "title", "roles", "location", "joinedAt"],
        additionalProperties: false,
      },
    },
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          key: { type: "string" },
          title: { type: "string" },
          brief: { type: "string" },
          role: { type: "string" },
          execution: executionSchema,
          executionMode: taskExecutionModeRpcSchema,
          contractGeneration: taskGenerationSchema,
          nativeBinding: nativeTaskBindingSchema,
          nativeExecution: nativeTaskExecutionSchema,
          blockedBy: stringArray,
          replacesTaskKey: { type: "string" },
          replacedByTaskKey: { type: "string" },
          status: { type: "string", enum: ["blocked", "ready", "dispatching", "queued", "completed", "needs-input", "failed", "withdrawn"] },
          actorSessionId: { type: "string" },
          admissionId: { type: "string" },
          delivery: { type: "string", enum: ["queue", "steer"] },
          createdAt: { type: "number" },
          updatedAt: { type: "number" },
          report,
          lateReports: { type: "array", items: report },
          outstandingExecution: { type: "boolean" },
        },
        required: ["id", "key", "title", "brief", "role", "blockedBy", "status", "createdAt", "updatedAt", "outstandingExecution"],
        additionalProperties: false,
      },
    },
    reports: { type: "array", items: report },
    history: {
      type: "array", maxItems: 50, items: {
        type: "object", properties: {
          revision: { type: "integer" }, source: { type: "string", enum: ["user", "coordinator"] },
          actorSessionId: { type: "string" }, reason: { type: "string" },
          objective: { type: "object", properties: { before: { type: "string" }, after: { type: "string" } }, required: ["before", "after"], additionalProperties: false },
          notes: { type: "object", properties: { before: { type: "string" }, after: { type: "string" } }, additionalProperties: false },
          addedTaskKeys: stringArray,
          retiredTasks: { type: "array", items: { type: "object", properties: { taskKey: { type: "string" }, replacementTaskKey: { type: "string" } }, required: ["taskKey"], additionalProperties: false } },
          dependencyUpdates: { type: "array", items: { type: "object", properties: { taskKey: { type: "string" }, before: stringArray, after: stringArray }, required: ["taskKey", "before", "after"], additionalProperties: false } },
          createdAt: { type: "number" },
        },
        required: ["revision", "addedTaskKeys", "retiredTasks", "dependencyUpdates", "createdAt"],
        additionalProperties: false,
      },
    },
    historyTruncated: { type: "boolean" },
    frontier: stringArray,
    claims: stringArray,
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    revision: { type: "number" },
  },
  required: [
    "version", "id", "projectID", "projectCanonical", "objective", "template", "status", "coordinatorSessionId",
    "actors", "tasks", "reports", "history", "historyTruncated", "frontier", "claims", "createdAt", "updatedAt", "revision",
  ],
  additionalProperties: false,
} as const

export const sharedMissionMap = mission

/** `value` without `keys`, every other property kept. */
function omit<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !(keys as readonly PropertyKey[]).includes(key))) as Omit<T, K>
}
const unlisted = (required: readonly string[], fields: readonly string[]) => required.filter(field => !fields.includes(field))

// The compact map (`compactMissionMap`) of the list and mission reads: the full map's
// schema without the body fields (`MISSION_BODY_FIELDS`), with their descriptors
// (`bodies`) and with rows and bounded excerpts in place of the mixed ones. Any other
// field passes as it is.
const excerpt = { type: "string", maxLength: 2 * MISSION_EXCERPT_MAX + 1 } as const
const reportRow = {
  ...report,
  properties: { ...omit(report.properties, MISSION_BODY_FIELDS.report), bodies, excerpt, decidedBy: { type: "string", enum: ["human", "coordinator"] } },
  required: [...unlisted(report.required, MISSION_BODY_FIELDS.report), "excerpt"],
} as const
const [nativeMode, independentMode] = taskExecutionModeRpcSchema.oneOf
const executionModeRow = { oneOf: [nativeMode, {
  ...independentMode, properties: { ...omit(independentMode.properties, ["explanation"]), excerpt },
  required: [...unlisted(independentMode.required, ["explanation"]), "excerpt"],
}] } as const
const taskSchema = mission.properties.tasks.items
const count = { type: "integer", minimum: 0 } as const
const taskRow = {
  ...taskSchema,
  properties: { ...omit(taskSchema.properties, MISSION_BODY_FIELDS.task), bodies, executionMode: executionModeRow, report: reportRow,
    lateReports: { type: "array", maxItems: MISSION_LATE_REPORT_ROWS, items: reportRow }, lateReportCount: count,
    nativeExecution: { ...nativeTaskExecutionSchema, properties: omit(nativeTaskExecutionSchema.properties, ["observations"]) },
    order: count, dependents: count, reportCount: count },
  required: [...unlisted(taskSchema.required, MISSION_BODY_FIELDS.task), "bodies", "order", "dependents"],
} as const
const attention = {
  type: "object", properties: {
    counts: { type: "object", properties: { notifications: count, blocked: count, failed: count, recovery: count },
      required: ["notifications", "blocked", "failed", "recovery"], additionalProperties: false },
    omitted: count, offset: count, end: count, sequence: { type: "string", minLength: 1, maxLength: 64 },
    keys: { type: "array", maxItems: MISSION_TASK_PAGE, items: { type: "string", minLength: 1, maxLength: 64 } },
  }, required: ["counts", "omitted", "sequence"], additionalProperties: false,
} as const
const taskPage = {
  type: "object", properties: {
    order: { type: "string", minLength: 1, maxLength: 64 }, offset: count, end: count, total: count, reports: count, pinsOmitted: count,
    counts: { type: "object", additionalProperties: count }, attention,
  }, required: ["order", "offset", "end", "total", "counts", "reports"], additionalProperties: false,
} as const
const actorEvidence = {
  type: "object", properties: { reportOwed: stringArray, callOpen: stringArray }, required: ["reportOwed", "callOpen"], additionalProperties: false,
} as const
const changeSchema = mission.properties.history.items
const changeRow = {
  ...changeSchema, properties: { ...omit(changeSchema.properties, MISSION_BODY_FIELDS.change), bodies, excerpt },
  required: [...unlisted(changeSchema.required, MISSION_BODY_FIELDS.change), "bodies"],
} as const
const briefingIdentity = {
  ...missionBriefingSnapshotSchema, properties: omit(missionBriefingSnapshotSchema.properties, MISSION_BRIEFING_CONTENT),
  required: unlisted(missionBriefingSnapshotSchema.required, MISSION_BRIEFING_CONTENT),
} as const
const compactMission = {
  ...mission,
  properties: {
    ...omit(mission.properties, [...MISSION_BODY_FIELDS.mission, "tasks", "reports", "history", "frontier", "claims"]), bodies,
    excerpt: { type: "string", maxLength: 2 * MISSION_SUMMARY_OBJECTIVE }, briefing: briefingIdentity,
    tasks: { type: "array", maxItems: MISSION_TASK_PAGE + MISSION_TASK_PINS, items: taskRow },
    reports: { type: "array", maxItems: (MISSION_TASK_PAGE + MISSION_TASK_PINS) * MISSION_TASK_REPORT_ROWS + MISSION_PINNED_REPORTS, items: reportRow },
    history: { ...mission.properties.history, items: changeRow }, taskPage, actorEvidence,
  },
  required: [...unlisted(mission.required, [...MISSION_BODY_FIELDS.mission, "frontier", "claims"]), "excerpt", "bodies", "taskPage", "actorEvidence"],
} as const

const mutationMissionResult = {
  type: "object",
  properties: { mission },
  required: ["mission"],
  additionalProperties: false,
} as const

const requestID = { type: "string", minLength: 1, maxLength: 128 } as const
const contentSelector = {
  kind: { type: "string", enum: ["mission", "task", "report", "change"] }, field: { type: "string", minLength: 1, maxLength: 64 },
  taskKey: { type: "string", minLength: 2, maxLength: 64 }, reportId: { type: "string", minLength: 1, maxLength: 240 },
  change: { type: "integer", minimum: 1 },
} as const

const snapshotProperties = {
  version: { type: "number", const: 1 },
  projectID: { type: "string" },
  generatedAt: { type: "number" },
  missions: { type: "array", items: mission },
  discardedEvents: { type: "number" },
  cleanups: { type: "array", maxItems: MAX_PROJECTED_CLEANUPS, items: missionCleanupSchema },
  cleanupUnavailable: { type: "boolean" },
  controlUnavailable: { type: "boolean" },
  notificationUnavailable: { type: "boolean" },
} as const

export const CODENOMAD_MISSIONS_RPC = {
  id: CODENOMAD_MISSIONS_RPC_ID,
  methods: {
    recurrenceControl: {
      input: { type: "object", properties: { sessionID: { type: "string", minLength: 1, maxLength: 256 },
        workspaceID: { type: "string", minLength: 1, maxLength: 200 }, requestID,
        location, digest: { type: "string", minLength: 64, maxLength: 64 },
        scheduleID: { type: "string", minLength: 3, maxLength: 100 },
        expectedRevision: { type: "integer", minimum: 0 }, retry: { type: "boolean" },
        action: { type: "string", enum: ["play", "pause", "stop", "resume", "run-now", "check"] }, issuedAt: { type: "integer", minimum: 0 },
        profileSource: { type: "object", properties: { profileID: { type: "string" }, executionHost: { type: "string" },
          configYamlPath: { type: "string" } }, required: ["profileID", "executionHost", "configYamlPath"], additionalProperties: false },
        proof: { type: "string", minLength: 64, maxLength: 64 } },
        required: ["sessionID", "workspaceID", "requestID", "location", "digest", "scheduleID", "expectedRevision", "action", "issuedAt", "profileSource", "proof"], additionalProperties: false },
      output: { type: "object", properties: { version: { type: "integer", const: 1 }, scheduleID: { type: "string" }, requestID,
        revision: { type: "integer" }, expectedRevision: { type: "integer" }, action: { type: "string", enum: ["play", "pause", "stop", "resume", "run-now", "check"] },
        state: { type: "string", enum: ["running", "paused", "stopped"] }, targetsKnown: { type: "boolean" },
        controlsComplete: { type: "boolean" }, schedulerCancellation: { type: "string", enum: ["acknowledged", "unknown"] },
        targets: { type: "array", items: recurrenceNativeControlWire } },
        required: ["version", "scheduleID", "requestID", "revision", "expectedRevision", "action", "state", "targetsKnown", "targets", "controlsComplete"], additionalProperties: false },
    },
    recurrenceControlStatus: {
      input: recurrenceControlRequestWire,
      output: recurrenceControlStatusWire,
    },
    recurrenceRunNow: {
      input: { type: "object", properties: { ...RECURRENCE_RUN_NOW_STATUS_INPUT.properties,
        action: { type: "string", const: "run-now" }, sessionID: { type: "string" }, workspaceID: { type: "string" }, location,
        profileSource: { type: "object", properties: { profileID: { type: "string" }, executionHost: { type: "string" }, configYamlPath: { type: "string" } },
          required: ["profileID", "executionHost", "configYamlPath"], additionalProperties: false },
        issuedAt: { type: "integer" }, digest: { type: "string" }, proof: { type: "string" } },
        required: ["scheduleID", "requestID", "expectedRevision", "action", "sessionID", "workspaceID", "location", "profileSource", "issuedAt", "digest", "proof"], additionalProperties: false },
      output: RECURRENCE_RUN_NOW_OUTPUT,
    },
    recurrenceRunNowStatus: { input: RECURRENCE_RUN_NOW_STATUS_REQUEST, output: RECURRENCE_RUN_NOW_OUTPUT },

    recurrenceCurrent: {
      input: { type: "object", properties: { scheduleID: { type: "string", minLength: 3, maxLength: 100 } }, required: ["scheduleID"], additionalProperties: false },
      output: { type: "object", properties: {
        version: { type: "integer", const: 1 }, projectID: { type: "string" }, projectCanonical: { type: "string" }, location,
        scheduleID: { type: "string", minLength: 3, maxLength: 100 }, passageID: { type: ["string", "null"], minLength: 3, maxLength: 100 }, mission: sharedMissionMap,
      }, required: ["version", "projectID", "projectCanonical", "location", "scheduleID", "passageID"], additionalProperties: false },
    },
    recurrenceCurrentContent: recurrenceCurrentContentWire,
    recurrenceSnapshot: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: recurrenceSnapshotOutput,
    },
    recurrenceRead: {
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      output: { type: "object", properties: { schedule: { type: ["object", "null"], properties: {
        id: { type: "string" }, revision: { type: "integer" }, state: { type: "string", enum: ["paused", "running", "stopped"] },
        digest: { type: "string" }, projectID: { type: "string" }, projectCanonical: { type: "string" },
      }, required: ["id", "revision", "state", "digest", "projectID", "projectCanonical"], additionalProperties: false } },
      required: ["schedule"], additionalProperties: false },
    },
    recurrenceCreate: {
      input: { type: "object", properties: {
        id: { type: "string" }, requestID: { type: "string" }, digest: { type: "string" },
        config: { type: "object" }, directory: { type: "string" }, transport: { type: "object" },
        scope: { type: "object", properties: { channel: { type: "string" }, configIdentity: { type: "string" }, key: { type: "string" } },
          required: ["channel", "configIdentity", "key"], additionalProperties: false },
        executionHost: { type: "string" },
      }, required: ["id", "requestID", "digest", "config", "directory", "scope", "executionHost", "transport"], additionalProperties: false },
      output: { type: "object", properties: { schedule: { type: ["object", "null"], properties: {
        id: { type: "string" }, revision: { type: "integer" }, state: { type: "string", enum: ["paused", "running", "stopped"] },
        digest: { type: "string" }, projectID: { type: "string" }, projectCanonical: { type: "string" },
      }, required: ["id", "revision", "state", "digest", "projectID", "projectCanonical"], additionalProperties: false },
      noEffect: { type: "object", properties: { code: { type: "string", const: "capacity" }, id: { type: "string" },
        requestID: { type: "string" }, digest: { type: "string" }, projectID: { type: "string" }, projectCanonical: { type: "string" } },
        required: ["code", "id", "requestID", "digest", "projectID", "projectCanonical"], additionalProperties: false } },
      required: ["schedule"], additionalProperties: false },
    },
    recurrencePassageRead: recurrencePassageReadWire,
    recover: {
      input: {
        type: "object", properties: {
          missionID: { type: "string", minLength: 1, maxLength: 100 },
          expectedRevision: { type: "integer", minimum: 1 },
          target: { type: "string", enum: ["coordinator", "report"] },
          taskKey: { type: "string", minLength: 1, maxLength: 100 },
        }, required: ["missionID", "expectedRevision", "target"], additionalProperties: false,
      },
      output: { type: "object", properties: { mission, admitted: { type: "boolean", const: true } }, required: ["mission", "admitted"], additionalProperties: false },
      errors: missionMutationErrors,
    },
    lifecycle: { input: lifecycleInputSchema, output: mutationMissionResult, errors: missionMutationErrors },
    cleanupTarget: {
      input: {
        type: "object", properties: {
          missionID: { type: "string", minLength: 1, maxLength: 100 },
          deletionID: { type: "string", minLength: 1, maxLength: 100 },
          sessionID: { type: "string", minLength: 1, maxLength: 240 },
        }, required: ["missionID", "deletionID", "sessionID"], additionalProperties: false,
      },
      output: {
        type: "object", properties: { target: {
          type: "object", properties: {
            projectID: { type: "string" }, missionID: { type: "string" }, coordinatorSessionID: { type: "string" }, sessionID: { type: "string" }, location,
          }, required: ["projectID", "missionID", "coordinatorSessionID", "sessionID", "location"], additionalProperties: false,
        } }, additionalProperties: false,
      },
    },
    snapshot: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: { type: "object", properties: snapshotProperties,
        required: ["version", "projectID", "generatedAt", "missions", "discardedEvents"], additionalProperties: false },
    },
    panelPage: { input: missionPanelPageInputSchema, output: missionPanelPageOutputSchema },
    // Read-mostly panel reads from the journal index and per-mission ranges (`MissionControl.list`/`mission`).
    list: {
      input: { type: "object", properties: {
        include: { type: "array", maxItems: MISSION_LIST_MAX_INCLUDE, items: { type: "string", minLength: 1, maxLength: 100 } },
        summariesVersion: { type: "string", minLength: 1, maxLength: 64 },
      }, additionalProperties: false },
      output: { type: "object", properties: { ...snapshotProperties, missions: { type: "array", items: compactMission },
        summaries: { type: "array", items: missionSummarySchema }, summariesVersion: { type: "string" } },
        required: ["version", "projectID", "generatedAt", "missions", "discardedEvents", "cleanups", "summariesVersion"], additionalProperties: false },
    },
    mission: {
      input: { type: "object", properties: { missionID: { type: "string", minLength: 1, maxLength: 100 } }, required: ["missionID"], additionalProperties: false },
      output: { type: "object", properties: {
        version: snapshotProperties.version, projectID: snapshotProperties.projectID, generatedAt: snapshotProperties.generatedAt, mission: compactMission,
        cleanups: snapshotProperties.cleanups, cleanupUnavailable: { type: "boolean" }, controlUnavailable: { type: "boolean" },
        notificationUnavailable: { type: "boolean" },
      }, required: ["version", "projectID", "generatedAt", "cleanups"], additionalProperties: false },
    },
    // One mission body for display, in digest-pinned slices (`MissionControl.content`).
    // Kind-specific identities are checked by `missionContentRequestSchema`.
    content: {
      input: { type: "object", properties: {
        missionID: { type: "string", minLength: 1, maxLength: 100 }, ...contentSelector,
        digest: { type: "string", minLength: 43, maxLength: 43 }, offset: { type: "integer", minimum: 0 },
      }, required: ["missionID", "kind", "field", "offset"], additionalProperties: false },
      output: { type: "object", properties: {
        version: { type: "integer", const: 1 }, projectID: { type: "string" }, missionID: { type: "string" }, revision: { type: "integer", minimum: 1 },
        content: { type: "object", properties: { ...contentSelector, digest: { type: "string", minLength: 43, maxLength: 43 },
          offset: { type: "integer", minimum: 0 }, characters: { type: "integer", minimum: 0 }, json: { type: "boolean", const: true },
          text: { type: "string" }, next: { type: "integer", minimum: 1 } },
          required: ["kind", "field", "digest", "offset", "characters", "text"], additionalProperties: false },
        refused: { type: "string", enum: ["mission-not-found", "content-not-found", "content-changed"] },
      }, required: ["version", "projectID", "missionID"], additionalProperties: false },
    },
    // More of one map's tasks for display (`MissionControl.tasks`): a window of its display
    // order or of its omitted tasks needing action, or tasks by key, ID or report;
    // `missionTaskRequestSchema` checks the combination and the names' total.
    tasks: {
      input: { type: "object", properties: {
        missionID: { type: "string", minLength: 1, maxLength: 100 }, order: taskPage.properties.order, offset: count, attention: count,
        keys: { type: "array", maxItems: MISSION_TASK_PAGE, items: { type: "string", minLength: 1, maxLength: 64 } },
        ids: { type: "array", maxItems: MISSION_TASK_PAGE, items: { type: "string", minLength: 1, maxLength: 240 } },
        reportIds: { type: "array", maxItems: MISSION_TASK_PAGE, items: { type: "string", minLength: 1, maxLength: 240 } },
      }, required: ["missionID"], additionalProperties: false },
      output: { type: "object", properties: {
        version: { type: "integer", const: 1 }, projectID: { type: "string" }, missionID: { type: "string" }, revision: { type: "integer", minimum: 1 },
        taskPage, tasks: { type: "array", maxItems: MISSION_TASK_PAGE, items: taskRow },
        reports: { type: "array", maxItems: MISSION_TASK_PAGE * (MISSION_TASK_REPORT_ROWS + 1), items: reportRow },
        refused: { type: "string", enum: ["mission-not-found", "order-changed"] },
      }, required: ["version", "projectID", "missionID"], additionalProperties: false },
    },
    create: {
      errors: missionMutationErrors,
      input: {
        type: "object", properties: {
          requestID, objective: { type: "string", minLength: 1, maxLength: 20_000 },
          title: { type: "string", minLength: 1, maxLength: MISSION_TITLE_MAX },
          notes: { type: "string", maxLength: 20_000 },
          template: { type: "string", enum: ["custom", "wayfinder", "debug", "delivery", "compare"] },
          coordinatorSessionID: { type: "string", minLength: 1, maxLength: 240 },
          expectedCoordinatorLocation: location,
          prepared: { type: "boolean" },
          preparedBy: { type: "object", properties: { missionID: { type: "string", minLength: 1, maxLength: 100 },
            coordinatorSessionID: { type: "string", minLength: 1, maxLength: 240 } },
            required: ["missionID", "coordinatorSessionID"], additionalProperties: false },
          profiles: missionProfilesSchema,
          taskMode: missionTaskModeSchema,
        }, required: ["requestID", "objective", "template"], additionalProperties: false,
      },
      output: mutationMissionResult,
    },
    update: {
      errors: missionMutationErrors,
      input: {
        type: "object", properties: {
          missionID: { type: "string", minLength: 1, maxLength: 100 }, requestID,
          objective: { type: "string", minLength: 1, maxLength: 20_000 },
          notes: { type: "string", maxLength: 20_000 }, expectedRevision: { type: "integer", minimum: 1 },
        }, required: ["missionID", "requestID", "objective", "expectedRevision"], additionalProperties: false,
      },
      output: mutationMissionResult,
    },
    delete: {
      errors: missionMutationErrors,
      input: {
        type: "object", properties: {
          missionID: { type: "string", minLength: 1, maxLength: 100 }, requestID,
          expectedRevision: { type: "integer", minimum: 1 },
          deleteManagedSessions: { type: "boolean" },
        }, required: ["missionID", "requestID", "expectedRevision"], additionalProperties: false,
      },
      output: {
        type: "object", properties: { deleted: { type: "boolean", const: true }, cleanup: missionCleanupSchema },
        required: ["deleted"], additionalProperties: false,
      },
    },
  },
  events: {
    scheduleChanged: { schema: recurrenceScheduleChangedSchema },
    changed: {
      schema: {
        type: "object",
        properties: {
          missionID: { type: "string" },
          revision: { type: "number" },
        },
        required: ["missionID", "revision"],
        additionalProperties: false,
      },
    },
  },
} as const
