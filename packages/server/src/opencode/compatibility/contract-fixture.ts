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
  components: { schemas: {
    "Session.Inbox.User": { properties: { time: { type: "object" } } },
    "Session.Message.Assistant.Text": { properties: { type: {}, text: {}, native: {} } },
    "Session.Message.Compaction.Completed": { properties: { type: {}, metadata: {}, native: {}, summary: {} } },
  } },
}

// Consumed E1 fields from the captured public OpenAPI; enrichment APIs are absent.
export function explicitContractFixture(): any {
  const document: any = structuredClone(modernContractFixture)
  delete document.paths["/api/session/{sessionID}/environment"]
  delete document.paths["/api/location/reload"]
  const session = "/api/session/{sessionID}"
  for (const [route, methods] of Object.entries({
    "/api/info": ["get"], "/api/location": ["get"], "/api/event": ["get"],
    "/api/session": ["get", "post"], [session]: ["get", "delete", "patch"],
    [`${session}/message`]: ["get"], [`${session}/message/{messageID}`]: ["get"],
    [`${session}/prompt`]: ["post"], [`${session}/shell`]: ["post"], [`${session}/interrupt`]: ["post"],
    [`${session}/form/{formID}`]: ["get", "delete"], [`${session}/form/{formID}/reply`]: ["post"],
    [`${session}/agent`]: ["post"], [`${session}/model`]: ["post"],
    "/api/agent": ["get"], "/api/model": ["get"], "/api/provider": ["get"], "/api/command": ["get"],
  })) for (const method of methods) (document.paths[route] ??= {})[method] ??= {}
  document.paths[`${session}/interrupt`].post.parameters = [{ name: "resume", in: "query", schema: { type: "string", enum: ["true", "false"] } }]
  for (const [route, properties] of [
    ["prompt", { text: {} }], ["shell", { command: {} }], ["form/{formID}/reply", { answer: {} }],
    ["agent", { agent: { type: "string" } }], ["model", { model: { $ref: "#/components/schemas/Model.Ref" } }],
  ] as const) {
    document.paths[`${session}/${route}`].post.requestBody = { content: { "application/json": { schema: { properties } } } }
  }
  const schemas = document.components.schemas
  schemas["Session.Info"] = { properties: { id: {}, location: {} } }
  schemas.SessionsResponse = { properties: { data: {}, cursor: {} } }
  schemas["Model.Ref"] = { properties: { id: { type: "string" }, providerID: { type: "string" }, variant: { type: "string" } } }
  schemas["Location.PublicRef"] = { properties: { directory: { type: "string" } } }
  schemas["Skill.Info"] = { properties: { id: { type: "string" }, name: { type: "string" }, description: { type: "string" } } }
  schemas["Mcp.Server"] = { properties: { name: { type: "string" }, status: { anyOf: [
    { properties: { status: { type: "string", enum: ["connected"] } } },
    { properties: { status: { type: "string", enum: ["failed"] }, error: { type: "string" } } },
  ] } } }
  for (const [route, item] of [["mcp", "Mcp.Server"], ["skill", "Skill.Info"]]) {
    document.paths[`/api/${route}`] = { get: {
      parameters: [{ name: "location", in: "query", schema: { anyOf: [
        { properties: { directory: { anyOf: [{ type: "string" }, { type: "null" }] } } }, { type: "null" },
      ] } }],
      responses: { "200": { content: { "application/json": { schema: { properties: {
        location: { $ref: "#/components/schemas/Location.PublicRef" },
        data: { type: "array", items: { $ref: `#/components/schemas/${item}` } },
      } } } } } },
    } }
  }
  return document
}
