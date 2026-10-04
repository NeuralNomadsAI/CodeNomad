// Real authority.receipt wire probes. Never execute an intent to query evidence.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"

export async function probeReceiptRead({ rpc, protocol, intent, receipt, options, otherOptions, observe, negative = false }) {
  const query = { intent, digest: protocol.authorityDigest(intent) }
  const before = await observe()
  const first = await rpc.receipt(query, options())
  assert.equal(first.namespace, intent.namespace)
  assert.equal(first.projectID, intent.projectID)
  assert.equal(first.projectCanonical, intent.projectCanonical)
  assert.deepEqual(first.receipt, receipt)
  // Wire objects can be mutable, but must not alias the durable native record.
  first.receipt.intent.roots[0].directory = "private-client-only-mutation"
  if (first.receipt.completion) first.receipt.completion.outcome = "rejected"
  assert.deepEqual((await rpc.receipt(query, options())).receipt, receipt)
  if (negative) {
    const absent = { ...intent, requestID: `absent-${randomUUID()}` }
    assert.equal((await rpc.receipt({ intent: absent, digest: protocol.authorityDigest(absent) }, options())).receipt, null)
    await assert.rejects(rpc.receipt({ ...query, execute: true }, options()))
    await assert.rejects(rpc.receipt({ ...query, digest: "0".repeat(64) }, options()))
    for (const change of [{ namespace: randomUUID() }, { profileID: "foreign-private-profile" },
      { epoch: intent.epoch + 1 }, { payload: { ...intent.payload, objective: "Altered signed input" } }]) {
      const altered = { ...intent, ...change }
      await assert.rejects(rpc.receipt({ intent: altered, digest: protocol.authorityDigest(altered) }, options()))
    }
    await assert.rejects(rpc.receipt(query, otherOptions))
  }
  assert.deepEqual(await observe(), before, "Receipt reads must not write, prompt, settle reservations or change the map")
  return { requestID: receipt.requestID, digest: receipt.digest, completion: receipt.completion?.outcome ?? "pending" }
}
