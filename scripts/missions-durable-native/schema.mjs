// Narrow, token-authenticated private diagnostics; no general tool driver.
const authInput = { type: "object", properties: { token: { type: "string" }, id: { type: "string" } }, required: ["token"], additionalProperties: false }
export const FIXTURE_RPC = { id: "private.missions.durable.fixture", methods: Object.fromEntries(
  ["capabilities", "checkpoint", "staleInspector", "damageAuthority"].map(name => [name, { input: authInput, output: { type: "object" } }]),
), events: {} }
