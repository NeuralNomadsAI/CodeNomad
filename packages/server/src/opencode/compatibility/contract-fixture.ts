// Minimal structural excerpts from the published V2 OpenAPI contracts.
// For test fixtures only; real-runtime tests also negotiate full native schemas.
export const legacyContractFixture = {
  paths: {
    "/api/session/{sessionID}/rename": { post: {} },
    "/api/form/request": { get: {} },
    "/api/session/{sessionID}/form/{formID}/cancel": { post: {} },
    "/api/session/{sessionID}/wait": { post: {} },
    "/api/session/{sessionID}/fork": { post: { requestBody: { content: { "application/json": { schema: { properties: { boundary: {} } } } } } } },
    "/api/session/{sessionID}/command": { post: { requestBody: { content: { "application/json": { schema: { properties: { command: {} } } } } } } },
    "/api/session/{sessionID}/permission/{requestID}/reply": { post: { requestBody: { content: { "application/json": { schema: { properties: { reply: {} } } } } } } },
  },
  components: { schemas: { "Session.Inbox.User": { properties: { timeCreated: { type: "number" } } } } },
}

export const modernContractFixture = {
  paths: {
    "/api/location/reload": { post: {} },
    "/api/session/{sessionID}/environment": { put: { requestBody: { content: { "application/json": { schema: { properties: { variables: { type: "object", additionalProperties: { type: "string" } } } } } } } } },
    "/api/session/{sessionID}": { patch: {} },
    "/api/form": { get: {} },
    "/api/session/{sessionID}/form/{formID}": { delete: {} },
    "/api/experimental/session/{sessionID}/wait": { post: {} },
    "/api/session/{sessionID}/fork": { post: { requestBody: { content: { "application/json": { schema: { properties: { before: {} } } } } } } },
    "/api/session/{sessionID}/command": { post: { requestBody: { content: { "application/json": { schema: { properties: { name: {} } } } } } } },
    "/api/session/{sessionID}/permission/{requestID}/reply": { post: { requestBody: { content: { "application/json": { schema: { properties: { decision: {} } } } } } } },
  },
  components: { schemas: { "Session.Inbox.User": { properties: { time: { type: "object" } } } } },
}
