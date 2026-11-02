export const definition = { id: "missions.terminal.fixture", methods: {
  read: { input: { type: "object", properties: { sessionID: { type: "string" }, messageID: { type: "string" } }, required: ["sessionID"] }, output: { type: "object" } },
  waits: { input: { type: "object", properties: { sessionIDs: { type: "array", items: { type: "string" } } }, required: ["sessionIDs"] }, output: { type: "object" } },
  resume: { input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"] }, output: { type: "object" } },
}, events: {} }
