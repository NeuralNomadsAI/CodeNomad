import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { IntegrationView } from "../../../server/src/integration-types"
import {
  integrationAttachChoice,
  integrationConnection,
  integrationConnectionMessage,
  integrationLink,
  integrationStateLine,
  integrationSummary,
} from "./integration-row-state"

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

  it("shows one state line, the most important, with its action", () => {
    const app = { name: "Blender" }
    const doc = (offerID: string, document: string, protocol: "ok" | "incompatible" = "ok") => ({ offerID, label: `Blender: ${document}`, document, protocol })
    const line = (entry: Entry, extra: Partial<Parameters<typeof integrationStateLine>[0]> = {}) =>
      integrationStateLine({ entry: { ...entry, app }, conversation: true, canInstall: true, ...extra })
    // Native, by priority: the application part first, then attachment.
    assert.deepEqual(line(native("absent", 1), { link: { state: "attached", label: "x" } }),
      { key: "integrations.line.install", vars: { app: "Blender" }, tone: "action", action: "install" })
    assert.deepEqual(line(native("outdated")), { key: "integrations.line.update", vars: { app: "Blender" }, tone: "action", action: "update" })
    assert.deepEqual(line(native("absent"), { canInstall: false }), { key: "integrations.attention.hostAbsent", vars: { app: "Blender" }, tone: "info" },
      "without a fresh installable status the state only informs")
    assert.deepEqual(line(native("incompatible")), { key: "integrations.attention.incompatible", vars: { app: "Blender" }, tone: "warning" })
    assert.deepEqual(line(native("ok"), { link: { state: "attached", label: "Blender: western_ia.blend" }, offers: [doc("o1", "western_ia.blend")] }),
      { key: "integrations.line.attached", vars: { document: "western_ia.blend" }, tone: "action", action: "detach" })
    assert.deepEqual(line(native("ok"), { link: { state: "attached", label: "Blender: scene" } }).vars, { document: "Blender: scene" },
      "the binding's label until the documents are read")
    assert.deepEqual(line(native("unknown", 0)), { key: "integrations.connection.hostClosed", vars: { app: "Blender" }, tone: "info" })
    assert.deepEqual(line(native("ok", 0)), { key: "integrations.connection.noOffer", vars: { app: "Blender" }, tone: "info" })
    assert.deepEqual(line(native("ok"), { conversation: false }), { key: "integrations.link.noConversation", tone: "info" })
    assert.deepEqual(line(native("ok"), { link: { state: "none" }, offers: [doc("o1", "western_ia.blend"), doc("o2", "old.blend", "incompatible")] }),
      { key: "integrations.line.attachOne", vars: { document: "western_ia.blend" }, tone: "action", action: "attach", offerID: "o1" })
    assert.deepEqual(line(native("ok", 2), { offers: [doc("o1", "a.blend"), doc("o2", "b.blend")] }), { key: "integrations.line.attachMany", tone: "action", action: "attach" })
    assert.deepEqual(line(native("ok")), { key: "integrations.line.attachMany", tone: "action", action: "attach" }, "documents not read yet")
    assert.deepEqual(line(native("unsupported")), { key: "integrations.line.unsupported", tone: "info" })
    // Not loaded.
    assert.deepEqual(line(native("ok", 1, { state: "inactive", status: undefined })), { key: "integrations.line.inactive", tone: "info" })
    assert.deepEqual(line(native("ok", 1, { state: "failed", status: undefined })), { key: "integrations.line.failed", tone: "warning" })
    // Editor MCP and API families.
    assert.deepEqual(line({ family: "vendor-mcp", state: "ok", status: { version: "1", connection: { state: "connected" } } }), { key: "integrations.connection.detected", tone: "info" })
    assert.deepEqual(line({ family: "vendor-mcp", state: "ok", status: { version: "1" } }), { key: "integrations.connection.absent", tone: "info" })
    assert.deepEqual(line({ family: "api", state: "ok", status: { version: "1", connection: { state: "connected" } } }), { key: "integrations.connection.connected", tone: "info" })
    assert.deepEqual(line({ family: "api", state: "ok", status: { version: "1" } }), { key: "integrations.connection.disconnected", tone: "info" })
  })

  it("attaches the only compatible document, offers the choice between several, or none", () => {
    const offer = (offerID: string, protocol: "ok" | "incompatible" = "ok") => ({ offerID, label: `Blender: ${offerID}.blend`, protocol })
    assert.deepEqual(integrationAttachChoice([offer("a")]), { kind: "attach", offerID: "a" })
    assert.deepEqual(integrationAttachChoice([offer("a"), offer("b", "incompatible")]), { kind: "attach", offerID: "a" })
    assert.deepEqual(integrationAttachChoice([offer("a"), offer("b")]), { kind: "choose", offers: [offer("a"), offer("b")] })
    assert.deepEqual(integrationAttachChoice([offer("b", "incompatible")]), { kind: "none" })
    assert.deepEqual(integrationAttachChoice([]), { kind: "none" })
  })

  it("reads the catalogue summary in the current language, else English", () => {
    const entry = { summary: { en: "Use Blender.", fr: "Utiliser Blender." } }
    assert.equal(integrationSummary(entry, "fr"), "Utiliser Blender.")
    assert.equal(integrationSummary(entry, "fr-CA"), "Utiliser Blender.")
    assert.equal(integrationSummary(entry, "ja"), "Use Blender.")
  })
})
