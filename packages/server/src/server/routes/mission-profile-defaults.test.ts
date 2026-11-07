import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import Fastify from "fastify"
import { AUTOMATION_BRIDGE_PATH } from "../../opencode/automation-plugin"
import { registerAutomationPluginRoute } from "./automation-plugin"
import { readMissionProfileDefaults } from "./mission-profile-defaults"
import { MISSION_DEFAULTS_REQUEST_INVALID } from "../../missions/recovery-error"

function fixture(t: TestContext, read?: () => unknown) {
  const app = Fastify()
  t.after(() => app.close())
  registerAutomationPluginRoute(app, {
    authManager: { isLoopbackRequest: () => true }, bridgeToken: "fixture", nativeParent: {}, developerCdp: {},
    settings: { getProfileScope: () => assert.fail("Profile scope is unrelated"), ...(read ? { getRawConfigOwner: (owner: string) => {
      assert.equal(owner, "ui")
      return read()
    } } : {}) },
    workspaceManager: {
      getSharedServiceClient: async () => ({ session: { get: async () => ({ location: { directory: "/repo" } }) } }),
      list: () => [{ id: "owner" }], ownsLocation: async () => true,
    },
  } as never)
  return (input: unknown = { template: "custom" }, extraCommand = {}) => app.inject({
    method: "POST", url: AUTOMATION_BRIDGE_PATH, headers: { "x-codenomad-automation-token": "fixture" },
    payload: { mode: "mission-input", sessionID: "ses_owner", command: { kind: "profile-defaults", input, ...extraCommand } },
  })
}

test("profile defaults read missing and empty preferences freshly without a dispatch fence", async t => {
  let owner: unknown = {}, reads = 0
  const request = fixture(t, () => { reads++; return owner })
  const native = { profiles: { coordinator: {}, roles: { specialist: {} } }, taskMode: "native",
    origins: { coordinator: "opencode-default", roles: { specialist: "opencode-default" }, taskMode: "opencode-default" } }
  assert.deepEqual((await request()).json(), { result: native })
  owner = { settings: { missionProfileDefaults: [] } }
  assert.deepEqual((await request()).json(), { result: native })
  owner = { settings: { missionProfileDefaults: [{ template: "all", profiles: { coordinator: { agent: "general" } }, taskMode: "independent" }] } }
  const preferred = await request()
  assert.equal(preferred.statusCode, 200)
  assert.equal(preferred.json().result.profiles.coordinator.agent, "general")
  assert.equal(preferred.json().result.taskMode, "independent")
  assert.equal(preferred.json().result.origins.coordinator, "preference")
  const explicit = await request({ template: "custom", profiles: { coordinator: {} }, taskMode: "native" })
  assert.deepEqual(explicit.json().result.profiles.coordinator, {})
  assert.equal(explicit.json().result.origins.coordinator, "explicit")
  assert.equal(explicit.json().result.origins.taskMode, "explicit")
  assert.equal(reads, 4)
})

test("invalid preference values fail closed with a fixed redacted code", async t => {
  let preferences: unknown
  const request = fixture(t, () => ({ settings: { missionProfileDefaults: preferences } }))
  for (preferences of [null, {}, "secret-provider-token", [{ template: "other", profiles: {} }],
    [{ template: "all", profiles: {}, taskMode: "other" }]]) {
    const response = await request()
    assert.equal(response.statusCode, 409)
    assert.deepEqual(response.json(), { code: "mission-preferences-invalid", error: "Correct the Missions preferences before creating a mission" })
    const explicit = await request({ template: "custom", profiles: { coordinator: {} }, taskMode: "native" })
    assert.equal(explicit.json().code, "mission-preferences-invalid")
  }
})

test("profile default command validates all input before reading preferences", async t => {
  let reads = 0
  const request = fixture(t, () => { reads++; return { settings: { missionProfileDefaults: null } } })
  for (const input of [null, {}, { template: "other" }, { template: "custom", extra: true },
    { template: "custom", taskMode: "other" }, { template: "custom", coordinatorModel: { providerID: "p" } },
    { template: "custom", profiles: null }, { template: "custom", profiles: { extra: true } },
    { template: "custom", profiles: { roles: { developer: {} } } },
    { template: "custom", profiles: { coordinator: { model: { providerID: "p" } } } }]) {
    const response = await request(input)
    assert.equal(response.statusCode, 409)
    assert.equal(response.json().code, "invalid-execution")
    assert.match(response.json().error, /profiles|taskMode|playbook/i)
    assert.doesNotMatch(response.json().error, /preferences/i)
  }
  assert.equal((await request({ template: "custom" }, { extra: true })).json().code, "invalid-execution")
  assert.equal(reads, 0)
})

test("invalid command and selector requests share actionable validation copy", () => {
  for (const command of [{ kind: "profile-defaults", extra: true }, { kind: "profile-defaults", input: { template: "other" } }]) {
    assert.throws(() => readMissionProfileDefaults(undefined, command), (error: any) =>
      error.code === "invalid-execution" && error.message === MISSION_DEFAULTS_REQUEST_INVALID)
  }
})

test("profile resolution preserves unexpected errors rather than labelling them invalid preferences", () => {
  const failure = Object.assign(new Error("Unexpected resolver failure"), { name: "MissionPreferencesError", code: "mission-preferences-invalid" })
  const preferences = new Proxy([], { get() { throw failure } })
  assert.throws(() => readMissionProfileDefaults({ getRawConfigOwner: () => ({ settings: { missionProfileDefaults: preferences } }) } as never,
    { kind: "profile-defaults", input: { template: "custom" } }), error => error === failure)
})

test("missing or unreadable preference readers expose only the fixed unavailable error", async t => {
  for (const read of [undefined, () => ({ settings: null }), () => { throw new Error("secret /private/config.yaml") }]) {
    const response = await fixture(t, read)()
    assert.equal(response.statusCode, 503)
    assert.deepEqual(response.json(), { code: "mission-preferences-unavailable", error: "CodeNomad backend discovery, ownership or preference reading failed; restore the backend and reload Missions preferences" })
  }
})

test("profile resolution leaves Compare validation to mission control", async t => {
  const response = await fixture(t, () => ({}))({ template: "compare" })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json().result.profiles.roles, { "model-a": {}, "model-b": {}, comparator: {} })
  const known = await fixture(t, () => ({}))({ template: "compare", coordinatorModel: { providerID: "p", id: "known", variant: "default" } })
  assert.deepEqual(known.json().result.profiles.roles.comparator, { model: { providerID: "p", id: "known" } })
})
