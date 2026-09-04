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
    status: { type: "string", enum: ["active", "completed", "failed"] },
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
          blockedBy: stringArray,
          status: { type: "string", enum: ["blocked", "ready", "dispatching", "queued", "completed", "needs-input", "failed"] },
          actorSessionId: { type: "string" },
          admissionId: { type: "string" },
          delivery: { type: "string", enum: ["queue", "steer"] },
          createdAt: { type: "number" },
          updatedAt: { type: "number" },
          report,
        },
        required: ["id", "key", "title", "brief", "role", "blockedBy", "status", "createdAt", "updatedAt"],
        additionalProperties: false,
      },
    },
    reports: { type: "array", items: report },
    frontier: stringArray,
    claims: stringArray,
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    revision: { type: "number" },
  },
  required: [
    "version", "id", "projectID", "projectCanonical", "objective", "template", "status", "coordinatorSessionId",
    "actors", "tasks", "reports", "frontier", "claims", "createdAt", "updatedAt", "revision",
  ],
  additionalProperties: false,
} as const

export const CODENOMAD_MISSIONS_RPC = {
  id: CODENOMAD_MISSIONS_RPC_ID,
  methods: {
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
