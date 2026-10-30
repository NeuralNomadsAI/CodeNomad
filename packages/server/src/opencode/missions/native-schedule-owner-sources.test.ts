import assert from "node:assert/strict"
import test from "node:test"
import { ownerFixture } from "./native-schedule-owner-test-fixture"
import { missionSourceKey } from "../../missions/mission-document"

test("owner baselines at first Play under exclusion, rechecks source guard before CAS, and Resume retains consumed proof", async t => {
  let value = "old", revoked = false, reads = 0, revalidations = 0
  const f = await ownerFixture(t, undefined, undefined, async (doc, locked) => {
    locked.assertActive(); reads++
    const condition = doc.configuration.launch.condition!
    return { checkpoints: [{ key: missionSourceKey(condition), kind: condition.kind, placementDigest: "a".repeat(64), value: { digest: value } }],
      current: () => { if (revoked) throw new Error("source changed"); return true },
      revalidate: async () => { locked.assertActive(); revalidations++; if (value === "changed before publication") throw new Error("source changed") } }
  })
  const configured = await f.control("configure", "condition", { ...f.configuration,
    launch: { ...f.configuration.launch, condition: { kind: "files-changed", paths: ["explicit"] } } })
  value = "at first Play"; revoked = true
  await assert.rejects(f.control("play", "play_refused"), /source changed|policy-unqualified/)
  assert.equal((await f.read()).revision, configured.revision); assert.equal(f.calls.length, 0)
  revoked = false
  const played = await f.control("play", "play_original")
  assert.equal(revalidations, 2, "configure and first Play both revalidate before publication")
  assert.deepEqual(played.checkpoints[0].value, { digest: value })
  await f.control("pause")
  const count = reads
  value = "while paused"
  const resumed = await f.control("resume")
  assert.equal(reads, count); assert.deepEqual(resumed.checkpoints, played.checkpoints)
})
