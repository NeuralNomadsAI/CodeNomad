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
        return {}
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
