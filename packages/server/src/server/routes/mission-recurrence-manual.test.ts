import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { registerMissionRecurrenceManual } from "./mission-recurrence-manual"

test("Run now and its read-only status require authenticated human admission; invalid requests never reach native APIs", async () => {
  const app = Fastify()
  let enabled = false, nativeReads = 0
  registerMissionRecurrenceManual(app, { auth: { isAuthEnabled: () => enabled,
    getSessionFromRequest: () => enabled ? { sessionId: "human-cookie", username: "human" } : { sessionId: "auth-disabled", username: "human" } },
    manager: { get: () => { nativeReads++; throw new Error("Invalid request must not read native data") } },
  } as never)
  const url = "/api/workspaces/owned/missions/recurrence/schedule_one/run-now"
  try {
    assert.equal((await app.inject({ method: "POST", url, payload: { requestID: "manual_one", expectedRevision: 0 } })).statusCode, 401)
    assert.equal((await app.inject({ method: "GET", url: `${url}/status?requestID=manual_one&expectedRevision=0` })).statusCode, 401)
    enabled = true
    assert.equal((await app.inject({ method: "POST", url, payload: { requestID: "manual_one", expectedRevision: 0, expectedEpoch: 0 } })).statusCode, 400)
    assert.equal((await app.inject({ method: "GET", url: `${url}/status?requestID=manual_one&expectedRevision=-1` })).statusCode, 400)
    assert.equal(nativeReads, 0)
  } finally { await app.close() }
})
