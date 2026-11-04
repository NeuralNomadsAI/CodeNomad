import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { deriveIntegrationSectionState, integrationAutoExpandKey, type IntegrationSectionInput } from "./integration-section-state"

type Entry = IntegrationSectionInput["entry"]
const native = (status: NonNullable<Entry["status"]> = { version: "0.1.0", host: { state: "ok" }, connection: { offers: 0 } }, extra: Partial<Entry> = {}): Entry =>
  ({ id: "blender", family: "native", state: "ok", status, ...extra })
const input = (entry: Entry, extra: Partial<Omit<IntegrationSectionInput, "conversation">> = {},
  conversation: Partial<IntegrationSectionInput["conversation"]> = {}): IntegrationSectionInput => ({
  entry, disabled: false, ...extra,
  conversation: { present: true, binding: { state: "none" }, uncertain: false, ...conversation },
})
const derive = (value: IntegrationSectionInput) => deriveIntegrationSectionState(value)
const labelOf = (value: IntegrationSectionInput) => derive(value).label

describe("integration section state (spec change §5.2)", () => {
  it("installing while the install hint is pending", () => {
    assert.equal(labelOf(input(native(undefined, { state: "inactive", status: undefined }), { installation: "pending" })), "installing")
  })

  it("install not confirmed once the pending window closed, or while declared and not loaded", () => {
    assert.equal(labelOf(input({ id: "blender", family: "native", state: "inactive" }, { installation: "unconfirmed" })), "unconfirmed")
    assert.equal(labelOf(input({ id: "blender", family: "native", state: "inactive" })), "unconfirmed")
  })

  it("failed when the runtime failed to load it", () => {
    assert.equal(labelOf(input({ id: "blender", family: "native", state: "failed" }, { installation: "failed" })), "failed")
  })

  it("disabled under an effective -id rule, before install hints", () => {
    assert.equal(labelOf(input({ id: "blender", family: "native", state: "inactive" }, { disabled: true, installation: "unconfirmed" })), "disabled")
  })

  it("non-conforming on a marker mismatch", () => {
    assert.equal(labelOf(input({ id: "blender", family: "native", state: "non-conforming" })), "nonConforming")
  })

  it("unsupported on a missing status method or an unsupported (WSL) host", () => {
    assert.equal(labelOf(input({ id: "blender", family: "native", state: "unsupported" })), "unsupported")
    const wsl = derive(input(native({ version: "0.1.0", host: { state: "unsupported" }, connection: { offers: 1 } })))
    assert.equal(wsl.label, "unsupported")
    assert.deepEqual(wsl.conversation, { state: "unsupported" })
  })

  it("application absent, closed, outdated and incompatible from the host state", () => {
    const host = (state: "absent" | "unknown" | "outdated" | "incompatible", action?: "install" | "update") =>
      derive(input(native({ version: "0.1.0", host: { state, ...(action ? { action } : {}) }, connection: { offers: 0 } })))
    assert.equal(host("absent", "install").label, "hostAbsent")
    assert.deepEqual(host("absent", "install").application, { state: "absent", action: "install" })
    assert.equal(host("unknown").label, "hostClosed")
    assert.equal(host("outdated", "update").label, "hostOutdated")
    assert.equal(host("incompatible").label, "incompatible")
  })

  it("legacy install from its notice", () => {
    assert.equal(labelOf(input(native({ version: "0.1.0", host: { state: "ok" }, notices: ["legacy_install"] }))), "legacy")
  })

  it("ready without offers, application available with offers, attached from the authoritative read", () => {
    assert.equal(labelOf(input(native())), "ready")
    assert.equal(labelOf(input(native({ version: "0.1.0", host: { state: "ok" }, connection: { offers: 2 } }))), "available")
    assert.equal(labelOf(input(native({ version: "0.1.0", host: { state: "ok" }, connection: { offers: 1 } }), {},
      { binding: { state: "attached", label: "scene.blend" } })), "attached")
  })

  it("uncertain after a submitted action until it is read again, over every other state", () => {
    const state = derive(input(native({ version: "0.1.0", host: { state: "ok" }, connection: { offers: 1 } }), {},
      { binding: { state: "attached", label: "scene.blend" }, uncertain: true }))
    assert.equal(state.label, "uncertain")
    assert.deepEqual(state.conversation, { state: "uncertain" })
  })

  it("update available is cumulative with the label", () => {
    const state = derive(input(native(undefined, { outdated: true })))
    assert.equal(state.label, "ready")
    assert.equal(state.updateAvailable, true)
  })

  it("an unknown status read stays unverifiable", () => {
    assert.equal(labelOf(input({ id: "blender", family: "native", state: "unknown" })), "unknown")
  })

  it("expects an action, and expands, only for the §5.1 states or an attached conversation", () => {
    const expected = ["hostAbsent", "hostOutdated", "incompatible", "unconfirmed", "failed"]
    const states = [
      derive(input(native({ version: "0.1.0", host: { state: "absent" } }))),
      derive(input(native({ version: "0.1.0", host: { state: "outdated" } }))),
      derive(input(native({ version: "0.1.0", host: { state: "incompatible" } }))),
      derive(input({ id: "blender", family: "native", state: "inactive" })),
      derive(input({ id: "blender", family: "native", state: "failed" })),
    ]
    assert.deepEqual(states.map(state => state.label), expected)
    assert.ok(states.every(state => state.expectsAction && integrationAutoExpandKey(state) === state.label))
    const attached = derive(input(native({ version: "0.1.0", host: { state: "ok" }, connection: { offers: 1 } }), {}, { binding: { state: "attached", label: "a" } }))
    assert.equal(integrationAutoExpandKey(attached), "attached")
    const closedAttached = derive(input(native({ version: "0.1.0", host: { state: "unknown" } }), {}, { binding: { state: "attached", label: "a" } }))
    assert.equal(closedAttached.label, "hostClosed")
    assert.equal(integrationAutoExpandKey(closedAttached), "attached", "the authoritative displayed binding expands even with a different header state")
    for (const quiet of [derive(input(native())), derive(input({ id: "blender", family: "native", state: "inactive" }, { disabled: true }))]) {
      assert.equal(quiet.expectsAction, false)
      assert.equal(integrationAutoExpandKey(quiet), undefined)
    }
  })
})

