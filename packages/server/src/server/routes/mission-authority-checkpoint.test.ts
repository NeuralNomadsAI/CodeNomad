import assert from "node:assert/strict"
import test from "node:test"
import type { OpenCodeClient } from "@opencode/client"
import { missionInstructionClient, prepareMissionAuthority } from "./mission-authority-checkpoint"

test("advisory instruction writes retain a fresh literal-true fence after their probe awaits", async () => {
  let allowed = true, writes = 0
  const client = { session: { instructions: { entry: { put: async () => { writes++ }, remove: async () => { writes++ } } } } } as unknown as OpenCodeClient
  const guard = { prepare: async () => {}, current: (): true => { if (!allowed) throw new Error("retired native proof"); return true } }
  assert.equal(missionInstructionClient(client), client)
  const protectedClient = missionInstructionClient(client, guard)
  await protectedClient.session.instructions.entry.remove({ sessionID: "ses_fixture", key: "codenomad.git-availability" })
  assert.equal(writes, 1)
  await Promise.resolve(); allowed = false
  assert.throws(() => protectedClient.session.instructions.entry.remove({ sessionID: "ses_fixture", key: "codenomad.git-availability" }), /policy-unqualified/)
  assert.equal(writes, 1)
  await assert.rejects(prepareMissionAuthority({ prepare: async () => {}, current: (() => Promise.resolve(true)) as never }), /policy-unqualified/)
})
