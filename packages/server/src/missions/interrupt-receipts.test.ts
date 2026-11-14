import assert from "node:assert/strict"
import test from "node:test"
import { contentText } from "./inspect-view"
import { InterruptReceipts } from "./interrupt-receipts"

const receipt = (mark: string, length = 1_000) => ({ complete: false, sessions: [{ sessionID: `ses_${mark}`.padEnd(length, "x") }] })
const bytes = (value: unknown) => 2 * contentText(value).length

test("held receipts plateau at the byte budget, least recently held or read evicted first, with their slots", () => {
  const size = bytes(receipt("a")), cache = new InterruptReceipts(10 * size)
  const digests: string[] = []
  for (let index = 0; index < 40; index++) {
    digests.push(cache.hold(`owner-${index % 3}`, `slot-${index}`, receipt(`r${String(index).padStart(3, "0")}`)))
    assert.ok(cache.retainedBytes <= 10 * size, `${cache.retainedBytes} bytes after ${index + 1} receipts`)
  }
  assert.equal(cache.retainedBytes, 10 * size, "retained bytes plateau at the budget")
  const owner = (index: number) => `owner-${index % 3}`
  // The newest ten are held exactly; the older ones are gone.
  for (let index = 30; index < 40; index++) assert.deepEqual(cache.read(owner(index), digests[index]), receipt(`r${String(index).padStart(3, "0")}`))
  for (let index = 0; index < 30; index++) assert.equal(cache.read(owner(index), digests[index]), undefined)
  // A read refreshes recency: the receipt read last survives the next eviction.
  assert.ok(cache.read(owner(30), digests[30]))
  cache.hold("owner-new", "slot-new", receipt("new"))
  assert.ok(cache.read(owner(30), digests[30]), "recently read stays")
  assert.equal(cache.read(owner(31), digests[31]), undefined, "the least recently used went")
  // Another owner never reads it.
  assert.equal(cache.read("owner-other", digests[39]), undefined)
})

test("a slot's newest receipt replaces its previous one, a whole result retires it, and a body shared by slots stays while one names it", () => {
  const cache = new InterruptReceipts()
  const first = cache.hold("owner", "slot-a", receipt("first"))
  const second = cache.hold("owner", "slot-a", receipt("second"))
  assert.equal(cache.read("owner", first), undefined, "replaced")
  assert.deepEqual(cache.read("owner", second), receipt("second"))
  cache.retire("slot-a")
  assert.equal(cache.read("owner", second), undefined, "a whole newer result retires it")
  assert.equal(cache.retainedBytes, 0)
  const shared = cache.hold("owner", "slot-b", receipt("shared"))
  assert.equal(cache.hold("owner", "slot-c", receipt("shared")), shared)
  assert.equal(cache.retainedBytes, bytes(receipt("shared")), "one body for both slots")
  cache.retire("slot-b")
  assert.deepEqual(cache.read("owner", shared), receipt("shared"), "still named by slot-c")
  cache.retire("slot-c")
  assert.equal(cache.read("owner", shared), undefined)
  // A body larger than the whole budget is not held; clear releases everything.
  const small = new InterruptReceipts(100)
  assert.equal(small.read("owner", small.hold("owner", "slot", receipt("large"))), undefined)
  assert.equal(small.retainedBytes, 0)
  cache.hold("owner", "slot-d", receipt("d"))
  cache.clear()
  assert.equal(cache.retainedBytes, 0)
})
