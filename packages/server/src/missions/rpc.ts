import { executionSchema } from "./execution"
import { missionProfilesSchema } from "./playbook-profiles"
import { missionTaskModeSchema } from "./task-execution-mode"
import { missionMutationErrors } from "./rpc-errors"
import { lifecycleInputSchema, lifecycleOperationSchema } from "./lifecycle-schema"
import { missionCleanupSchema } from "./cleanup-projection"
import { MISSION_MAX_EVENTS } from "./model"
import { MISSION_TITLE_MAX } from "./mission-title"
import { missionBriefingSnapshotSchema } from "./briefing"
import { taskExecutionModeRpcSchema, taskGenerationSchema, nativeTaskBindingSchema, nativeTaskExecutionSchema, nativeCallBindingSchema } from "./native-wire-schema"
import { recurrenceCurrentContentWire } from "./recurrence-current"
import { recurrencePassageReadWire } from "./recurrence-reader-contract"
import { recurrenceScheduleChangedSchema } from "./recurrence-events"
import { recurrenceNativeControlWire, recurrenceSnapshotOutput, recurrenceControlStatusWire, recurrenceControlRequestWire } from "./recurrence-control-contract"
import { RECURRENCE_RUN_NOW_STATUS_INPUT, RECURRENCE_RUN_NOW_OUTPUT } from "./recurrence-manual-rpc"

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
    objective: { type: "string" },
    notes: { type: "string" },
    template: { type: "string", enum: ["custom", "pocock-fix-bug", "wayfinder"] },
    profiles: missionProfilesSchema,
    taskMode: missionTaskModeSchema,
    status: { type: "string", enum: ["active", "completed", "failed", "stopped"] },
    runState: { type: "string", enum: ["prepared", "running", "paused", "stopped"] },
    control: lifecycleOperationSchema,
    controlUnavailable: { type: "boolean" },
    notificationUnavailable: { type: "boolean" },
    summary: { type: "string" },
    coordinatorSessionId: { type: "string" },
    briefing: missionBriefingSnapshotSchema,
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

const mutationMissionResult = {
  type: "object",
  properties: { mission },
  required: ["mission"],
  additionalProperties: false,
} as const

const requestID = { type: "string", minLength: 1, maxLength: 128 } as const

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
        targets: { type: "array", maxItems: 32, items: recurrenceNativeControlWire } },
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
    recurrenceRunNowStatus: { input: RECURRENCE_RUN_NOW_STATUS_INPUT, output: RECURRENCE_RUN_NOW_OUTPUT },

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
      output: {
        type: "object",
        properties: {
          version: { type: "number", const: 1 },
          projectID: { type: "string" },
          generatedAt: { type: "number" },
          missions: { type: "array", items: mission },
          discardedEvents: { type: "number" },
          cleanups: { type: "array", maxItems: MISSION_MAX_EVENTS, items: missionCleanupSchema },
          cleanupUnavailable: { type: "boolean" },
          controlUnavailable: { type: "boolean" },
          notificationUnavailable: { type: "boolean" },
        },
        required: ["version", "projectID", "generatedAt", "missions", "discardedEvents"],
        additionalProperties: false,
      },
    },
    create: {
      errors: missionMutationErrors,
      input: {
        type: "object", properties: {
          requestID, objective: { type: "string", minLength: 1, maxLength: 20_000 },
          title: { type: "string", minLength: 1, maxLength: MISSION_TITLE_MAX },
          notes: { type: "string", maxLength: 20_000 },
          template: { type: "string", enum: ["custom", "wayfinder", "pocock-fix-bug"] },
          coordinatorSessionID: { type: "string", minLength: 1, maxLength: 240 },
          expectedCoordinatorLocation: location,
          prepared: { type: "boolean" },
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
