import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { CanonicalNativeAuthority } from "./native-authority"
import { MISSION_AUTHORITY_POLICY } from "../authority-protocol"
import { controlOperationID } from "../receipt-identity"
import type { AuthorityGrant } from "../authority-store"

// Read-boundary UNIT fixture only; no native attestation/startup qualification.
function fixture() {
  const grant: AuthorityGrant = { version: 1, authorityID: "authority", keyID: "key", profileID: "profile", executionHost: "host",
    namespace: randomUUID(), projectID: "project", projectCanonical: "/owned", roots: [{ mode: "directory-only", directory: "/owned" }],
    missionID: "mission", coordinatorSessionID: "coordinator", epoch: 1, signerDigest: "a".repeat(64), state: "active", sendsEnabled: true }
  const actor = { sessionId: "coordinator", kind: "coordinator", location: { directory: "/owned" } }
  const mission: any = { id: "mission", projectID: "project", projectCanonical: "/owned", coordinatorSessionId: "coordinator",
    revision: 3, status: "active", runState: "running", actors: [actor], control: { id: controlOperationID("mission", "play"),
      missionID: "mission", requestID: "play", action: "start", expectedRevision: 2, completedRevision: 3,
      pending: [], targets: [{ sessionID: "coordinator", location: { directory: "/owned" } }] } }
  let existing = true, acquisitions = 0, snapshots = 0, change: (() => void) | undefined
  const connection: any = { assertCurrent() {}, client: {
    session: { get: async () => ({ id: "coordinator", projectID: "project", location: { directory: "/owned" } }) },
    rpc: () => ({
      challenge: async ({ nonce }: any) => ({ nonce, namespace: grant.namespace, policy: MISSION_AUTHORITY_POLICY, projectID: "project", projectCanonical: "/owned" }),
      state: async () => ({ continuity: "active", grant: structuredClone(grant), terminal: null, pendingRequestIDs: [] }),
      snapshot: async () => { if (++snapshots > 1) change?.(); return { version: 1, projectID: "project", discardedEvents: 0, missions: [structuredClone(mission)] } },
    }),
  } }
  const native = new CanonicalNativeAuthority({ workspaceID: "workspace", assertNativeCurrent: () => true,
    humanIntents: {} as never, manager: {
      getSharedServiceConnection: async () => { acquisitions++; throw new Error("startup must never be acquired") },
      getExistingSharedServiceConnection: () => existing ? connection : undefined,
      ownsLocation: async (_id, location, _client, _signal, purpose) => { assert.equal(purpose, "event"); return location.directory === "/owned" },
    }, roots: {
      assertRoots: async () => { throw new Error("ordinary roots may acquire startup") },
      resolve: async () => { throw new Error("ordinary root resolution forbidden") },
      assertExistingRoots: async () => {}, resolveExisting: async () => grant.roots[0],
    } as never,
  })
  return { native, grant, mission, acquisitions: () => acquisitions, absent: () => { existing = false }, change: (run: () => void) => { change = run } }
}

test("native restoration uses existing-only connection/roots and stable completed canonical Play", async () => {
  const f = fixture(), result = await f.native.restore(f.grant, new AbortController().signal)
  assert.deepEqual(result.control, f.mission.control)
  assert.equal(f.acquisitions(), 0)
  f.absent()
  await assert.rejects(f.native.restore(f.grant, new AbortController().signal), /observation-unavailable/)
  assert.equal(f.acquisitions(), 0)
})

test("missing, contradictory, foreign-location and changing control evidence cannot restore a grant", async () => {
  for (const damage of [
    (f: ReturnType<typeof fixture>) => { delete f.mission.control },
    (f: ReturnType<typeof fixture>) => { f.mission.control.action = "pause" },
    (f: ReturnType<typeof fixture>) => { f.mission.control.targets[0].location.directory = "/foreign" },
    (f: ReturnType<typeof fixture>) => { f.mission.control.pending = {} },
    (f: ReturnType<typeof fixture>) => { f.mission.control.id = "wrong-operation" },
    (f: ReturnType<typeof fixture>) => { f.change(() => { f.mission.control.requestID = "different-play"; f.mission.control.id = controlOperationID("mission", "different-play") }) },
  ]) {
    const f = fixture(); damage(f)
    await assert.rejects(f.native.restore(f.grant, new AbortController().signal), /authorization-blocked|observation-unavailable/)
    assert.equal(f.acquisitions(), 0)
  }
})
