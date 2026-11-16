import assert from "node:assert/strict"
import test from "node:test"
import { recurrenceControlRequestDigest, type RecurrenceControlProofBody } from "../../missions/recurrence-control-proof"
import { automaticMissionStartID } from "../../missions/preparation-result"
import { missionScheduleID } from "../../missions/mission-schedule-contract"
import { verifyRecurrenceRequest } from "./mission-recurrence-proof"

function fixture() {
  let cookieReads = 0, ownerReads = 0, projectID = "project", nativeDirectory = "/owned"
  let intent = true, intentReads = 0
  const author = { coordinatorSessionID: "ses_author", missionID: "source_mission" }
  const principal = { kind: "agent" as const, author, creationRequestID: "original", creationDigest: "c".repeat(64) }
  const creation = { requestID: "original", digest: principal.creationDigest, author: structuredClone(author),
    input: { objective: "Work", template: "custom", startOnCreation: true },
    automaticStart: { requestID: automaticMissionStartID("original"), attempted: false } }
  const document = { id: "schedule_owned", revision: 1, state: "paused", firstPlayedAt: null as number | null, creation }
  const base = { principal, workspaceID: "workspace", requestID: creation.automaticStart.requestID, scheduleID: document.id,
    expectedRevision: 1, action: "play" as const, location: { directory: "/owned" },
    profileSource: { profileID: "profile", executionHost: "local", configYamlPath: "/private/profile.yaml" }, issuedAt: Date.now() }
  const workspace = {}
  const deps = {
    auth: { isAuthEnabled: () => false, getCookieName: () => "cookie",
      getSessionFromHeaders: () => { cookieReads++; throw new Error("Agent sent to cookie reader") } },
    settings: { getProfileScope: () => ({ key: "profile" }) },
    manager: { get: () => workspace, getServiceWslDistro: () => undefined,
      ownsLocation: async () => { ownerReads++; return true },
      getSharedServiceConnection: async () => ({ assertCurrent: () => {}, client: {
        location: { get: async () => ({ directory: "/owned", project: { id: "project", canonical: "/owned" } }) },
        session: { get: async () => ({ id: author.coordinatorSessionID, projectID, location: { directory: nativeDirectory } }) },
        rpc: () => ({ scheduleRead: async () => ({ document, pending: false }),
          schedulePreparationRead: async ({ creationRequestID }: { creationRequestID: string }) => {
            intentReads++
            return intent && creationRequestID === principal.creationRequestID
              ? { binding: { author, creationRequestID, creationDigest: principal.creationDigest } } : {}
          } }),
      } }),
    },
    verifyAgentCreation: async (body: RecurrenceControlProofBody) => { intentReads++; return intent
      && body.configDigest === "b".repeat(64) && body.requestID === "original" && body.action === "create" },
  }
  const sign = (patch: Partial<RecurrenceControlProofBody> = {}) => {
    const identity = { ...base, ...patch } as Omit<Extract<RecurrenceControlProofBody, { principal: unknown }>, "digest">
    return { ...identity, digest: recurrenceControlRequestDigest(identity) }
  }
  const verify = (body = sign(), supplied: unknown = deps) => verifyRecurrenceRequest(body, supplied as never, new AbortController().signal)
  return { verify, sign, deps, document, author, stats: () => ({ cookieReads, ownerReads, intentReads }),
    foreign: () => { projectID = "foreign" }, moved: () => { nativeDirectory = "/other" }, missingIntent: () => { intent = false } }
}

test("agent first Play verifies exact native author and document without any cookie lookup", async () => {
  const f = fixture()
  assert.deepEqual(await f.verify(), { admitted: true })
  assert.equal(f.stats().cookieReads, 0)
  f.document.firstPlayedAt = 2
  await assert.rejects(f.verify(), /first Play unavailable/)
  f.document.firstPlayedAt = null; f.document.creation.automaticStart.attempted = true
  await assert.rejects(f.verify(), /first Play unavailable/)
  f.document.creation.automaticStart.attempted = false; f.document.creation.author.coordinatorSessionID = "ses_foreign"
  await assert.rejects(f.verify())
  assert.equal(f.stats().cookieReads, 0)
})

test("agent CREATE reads the native binding by default and retains the owned-author gate", async () => {
  const f = fixture(), create = f.sign({ action: "create", requestID: "original", expectedRevision: 0,
    scheduleID: missionScheduleID("project", "/owned", "original"), configDigest: "b".repeat(64) })
  assert.deepEqual(await f.verify(create), { admitted: true })
  const { verifyAgentCreation: _verify, ...withoutHook } = f.deps
  assert.deepEqual(await f.verify(create, withoutHook), { admitted: true })
  assert.equal(f.stats().intentReads, 2)
  f.missingIntent(); await assert.rejects(f.verify(create), /creation unavailable/)
  await assert.rejects(f.verify(create, withoutHook))
  f.foreign(); await assert.rejects(f.verify(create), /agent owner unavailable/)
  assert.equal(f.stats().cookieReads, 0)
})

test("native creation binding cannot authorize another author, digest, request or document", async () => {
  const f = fixture(), { verifyAgentCreation: _verify, ...production } = f.deps
  const base = { action: "create" as const, requestID: "original", expectedRevision: 0,
    scheduleID: missionScheduleID("project", "/owned", "original"), configDigest: "b".repeat(64) }
  const original = f.sign(base)
  for (const patch of [
    { principal: { ...original.principal, creationDigest: "d".repeat(64) } },
    { principal: { ...original.principal, author: { ...f.author, missionID: "other_source" } } },
    { requestID: "different" },
    { scheduleID: "foreign_document" },
  ]) await assert.rejects(f.verify(f.sign({ ...base, ...patch }), production))
  assert.equal(f.stats().cookieReads, 0)
})

test("agent controls and forged identities refuse before ownership, cookie or intent reads", async () => {
  const f = fixture()
  for (const action of ["pause", "resume", "stop", "run-now", "check", "configure", "delete"] as const)
    await assert.rejects(f.verify(f.sign({ action })), /agent control refused/)
  await assert.rejects(f.verify({ ...f.sign(), sessionID: "fake-cookie" } as never))
  await assert.rejects(f.verify({ ...f.sign(), requestID: "forged" }))
  assert.deepEqual(f.stats(), { cookieReads: 0, ownerReads: 0, intentReads: 0 })
  f.moved(); await assert.rejects(f.verify(), /agent owner unavailable/)
})
