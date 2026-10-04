// Narrow private evidence/contract port, never an arbitrary tool executor.
const text = { type: "string", minLength: 1, maxLength: 240 }
const auth = { token: text }
const contract = { parentID: text, callID: text, rootRequestID: text, executionID: text, taskKey: text, contractRequestID: text }
const input = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false })
export const CHILD_ENV_RPC = { id: "private.missions.child.environment", methods: {
  authorize: { input: input({ ...auth, ...contract }), output: { type: "object" } },
  proof: { input: input({ ...auth, parentID: text, callID: text }), output: { type: "object" } },
  capabilities: { input: input(auth), output: { type: "object" } },
  disposeWrapper: { input: input(auth), output: { type: "object" } },
}, events: {} }
