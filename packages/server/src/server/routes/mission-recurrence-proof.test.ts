import assert from "node:assert/strict"
import test from "node:test"
import { recurrenceControlRequestDigest } from "../../missions/recurrence-control-proof"
import { verifyHumanRecurrenceRequest } from "./mission-recurrence-proof"

test("recurrence proof requires a current real human session, exact request digest and owned Location", async () => {
  const identity = { sessionID: "real-cookie", workspaceID: "workspace", requestID: "http_play_0",
    location: { directory: "/owned" }, scheduleID: "daily_review", action: "play" as const, expectedRevision: 0, expectedEpoch: 0,
    profileSource: { profileID: "profile", executionHost: "local", configYamlPath: "/selected/config.yaml" }, issuedAt: Date.now() }
  const body = { ...identity, digest: recurrenceControlRequestDigest(identity) }
  let authEnabled = true, sessionCurrent = true, owned = true
  const workspace = {}
  const deps = { settings: { getProfileScope: () => ({ key: "profile" }) },
    auth: { isAuthEnabled: () => authEnabled, getCookieName: () => "cookie",
    getSessionFromHeaders: () => sessionCurrent ? { username: "human", sessionId: "real-cookie" } : null },
    manager: { getServiceWslDistro: () => undefined, get: () => workspace, ownsLocation: async () => owned,
      getSharedServiceConnection: async () => ({ assertCurrent: () => {}, client: {
        location: { get: async () => ({ directory: "/owned" }) },
      } }) } }
  const verify = (input = body) => verifyHumanRecurrenceRequest(input, deps as never, new AbortController().signal)
  assert.deepEqual(await verify(), { admitted: true })
  authEnabled = false
  await assert.rejects(verify())
  authEnabled = true; sessionCurrent = false
  await assert.rejects(verify())
  sessionCurrent = true; owned = false
  await assert.rejects(verify())
  owned = true
  await assert.rejects(verify({ ...body, requestID: "another-http-request" }))
})

test("ownership finishing after the original proof deadline never acknowledges human admission", async () => {
  const issuedAt = 100_000
  let now = issuedAt + 29_900
  const identity = { sessionID: "real-cookie", workspaceID: "workspace", requestID: "http_play_0",
    location: { directory: "/owned" }, scheduleID: "daily_review", action: "play" as const,
    expectedRevision: 0, expectedEpoch: 0,
    profileSource: { profileID: "profile", executionHost: "local", configYamlPath: "/private/config.yaml" }, issuedAt }
  const workspace = {}
  const deps = { settings: { getProfileScope: () => ({ key: "profile" }) },
    auth: { isAuthEnabled: () => true, getCookieName: () => "cookie",
      getSessionFromHeaders: () => ({ username: "human", sessionId: "real-cookie" }) },
    manager: { getServiceWslDistro: () => undefined, get: () => workspace, ownsLocation: async () => { now += 200; return true },
      getSharedServiceConnection: async () => ({ assertCurrent: () => {}, client: { location: { get: async () => ({ directory: "/owned" }) } } }) } }
  await assert.rejects(verifyHumanRecurrenceRequest({ ...identity, digest: recurrenceControlRequestDigest(identity) },
    deps as never, new AbortController().signal, () => now), /proof expired/)
})
