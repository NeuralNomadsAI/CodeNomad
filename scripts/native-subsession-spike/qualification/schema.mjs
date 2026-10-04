const text = { type: "string", minLength: 1, maxLength: 240 }
export const RPC = { id: "private.recursive.qualification", methods: {
  control: { input: { type: "object", properties: { token: text, rootID: text, state: { enum: ["running", "paused", "stopped"] }, gate: { type: "boolean" }, explicitEnvironment: { type: "boolean" }, fault: text }, required: ["token", "rootID", "state"], additionalProperties: false }, output: { type: "object" } },
  inspect: { input: { type: "object", properties: { token: text }, required: ["token"], additionalProperties: false }, output: { type: "object" } },
  gracefulHandler: { input: { type: "object", properties: { token: text }, required: ["token"], additionalProperties: false }, output: { type: "object" } },
}, events: {} }
