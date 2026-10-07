const input = { type: "object", properties: { nonce: { type: "string" }, sessionID: { type: "string" },
  pid: { type: "integer" }, phase: { enum: ["due", "shutdown"] } },
  required: ["nonce", "sessionID", "pid", "phase"], additionalProperties: false }
const job = { type: "object", properties: { id: { type: "string" }, type: { type: "string" },
  status: { enum: ["running", "completed", "error", "cancelled"] }, output: { type: "string" } },
  required: ["id", "type", "status"], additionalProperties: false }
export const JOB_RPC = { id: "missions.fixture-job-adoption", methods: {
  start: { input, output: { type: "object", properties: { job, ids: { type: "object" }, directory: { type: "string" } },
    required: ["job", "ids", "directory"], additionalProperties: false },
    errors: { unavailable: { type: "object", additionalProperties: false } } },
  inspect: { input, output: job, errors: { unavailable: { type: "object", additionalProperties: false } } },
  wait: { input, output: job, errors: { unavailable: { type: "object", additionalProperties: false } } },
}, events: {} }
export const jobID = (nonce, phase) => `job_missions_fixture_${nonce.replaceAll("-", "")}_${phase}`
export const JOB_TYPE = "missions-fixture-adoption"
