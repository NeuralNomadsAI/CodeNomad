import assert from "node:assert/strict"
import { test } from "node:test"
import { clickAt, dragBetween, pressKeys } from "./input"
import type { PageSession } from "./protocol"

test("failed pointer and key sequences release potentially held inputs without replaying the action", async () => {
  for (const kind of ["click", "drag", "keys"] as const) {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    let pressed = false, failed = false
    const session: PageSession = {
      markAutomation: true,
      channel: { send: async (method, params = {}) => {
        calls.push({ method, params })
        if (params.type === "mousePressed" || params.type === "rawKeyDown") pressed = true
        return method === "Runtime.evaluate" ? { result: { value: 1_700_000_000 } } : {}
      } },
      checkpoint: async () => { if (pressed && !failed) { failed = true; throw new Error("Page changed") } },
    }
    await assert.rejects(kind === "click" ? clickAt(session, { x: 10, y: 20 })
      : kind === "drag" ? dragBetween(session, { x: 10, y: 20 }, { x: 50, y: 60 }) : pressKeys(session, "Control+K"), /Page changed/)
    const inputs = calls.filter(call => call.method.startsWith("Input."))
    assert.equal(inputs.filter(call => call.params.type === "mousePressed" || call.params.type === "rawKeyDown").length, 1,
      "the action is admitted only once")
    assert.equal(inputs.at(-1)?.params.type, kind === "keys" ? "keyUp" : "mouseReleased")
    assert.equal(inputs.at(-1)?.params[kind === "keys" ? "key" : "button"], kind === "keys" ? "Control" : "left")
    assert.match(String(calls.at(-1)?.params.expression), /Math.min/, "the retained input interval ends only after release")
  }
})

test("a frozen mark write cannot suppress release, and late input effects are reported as unknown", async () => {
  for (const recoversBeforeRelease of [true, false]) {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    let frozen = false, clicks = 0, queuedRelease: (() => void) | undefined
    const session: PageSession = {
      markAutomation: true,
      checkpoint: async () => {},
      channel: { send: async (method, params = {}) => {
        calls.push({ method, params })
        if (method === "Runtime.evaluate" && frozen) throw new Error("CDP mark timed out")
        if (params.type === "mousePressed") { frozen = true; throw new Error("CDP input timed out") }
        if (params.type === "mouseReleased") {
          if (recoversBeforeRelease) clicks++
          else { queuedRelease = () => { clicks++ }; throw new Error("CDP release timed out") }
        }
        return method === "Runtime.evaluate" ? { result: { value: 1_700_000_000 } } : {}
      } },
    }
    await assert.rejects(clickAt(session, { x: 10, y: 20 }), /outcome is unknown.*may still be delivered; inspect before retrying/)
    assert.equal(calls.filter(call => call.params.type === "mousePressed").length, 1)
    assert.equal(calls.filter(call => call.params.type === "mouseReleased").length, 1,
      "release is attempted even if its mark write times out")
    assert.equal(calls.find(call => call.params.type === "mouseReleased")?.params.timestamp,
      calls.find(call => call.params.type === "mousePressed")?.params.timestamp, "late release retains the original press timestamp")
    queuedRelease?.()
    assert.equal(clicks, 1, "cleanup can complete the admitted click after a timeout, but never replays its press")
  }
})

test("input refuses when the page cannot supply a valid provenance timestamp", async () => {
  const methods: string[] = []
  await assert.rejects(pressKeys({ markAutomation: true, checkpoint: async () => {},
    channel: { send: async method => { methods.push(method); return { result: { value: null } } } },
  }, "Enter"), /Cannot establish automation input provenance/)
  assert.ok(methods.every(method => method === "Runtime.evaluate"))
})
