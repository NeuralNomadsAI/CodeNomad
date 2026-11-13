import assert from "node:assert/strict"
import { test } from "node:test"
import { waitNativePruningPlugin } from "./native-pruning-ready.mjs"

test("pruning discovery preserves Location/options, bounds absence and rejects failure/cancellation without RPC", async () => {
  const location = { directory: "/isolated/cold" }, locationOptions = { headers: { fixture: "owned" } }
  const active = { id: "codenomad-session-pruning", source: { type: "local" }, state: { status: "active" } }
  let plugins = [], reads = 0, rpc = 0
  const controller = new AbortController()
  const client = {
    plugin: { list: async (input, options) => {
      reads++
      assert.equal(input.location, location)
      assert.equal(options.headers, locationOptions.headers)
      assert.equal(options.signal, controller.signal)
      return { data: plugins }
    } },
    rpc: { call: () => { rpc++; throw new Error("Discovery must never call RPC") } },
  }
  const until = async predicate => {
    for (let n = 0; n < 3; n++) if (await predicate()) return
    throw new Error("Fixture deadline")
  }
  const ready = () => waitNativePruningPlugin({ client, location, locationOptions, signal: controller.signal, until })
  plugins = [{ ...active, id: "another-plugin" }]
  await assert.rejects(ready(), error => /cold/.test(error.message) && /Fixture deadline/.test(error.cause.message))
  assert.equal(reads, 3)
  plugins = [active]
  await ready()
  for (const state of [{ status: "failed", error: "activation canary" }, { status: "disabled" }]) {
    plugins = [{ ...active, state }]
    const before = reads
    await assert.rejects(ready(), error => error.message.includes(state.status))
    assert.equal(reads, before + 1)
  }
  controller.abort(new Error("Cancelled fixture"))
  const before = reads
  await assert.rejects(ready(), error => error.cause === controller.signal.reason)
  assert.equal(reads, before)
  assert.equal(rpc, 0)
})
