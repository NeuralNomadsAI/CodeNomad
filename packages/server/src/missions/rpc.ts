import { executionSchema } from "./execution"
import { missionMutationErrors } from "./rpc-errors"
import { lifecycleInputSchema, lifecycleOperationSchema } from "./lifecycle-schema"

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
    objective: { type: "string" },
    notes: { type: "string" },
    template: { type: "string", enum: ["custom", "pocock-fix-bug", "wayfinder"] },
    status: { type: "string", enum: ["active", "completed", "failed", "stopped"] },
    runState: { type: "string", enum: ["prepared", "running", "paused", "stopped"] },
    control: lifecycleOperationSchema,
    summary: { type: "string" },
    coordinatorSessionId: { type: "string" },
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
          notes: { type: "string", maxLength: 20_000 },
          template: { type: "string", enum: ["custom", "wayfinder", "pocock-fix-bug"] },
          coordinatorSessionID: { type: "string", minLength: 1, maxLength: 240 },
          prepared: { type: "boolean" },
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
        type: "object", properties: { deleted: { type: "boolean", const: true } },
        required: ["deleted"], additionalProperties: false,
      },
    },
  },
  events: {
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
