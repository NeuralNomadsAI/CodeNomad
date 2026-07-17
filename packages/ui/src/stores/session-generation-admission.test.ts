import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import type { Session } from "../types/session.ts"
import { beginSessionGenerationAdmission, getSessions, setSessions, setSessionStatus } from "./session-state.ts"
const instanceId = "generation-admission-instance"
const sessionId = "generation-admission-session"
const seedSession = () => setSessions(new Map([[instanceId, new Map([[sessionId, {
  id: sessionId, instanceId, parentId: null, title: "Session", agent: "build",
  model: { providerId: "provider", modelId: "model" }, version: "1", time: { created: 1, updated: 1 },
  status: "idle", idleSince: 10, runtimeStatusKnown: true, generationRecovery: "interrupted",
} as Session]])]]))
const result = () => {
  const { status, runtimeStatusKnown, generationRecovery, generationAdmissionToken: token } = getSessions(instanceId)[0]
  return { status, runtimeStatusKnown, generationRecovery, token }
}
afterEach(() => setSessions(new Map()))
describe("session generation admission", () => {
  const admit = () => beginSessionGenerationAdmission(instanceId, sessionId)
  const cases = [
    ["newer authoritative working status supersedes completion", () => { const admission = admit(); setSessionStatus(instanceId, sessionId, "working"); admission.complete() }, { status: "working", runtimeStatusKnown: true, generationRecovery: null, token: undefined }],
    ["idle authority waits for admission acknowledgement", () => {
      const admission = admit(); setSessionStatus(instanceId, sessionId, "idle")
      assert.deepEqual(result(), { status: "idle", runtimeStatusKnown: false, generationRecovery: "pending", token: result().token })
      assert.equal(typeof result().token, "number")
      admission.complete()
    }, { status: "idle", runtimeStatusKnown: false, generationRecovery: "pending", token: undefined }],
    ["rollback restores interrupted state without newer authority", () => admit().rollback(), { status: "idle", runtimeStatusKnown: true, generationRecovery: "interrupted", token: undefined }],
    ["one successful overlapping admission retains pending recovery", () => { const first = admit(); const second = admit(); first.complete(); second.rollback() }, { status: "idle", runtimeStatusKnown: false, generationRecovery: "pending", token: undefined }],
  ] as const
  for (const [label, run, expected] of cases) {
    it(label, () => {
      seedSession()
      run()
      assert.deepEqual(result(), expected)
      if (expected.generationRecovery === "interrupted") assert.equal(getSessions(instanceId)[0].idleSince, 10)
    })
  }
})
