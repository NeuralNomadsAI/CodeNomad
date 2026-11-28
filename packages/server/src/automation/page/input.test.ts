import assert from "node:assert/strict"
import { test } from "node:test"
import { clickAt, dragBetween, pressKeys } from "./input"
import type { PageSession } from "./protocol"
import { cdpSession } from "./cdp-driver"
import { performAction } from "./actions"
import { declaration } from "./functions"
import { PageDriverUnsupportedError, PageTargetChangedError } from "./protocol"

const click = { kind: "click", ref: "e1", backendNodeId: 1 } as const

function clickFixture(
  quads: unknown,
  activate: () => Record<string, unknown> = () => ({ result: { value: null } }),
  overlay = false,
  layout: unknown = { cssLayoutViewport: { clientWidth: 100, clientHeight: 100 } },
) {
  const inputs: string[] = [], hits: unknown[] = []
  const session = cdpSession({ send: async (method, params = {}) => {
    if (method === "DOM.getNodeForLocation") hits.push([params.x, params.y])
    if (method === "DOM.resolveNode") return { object: { objectId: String(params.backendNodeId) } }
    if (method === "DOM.getContentQuads") {
      if (quads instanceof Error) throw quads
      return { quads }
    }
    if (method === "Page.getLayoutMetrics") {
      if (layout instanceof Error) throw layout
      return layout as Record<string, unknown>
    }
    if (method === "DOM.getNodeForLocation") return { backendNodeId: overlay ? 2 : 1 }
    if (method === "Runtime.callFunctionOn") {
      if (params.functionDeclaration === declaration("programmatic-click", true)) {
        inputs.push("programmatic-click")
        return activate()
      }
      if (params.functionDeclaration === declaration("receives", true)) return { result: { value: 'div "Overlay"' } }
      if (params.functionDeclaration === declaration("option-click", true)) return { result: { value: null } }
    }
    if (method.startsWith("Input.")) inputs.push(String(params.type))
    return { result: { value: 1_700_000_000 } }
  } }, async () => {}, true)
  return { session, inputs, hits }
}

test("the hit test looks where the scrolled document shows the aimed point", async () => {
  const { session, inputs, hits } = clickFixture([[10, 10, 30, 10, 30, 30, 10, 30]], undefined, false,
    { cssLayoutViewport: { clientWidth: 100, clientHeight: 100, pageX: 5, pageY: 2900 } })
  await performAction(session, click)
  assert.deepEqual(hits, [[25, 2920]])
  assert.deepEqual(inputs, ["mouseMoved", "mousePressed", "mouseReleased"])
})

test("a failed geometry read never falls back to programmatic or native input", async () => {
  for (const failure of [
    new Error("CDP command DOM.getContentQuads timed out"),
    new Error("Could not compute content quads."),
    new PageDriverUnsupportedError("cdp", "geometry"),
  ]) {
    const { session, inputs } = clickFixture(failure)
    await assert.rejects(performAction(session, click), error => error === failure)
    assert.deepEqual(inputs, [])
  }
})

test("invalid geometry, invalid layout, and a clipped box never authorize a click", async () => {
  const quad = [10, 10, 30, 10, 30, 30, 10, 30]
  for (const fixture of [
    clickFixture(undefined), clickFixture([null]), clickFixture([[0, 0]]),
    clickFixture([[...quad.slice(0, 7), "30"]]), clickFixture([[...quad.slice(0, 7), Infinity]]),
    clickFixture([[110, 110, 130, 110, 130, 130, 110, 130]]),
    ...[{}, { cssLayoutViewport: { clientWidth: 100 } }, { cssLayoutViewport: { clientWidth: -1, clientHeight: 100 } },
      new Error("CDP command Page.getLayoutMetrics timed out")].map(layout => clickFixture([quad], undefined, false, layout)),
  ]) {
    await assert.rejects(performAction(fixture.session, click), /invalid|no visible box|timed out/i)
    assert.deepEqual(fixture.inputs, [])
  }
  const missingLayout = clickFixture([], undefined, false, {})
  await assert.rejects(performAction(missingLayout.session, { kind: "scroll", delta: { x: 0, y: 1 } }), /invalid/i)
  assert.deepEqual(missingLayout.inputs, [])
})

