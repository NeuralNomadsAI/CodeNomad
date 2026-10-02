export const lifecycleInputSchema = {
  type: "object", properties: {
    missionID: { type: "string", minLength: 1, maxLength: 100 }, requestID: { type: "string", minLength: 1, maxLength: 128 },
    expectedRevision: { type: "integer", minimum: 1 }, action: { type: "string", enum: ["start", "pause", "stop"] },
  }, required: ["missionID", "requestID", "expectedRevision", "action"], additionalProperties: false,
} as const
export const lifecycleOperationSchema = {
  type: "object", properties: {
    ...lifecycleInputSchema.properties, id: { type: "string" }, pending: { type: "array", items: { type: "string" } },
    targets: { type: "array", items: {
      type: "object", properties: { sessionID: { type: "string" }, location: {
        type: "object", properties: { directory: { type: "string" }, workspaceID: { type: "string" } }, required: ["directory"], additionalProperties: false,
      } }, required: ["sessionID", "location"], additionalProperties: false,
    } },
  }, required: [...lifecycleInputSchema.required, "id", "pending", "targets"], additionalProperties: false,
} as const
