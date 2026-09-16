// Minimal structural excerpts from the published earlier V2 OpenAPI document.
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