test("only the confirmed boxless target uses a programmatic click, not a covered target", async () => {
  const boxless = clickFixture([])
  await assert.rejects(performAction(boxless.session, { ...click, button: "right" }), /no visible box to right-click/)
  assert.deepEqual(boxless.inputs, [])
  await performAction(boxless.session, click)
  assert.deepEqual(boxless.inputs, ["programmatic-click"])

  const quads = [[10, 10, 30, 10, 30, 30, 10, 30]]
  const visible = clickFixture(quads)
  await performAction(visible.session, click)
  assert.deepEqual(visible.inputs, ["mouseMoved", "mousePressed", "mouseReleased"])

  const covered = clickFixture(quads, undefined, true)
  await assert.rejects(performAction(covered.session, click), /covered by div "Overlay"/)
  assert.deepEqual(covered.inputs, [])
})

test("a programmatic click with a lost reply reports an unknown outcome without replay", async () => {
  for (const message of [
    "CDP command Runtime.callFunctionOn timed out", "CDP WebSocket closed", "Developer CDP controller closed",
    "Native request timed out: browser.page.send",
  ]) {
    let clicks = 0, lateClick: (() => void) | undefined
    const { session, inputs } = clickFixture([], () => {
      lateClick = () => { clicks++ }
      throw new Error(message)
    })
    await assert.rejects(performAction(session, click), /outcome is unknown.*inspect before retrying/i)
    assert.equal(clicks, 0)
    lateClick?.()
    assert.equal(clicks, 1)
    assert.deepEqual(inputs, ["programmatic-click"])
  }
})

test("explicit programmatic click refusals are not reported as unknown outcomes", async () => {
  for (const failure of [
    new Error("Could not find object with given id"),
    new PageTargetChangedError("The input destination check timed out; inspect again", true),
    new PageDriverUnsupportedError("cdp", "programmatic-click"),
  ]) {
    const { session } = clickFixture([], () => { throw failure })
    await assert.rejects(performAction(session, click), error => error === failure)
  }
  const { session } = clickFixture([], () => ({ exceptionDetails: { exception: { description: "Error: codenomad:gone" } } }))
  await assert.rejects(performAction(session, click), { message: "e1 is no longer in the page; inspect again" })
})

