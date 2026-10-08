import assert from "node:assert/strict"
import test from "node:test"
import { redactSecrets } from "../http-server"
import { assertRecurrenceProofFresh } from "../../missions/recurrence-control-proof"

test("all recurrence proof envelopes redact cookies and selected YAML while normal native session IDs remain", () => {
  const proof = { sessionID: "reusable-real-cookie", scheduleID: "daily_review", digest: "digest",
    profileSource: { configYamlPath: "C:/private/custom.yaml" }, issuedAt: 1000 }
  for (const payload of [proof, { mode: "recurrence-control-verify", sessionID: proof.sessionID, command: proof },
    { input: proof }, { body: { mode: "recurrence-control-verify", command: proof } }]) {
    const output = JSON.stringify(redactSecrets(payload))
    assert(!output.includes(proof.sessionID))
    assert(!output.includes(proof.profileSource.configYamlPath))
  }
  assert.deepEqual(redactSecrets({ sessionID: "ses_native", messageID: "msg_native" }),
    { sessionID: "ses_native", messageID: "msg_native" })
  assert.doesNotThrow(() => assertRecurrenceProofFresh(1000, 30_999))
  assert.throws(() => assertRecurrenceProofFresh(1000, 31_000), /expired/)
})