describe("integration Conversation line (spec change §5.1)", () => {
  const offers = (count: number) => native({ version: "0.1.0", host: { state: "ok" }, connection: { offers: count } })
  const row = (entry: Entry, conversation: Partial<IntegrationSectionInput["conversation"]>) => derive(input(entry, {}, conversation)).conversation

  it("no displayed conversation", () => {
    assert.deepEqual(row(offers(1), { present: false, binding: { state: "unknown" } }), { state: "noConversation" })
  })

  it("no offer, an available offer and a reattach hint", () => {
    assert.deepEqual(row(offers(0), {}), { state: "noOffer" })
    assert.deepEqual(row(offers(1), {}), { state: "available" })
    assert.deepEqual(row(offers(1), { hint: "scene.blend" }), { state: "reattach", label: "scene.blend" })
  })

  it("attached only from the authoritative binding; a hint without a live binding never attaches", () => {
    assert.deepEqual(row(offers(1), { binding: { state: "attached", label: "scene.blend" } }), { state: "attached", label: "scene.blend" })
    assert.deepEqual(row(offers(0), { binding: { state: "attached", label: "scene.blend" } }), { state: "attached", label: "scene.blend" })
    assert.deepEqual(row(offers(1), { hint: "scene.blend", binding: { state: "none" } }), { state: "reattach", label: "scene.blend" })
  })

  it("an unknown binding is never reported as no open application", () => {
    assert.deepEqual(row(offers(0), { binding: { state: "unknown" } }), { state: "unknown" })
    assert.deepEqual(row(offers(1), { binding: { state: "unknown" }, hint: "scene.blend" }), { state: "unknown" })
  })

  it("uncertain after a lost response, and unsupported under WSL", () => {
    assert.deepEqual(row(offers(1), { uncertain: true, binding: { state: "none" } }), { state: "uncertain" })
    assert.deepEqual(row(native({ version: "0.1.0", host: { state: "unsupported" }, connection: { offers: 1 } }), { present: false }), { state: "unsupported" })
  })

  it("only native integrations in the ok state have a Conversation and Application line", () => {
    assert.equal(row({ id: "blender", family: "native", state: "failed" }, {}), undefined)
    const resolve = derive(input({ id: "resolve", family: "vendor-mcp", state: "ok", status: { version: "1.0.0", connection: { state: "connected" } } }))
    assert.equal(resolve.conversation, undefined)
    assert.equal(resolve.application, undefined)
    assert.equal(resolve.connection, "detected")
    assert.equal(derive(input({ id: "resolve", family: "vendor-mcp", state: "ok", status: { version: "1.0.0", connection: { state: "none" } } })).connection, "absent")
    assert.equal(derive(input({ id: "m365", family: "api", state: "ok", status: { version: "1.0.0", connection: { state: "connected" } } })).connection, "connected")
    assert.equal(derive(input({ id: "m365", family: "api", state: "ok", status: { version: "1.0.0", connection: { state: "signed_out" } } })).connection, "disconnected")
  })
})