test("failed pointer and key sequences release potentially held inputs without replaying the action", async () => {
  for (const kind of ["click", "drag", "keys"] as const) {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    let pressed = false, failed = false
    const session: PageSession = cdpSession({ send: async (method, params = {}) => {
        calls.push({ method, params })
        if (params.type === "mousePressed" || params.type === "rawKeyDown") pressed = true
        return method === "Runtime.evaluate" ? { result: { value: 1_700_000_000 } } : {}
      } }, async () => { if (pressed && !failed) { failed = true; throw new Error("Page changed") } }, true)
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
    const session: PageSession = cdpSession({ send: async (method, params = {}) => {
        calls.push({ method, params })
        if (method === "Runtime.evaluate" && frozen) throw new Error("CDP mark timed out")
        if (params.type === "mousePressed") { frozen = true; throw new Error("CDP input timed out") }
        if (params.type === "mouseReleased") {
          if (recoversBeforeRelease) clicks++
          else { queuedRelease = () => { clicks++ }; throw new Error("CDP release timed out") }
        }
        return method === "Runtime.evaluate" ? { result: { value: 1_700_000_000 } } : {}
      } }, async () => {}, true)
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

test("a release with an unknown outcome is never sent twice", async () => {
  for (const kind of ["mouseReleased", "keyUp"]) {
    const calls: string[] = []
    const session = cdpSession({ send: async (method, params = {}) => {
      if (method === "Runtime.evaluate") return { result: { value: 1_700_000_000 } }
      calls.push(String(params.type))
      if (params.type === kind) throw new Error("CDP release timed out")
      return {}
    } }, async () => {}, true)
    await assert.rejects(kind === "mouseReleased" ? clickAt(session, { x: 10, y: 20 }) : pressKeys(session, "Enter"),
      /outcome is unknown/)
    assert.equal(calls.filter(type => type === kind).length, 1)
  }
})

test("type reports a sent input when current field value cannot be read", async () => {
  let sent = 0
  const session = cdpSession({ send: async (method) => {
    if (method === "DOM.resolveNode") return { object: { objectId: "field" } }
    if (method === "Input.insertText") sent++
    return {}
  } }, async () => {}, true)
  session.driver.call = async (id) => {
    if (id === "field") return { handle: "field" }
    if (id === "prepare") return { value: "insert" }
    if (id === "mark-input") return { value: 1_700_000_000 }
    if (id === "read-value") throw new Error("Page changed")
    return {}
  }
  await assert.rejects(performAction(session, { kind: "type", ref: "e1", backendNodeId: 1, text: "append", clear: false }),
    /Text input was sent.*inspect before retrying/)
  assert.equal(sent, 1)
})

test("script mutations distinguish a lost execution reply from a lost final check", async () => {
  for (const action of ["select", "option-click", "set-value", "delete-selection"] as const) {
    for (const failAt of ["reply", "malformed", "checkpoint"] as const) {
      let sent = 0
      const { session } = clickFixture([])
      const call = session.driver.call
      session.driver.call = async (id, handle, args) => {
        if (id === action) {
          sent++
          if (failAt === "reply") throw new Error("CDP command Runtime.callFunctionOn timed out")
          if (failAt === "malformed") return { value: false }
          return { value: id === "select" || id === "option-click" ? ["A"] : null }
        }
        if (id === "field") return { handle: "field" }
        if (id === "prepare") return { value: action === "set-value" ? "append" : "insert" }
        return call(id, handle, args)
      }
      session.checkpoint = async () => { if (sent) throw new Error("Page changed") }
      const result = performAction(session, action === "select" ? { ...click, kind: "select", values: ["A"] }
        : action === "option-click" ? click : { ...click, kind: "type", text: "", clear: true })
      await assert.rejects(result, failAt !== "checkpoint" ? /outcome is unknown.*inspect before retrying/i
        : /was sent.*could not be confirmed.*inspect before retrying/i)
      assert.equal(sent, 1)
    }
  }
})

test("trusted input waits until a freshly navigated page accepts it, within a bounded delay", async () => {
  for (const delays of [[40, 40, 0], [5_000]]) {
    const calls: string[] = []
    const answers = [...delays]
    const started = Date.now()
    await pressKeys(cdpSession({ send: async (method, params = {}) => {
      calls.push(method === "Runtime.evaluate" ? "ready?" : `${method}:${params.type}`)
      return method === "Runtime.evaluate" ? { result: { value: { inputDelayMs: answers.length > 1 ? answers.shift() : answers[0] } } } : {}
    } }, async () => {}, false), "a")
    const elapsed = Date.now() - started
    const firstKey = calls.indexOf("Input.dispatchKeyEvent:keyDown")
    assert.ok(firstKey > 0 && calls.slice(0, firstKey).every(call => call === "ready?"), "no key precedes acceptance")
    if (delays.length > 1) {
      assert.equal(firstKey, 3, "polls until the page reports it accepts input")
      assert.ok(elapsed >= 70 && elapsed < 900, `waited ${elapsed} ms`)
    } else {
      assert.ok(elapsed >= 950 && elapsed < 2_000, `a page that never reports readiness delays input by at most a second, waited ${elapsed} ms`)
    }
    assert.deepEqual(calls.slice(firstKey), ["Input.dispatchKeyEvent:keyDown", "Input.dispatchKeyEvent:keyUp"])
  }
})

test("input refuses when the page cannot supply a valid provenance timestamp", async () => {
  const methods: string[] = []
  await assert.rejects(pressKeys(cdpSession({ send: async method => { methods.push(method); return { result: { value: null } } } },
    async () => {}, true), "Enter"), /Cannot establish automation input provenance/)
  assert.ok(methods.every(method => method === "Runtime.evaluate"))
})
