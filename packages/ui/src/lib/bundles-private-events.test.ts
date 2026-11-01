import assert from "node:assert/strict"
import { test } from "node:test"
import { bundlesPrivateEvents } from "./bundles-private-events"

test("private stream ownership expires on reset; stale streams cannot replace/revoke the new owner or deliver events", async () => {
  const first = bundlesPrivateEvents.stream(), events: unknown[] = []
  first.onPrivateOwner({ owner: "a".repeat(64) })
  const owner = await bundlesPrivateEvents.capture(AbortSignal.timeout(1000))
  const release = bundlesPrivateEvents.subscribe("b".repeat(32), value => events.push(value))
  first.onPrivateEvent({ mountID: "b".repeat(32), change: { kind: "state" } })
  assert.equal(events.length, 1)
  first.onPrivateEvent({ mountID: "b".repeat(32), change: { kind: "state", token: "PRIVATE" } })
  assert.equal(events.length, 1)
  const second = bundlesPrivateEvents.stream()
  assert.equal(owner.signal.aborted, true)
  second.onPrivateOwner({ owner: "c".repeat(64) })
  const fresh = await bundlesPrivateEvents.capture(AbortSignal.timeout(1000))
  first.onPrivateOwner({ owner: "d".repeat(64) }); first.onReset()
  first.onPrivateEvent({ mountID: "b".repeat(32), change: { kind: "state" } })
  assert.equal(fresh.signal.aborted, false)
  assert.equal((await bundlesPrivateEvents.capture(AbortSignal.timeout(1000))).value, "c".repeat(64))
  assert.equal(events.length, 1)
  release(); second.onReset()
  assert.equal(fresh.signal.aborted, true)
})

test("all private display fields enforce code-point bounds rather than UTF-16 length", () => {
  const stream = bundlesPrivateEvents.stream(), events: any[] = [], mountID = "b".repeat(32)
  stream.onPrivateOwner({ owner: "a".repeat(64) })
  const release = bundlesPrivateEvents.subscribe(mountID, event => events.push(event))
  const view = { requestID: "c".repeat(32), planID: "d".repeat(32), action: "attach", integration: "Fixture",
    scope: "global", version: "1.0.0", conversation: "Work", document: "Scene" }
  try {
    for (const [field, max] of [["integration", 120], ["version", 120], ["conversation", 256], ["document", 243]] as const) {
      const value = "😀".repeat(max), before = events.length
      stream.onPrivateEvent({ mountID, view: { ...view, [field]: value } })
      assert.equal(events.length, before + 1, `${field}: accepts ${max} code points`)
      assert.equal(events.at(-1).view[field], value)
      stream.onPrivateEvent({ mountID, view: { ...view, [field]: value + "😀" } })
      assert.equal(events.length, before + 1, `${field}: refuses ${max + 1} code points`)
    }
    const before = events.length
    stream.onPrivateEvent({ mountID, view: { ...view, integration: "" } })
    assert.equal(events.length, before, "integration remains nonempty")
    for (const document of ["😀".repeat(120) + " — Scene", "😀".repeat(120) + " — " + "🧩".repeat(120)]) {
      stream.onPrivateEvent({ mountID, view: { ...view, document } })
      assert.equal(events.at(-1).view.document, document)
    }
  } finally { release(); stream.onReset() }
})
