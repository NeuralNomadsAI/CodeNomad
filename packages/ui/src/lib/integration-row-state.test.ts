import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { IntegrationView } from "../../../server/src/integration-types"
import { integrationAttention, integrationConnection, integrationConnectionMessage, integrationLink, integrationSummary } from "./integration-row-state"

type Entry = Pick<IntegrationView, "family" | "state" | "status">
const native = (host: NonNullable<NonNullable<Entry["status"]>["host"]>["state"] = "ok", offers = 1, extra: Partial<Entry> = {}): Entry =>
  ({ family: "native", state: "ok", status: { version: "0.4.1", host: { state: host }, connection: { offers } }, ...extra })

describe("integration Plugins row state", () => {
  it("links a loaded native integration through its per-conversation read only", () => {
    assert.deepEqual(integrationLink(native(), { state: "attached", label: "western_ia.blend" }), { state: "attached", label: "western_ia.blend" })
    assert.deepEqual(integrationLink(native(), { state: "none" }), { state: "none" })
    assert.deepEqual(integrationLink(native(), { state: "unknown" }), { state: "unknown" }, "an integration that cannot tell stays unknown")
    assert.deepEqual(integrationLink(native(), undefined), { state: "none" }, "no displayed conversation: none attached")
  })

  it("has no link for other families, unloaded integrations or an unsupported host", () => {
    assert.equal(integrationLink({ family: "vendor-mcp", state: "ok", status: { version: "1.0.0" } }, { state: "none" }), undefined)
    for (const state of ["absent", "inactive", "failed", "unknown", "unsupported", "non-conforming"] as const) {
      assert.equal(integrationLink(native("ok", 1, { state, status: undefined }), { state: "attached", label: "x" }), undefined, state)
    }
    assert.equal(integrationLink(native("unsupported"), { state: "none" }), undefined)
  })

  it("asks for attention only for a missing, outdated or incompatible application part", () => {
    assert.equal(integrationAttention(native("absent")), "hostAbsent")
    assert.equal(integrationAttention(native("outdated")), "hostOutdated")
    assert.equal(integrationAttention(native("incompatible")), "incompatible")
    for (const host of ["ok", "unknown", "unsupported"] as const) assert.equal(integrationAttention(native(host)), undefined, host)
    assert.equal(integrationAttention(native("absent", 0, { state: "inactive" })), undefined, "only a fresh status answer counts")
    assert.equal(integrationAttention({ family: "api", state: "ok", status: { version: "1.0.0" } }), undefined)
  })

  it("describes the connection of every family", () => {
    assert.deepEqual(integrationConnection(native("ok", 2)), { state: "offers", count: 2 })
    assert.deepEqual(integrationConnection(native("ok", 0)), { state: "noOffer" })
    assert.deepEqual(integrationConnection(native("unknown", 0)), { state: "hostClosed" })
    assert.deepEqual(integrationConnection(native("unsupported", 1)), { state: "unsupported" })
    assert.deepEqual(integrationConnection(native("ok", 1, { state: "inactive", status: undefined })), { state: "unknown" })
    assert.deepEqual(integrationConnection({ family: "vendor-mcp", state: "ok", status: { version: "1", connection: { state: "connected" } } }), { state: "detected" })
    assert.deepEqual(integrationConnection({ family: "vendor-mcp", state: "ok", status: { version: "1" } }), { state: "absent" })
    assert.deepEqual(integrationConnection({ family: "api", state: "ok", status: { version: "1", connection: { state: "connected" } } }), { state: "connected" })
    assert.deepEqual(integrationConnection({ family: "api", state: "ok", status: { version: "1", connection: { state: "signed_out" } } }), { state: "disconnected" })
  })

  it("chooses the plural form of the offer count", () => {
    assert.deepEqual(integrationConnectionMessage({ state: "offers", count: 1 }, "Blender"), ["integrations.connection.offers.one", { app: "Blender", count: 1 }])
    assert.deepEqual(integrationConnectionMessage({ state: "offers", count: 3 }, "Blender"), ["integrations.connection.offers.other", { app: "Blender", count: 3 }])
    assert.deepEqual(integrationConnectionMessage({ state: "hostClosed" }, "Blender"), ["integrations.connection.hostClosed", { app: "Blender" }])
  })

  it("reads the catalogue summary in the current language, else English", () => {
    const entry = { summary: { en: "Use Blender.", fr: "Utiliser Blender." } }
    assert.equal(integrationSummary(entry, "fr"), "Utiliser Blender.")
    assert.equal(integrationSummary(entry, "fr-CA"), "Utiliser Blender.")
    assert.equal(integrationSummary(entry, "ja"), "Use Blender.")
  })
})
