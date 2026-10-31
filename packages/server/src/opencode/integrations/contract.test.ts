import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
// `ajv2020` is an alias of Ajv 8 (draft 2020-12, Unicode patterns) beside the hoisted Ajv 6 other tests use.
import { Ajv2020 } from "ajv2020/dist/2020.js"
import type { ZodTypeAny } from "zod"
import {
  integrationCatalogDocumentSchema,
  integrationCatalogSchema,
  integrationMarkerSchema,
  integrationRpcSchemas,
} from "./contract"

// AC-F1: every zod schema accepts and refuses exactly the samples its vendored JSON Schema does.
const vendor = (name: string) => new URL(`./vendor/${name}`, import.meta.url)
const json = (name: string) => JSON.parse(readFileSync(vendor(name), "utf8"))
const markerJson = json("marker.schema.json"), catalogJson = json("catalog.schema.json"), rpcJson = json("rpc.schema.json")
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true })
ajv.addSchema(json("host.schema.json"))
const validators = {
  marker: ajv.compile(markerJson),
  catalog: ajv.compile(catalogJson),
  rpc: (name: string) => {
    const validate = ajv.getSchema(`${rpcJson.$id}#/$defs/${name}`)
    assert.ok(validate, `rpc.schema.json defines ${name}`)
    return validate
  },
}
ajv.addSchema(rpcJson)

type Sample = { name: string; value: unknown; valid: boolean }
const REMOVE = Symbol("remove")
// A copy of `base` with `path` set to `value` (REMOVE deletes it).
function edit(base: unknown, path: (string | number)[], value: unknown): unknown {
  const copy = structuredClone(base) as Record<string | number, unknown>
  let target = copy
  for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, unknown>
  const last = path.at(-1)!
  if (value === REMOVE) delete target[last]
  else target[last] = value
  return copy
}
const ok = (name: string, value: unknown): Sample => ({ name, value, valid: true })
const no = (name: string, value: unknown): Sample => ({ name, value, valid: false })
const emoji = (count: number) => "\u{1F3AC}".repeat(count)
const notObjects = [no("null", null), no("array", []), no("string", "{}"), no("number", 1)]

function assertParity(label: string, zod: ZodTypeAny, validate: (value: unknown) => boolean, samples: Sample[]) {
  for (const sample of samples) {
    const jsonVerdict = validate(sample.value)
    const zodVerdict = zod.safeParse(sample.value).success
    assert.equal(jsonVerdict, sample.valid, `${label}: JSON Schema verdict for "${sample.name}"`)
    assert.equal(zodVerdict, jsonVerdict, `${label}: zod and JSON Schema disagree on "${sample.name}"`)
  }
}

const nativeMarker = markerJson.examples[0]
const vendorMarker = markerJson.examples[1]
const apiMarker = { spec: 0, id: "m365", displayName: "OpenCode for Microsoft 365", family: "api", plugin: "neuralnomads.m365", rpc: "neuralnomads.m365" }

describe("integration marker parity", () => {
  it("accepts and refuses the same markers as marker.schema.json", () => {
    assertParity("marker", integrationMarkerSchema, validators.marker, [
      ...markerJson.examples.map((value: unknown, index: number) => ok(`schema example ${index}`, value)),
      ok("api marker", apiMarker),
      ok("vendor-mcp without vendor", edit(vendorMarker, ["vendor"], REMOVE)),
      ok("32-character ID", edit(apiMarker, ["id"], `m${"x".repeat(31)}`)),
      ok("60 code points of display name with astral characters", edit(apiMarker, ["displayName"], `OpenCode for ${emoji(47)}`)),
      ok("host payload with dots", edit(nativeMarker, ["host", "payload"], "host/blender/..")),
      no("61 code points of display name", edit(apiMarker, ["displayName"], `OpenCode for ${emoji(48)}`)),
      no("spec 1", edit(apiMarker, ["spec"], 1)),
      no("uppercase ID", edit(apiMarker, ["id"], "M365")),
      no("33-character ID", edit(apiMarker, ["id"], `m${"x".repeat(32)}`)),
      no("display name without the prefix", edit(apiMarker, ["displayName"], "Microsoft 365")),
      no("unknown family", edit(apiMarker, ["family"], "mcp")),
      no("plugin outside neuralnomads", edit(apiMarker, ["plugin"], "acme.m365")),
      no("rpc outside neuralnomads", edit(apiMarker, ["rpc"], "neuralnomads.M365")),
      no("unknown key", edit(apiMarker, ["future"], true)),
      no("missing rpc", edit(apiMarker, ["rpc"], REMOVE)),
      no("native without host", edit(nativeMarker, ["host"], REMOVE)),
      no("api with host", edit(apiMarker, ["host"], nativeMarker.host)),
      no("api with vendor", edit(apiMarker, ["vendor"], vendorMarker.vendor)),
      no("native with vendor", edit(nativeMarker, ["vendor"], vendorMarker.vendor)),
      no("vendor-mcp with host", edit(vendorMarker, ["host"], nativeMarker.host)),
      no("protocol 0", edit(nativeMarker, ["host", "protocol"], 0)),
      no("fractional protocol", edit(nativeMarker, ["host", "protocol"], 1.5)),
      no("tag range", edit(nativeMarker, ["host", "range"], "latest")),
      no("65-character range", edit(nativeMarker, ["host", "range"], "1".repeat(65))),
      no("empty app versions", edit(nativeMarker, ["host", "appVersions"], "")),
      no("payload with a folder", edit(nativeMarker, ["host", "payload"], "host/blender/../x.zip")),
      no("payload outside host/", edit(nativeMarker, ["host", "payload"], "dist/x.zip")),
      no("uppercase digest", edit(nativeMarker, ["host", "sha256"], "A".repeat(64))),
      no("unknown host key", edit(nativeMarker, ["host", "path"], "x")),
      no("four-part vendor version", edit(vendorMarker, ["vendor", "minAppVersion"], "21.1.0.1")),
      no("empty vendor server", edit(vendorMarker, ["vendor", "server"], "")),
      no("unknown vendor key", edit(vendorMarker, ["vendor", "url"], "x")),
      ...notObjects,
    ])
  })
})

const catalogExample = catalogJson.examples[0]
const nativeEntry = catalogExample.integrations[0]
const apiEntry = { ...structuredClone(nativeEntry), id: "m365", package: "@neuralnomads/opencode-m365", displayName: "OpenCode for Microsoft 365",
  family: "api", plugin: "neuralnomads.m365", rpc: "neuralnomads.m365", app: { name: "Microsoft 365" } }
delete (apiEntry as { host?: unknown }).host
const withEntry = (entry: unknown) => ({ schemaVersion: 1, integrations: [entry] })
const entryEdit = (path: (string | number)[], value: unknown, entry: unknown = nativeEntry) => withEntry(edit(entry, path, value))

describe("integration catalog parity", () => {
  it("accepts and refuses the same catalogs as catalog.schema.json", () => {
    assertParity("catalog", integrationCatalogDocumentSchema, validators.catalog, [
      ok("schema example", catalogExample),
      ok("empty catalog", { schemaVersion: 1, integrations: [] }),
      ok("api entry", withEntry(apiEntry)),
      ok("vendor-mcp entry with vendor", withEntry({ ...apiEntry, family: "vendor-mcp", vendor: { server: "ResolveMCP", minAppVersion: "21" } })),
      ok("script locale", entryEdit(["summary", "zh-Hans"], "x")),
      ok("300 astral code points of summary", entryEdit(["summary", "en"], emoji(300))),
      ok("64 entries", { schemaVersion: 1, integrations: Array(64).fill(nativeEntry) }),
      ok("no sources", entryEdit(["sources"], REMOVE)),
      no("65 entries", { schemaVersion: 1, integrations: Array(65).fill(nativeEntry) }),
      no("schema version 2", { ...catalogExample, schemaVersion: 2 }),
      no("unknown top-level key", { ...catalogExample, signature: "x" }),
      no("missing integrations", { schemaVersion: 1 }),
      no("summary without English", entryEdit(["summary", "en"], REMOVE)),
      no("lowercase region", entryEdit(["summary", "fr-fr"], "x")),
      no("17 summaries", entryEdit(["summary"], Object.fromEntries(["en", ..."abcdefghijklmnop"].map(key => [key.length === 1 ? `${key}${key}` : key, "x"])))),
      no("empty summary", entryEdit(["summary", "en"], "")),
      no("301 code points of summary", entryEdit(["summary", "en"], emoji(301))),
      no("package outside the scope", entryEdit(["package"], "@acme/opencode-blender")),
      no("docs elsewhere", entryEdit(["docs"], "https://example.com/blender")),
      no("unknown status", entryEdit(["status"], "beta")),
      no("Git source elsewhere", entryEdit(["sources", "git"], ["github:acme/opencode-integrations#"])),
      no("nine Git sources", entryEdit(["sources", "git"], Array(9).fill("github:NeuralNomadsAI/opencode-integrations#"))),
      no("unknown sources key", entryEdit(["sources", "npm"], [])),
      no("61-character app name", entryEdit(["app", "name"], "x".repeat(61))),
      no("unknown app key", entryEdit(["app", "url"], "x")),
      no("native without host", entryEdit(["host"], REMOVE)),
      no("api with host", withEntry({ ...apiEntry, host: nativeEntry.host })),
      no("api with vendor", withEntry({ ...apiEntry, vendor: { server: "x" } })),
      no("host with the marker's fields", entryEdit(["host", "app"], "blender")),
      no("missing range", entryEdit(["range"], REMOVE)),
      no("unknown entry key", entryEdit(["payload"], "x")),
      ...notObjects,
    ])
  })

  it("adds the uniqueness JSON Schema cannot express", () => {
    for (const field of ["id", "package", "plugin", "rpc"] as const) {
      const catalog = { schemaVersion: 1, integrations: [nativeEntry, { ...apiEntry, [field]: nativeEntry[field] }] }
      assert.equal(validators.catalog(catalog), true, `catalog.schema.json accepts a duplicate ${field}`)
      assert.equal(integrationCatalogDocumentSchema.safeParse(catalog).success, true)
      assert.equal(integrationCatalogSchema.safeParse(catalog).success, false, `readers refuse a duplicate ${field}`)
    }
    assert.equal(integrationCatalogSchema.safeParse({ schemaVersion: 1, integrations: [nativeEntry, apiEntry] }).success, true)
  })
})

const status = {
  contract: 1,
  integration: { id: "demo", version: "0.1.0", family: "native", spec: 0 },
  host: { state: "absent", expectedRange: "^0.1.0", action: "install" },
  connection: { state: "none", offers: 0, attachedSessions: 0 },
}
const offer = { offerID: "offer_abcdefgh", label: "scene.blend", protocol: "ok" }
const advertise = { host: "127.0.0.1", port: 50_123, token: "a".repeat(64), script_handle: "blender:1", label: "scene.blend", protocol: 1, offer_key: "blender.1234" }
const rpcSamples: Record<string, Sample[]> = {
  "status.input": [ok("empty", {}), no("unknown key", { verbose: true }), ...notObjects],
  "status.output": [
    ok("native status", status),
    ok("api status", { contract: 1, integration: { ...status.integration, family: "api" }, connection: { state: "signed_out" } }),
    ok("unknown field (reader)", { ...status, future: true }),
    ok("unknown host field (reader)", edit(status, ["host", "future"], 1)),
    ok("known notice", { ...status, notices: ["legacy_install"] }),
    ok("unknown notice (reader)", { ...status, notices: ["mystery"] }),
    ok("prerelease version", edit(status, ["integration", "version"], "0.1.0-dev.1+abc")),
    ok("64 astral code points of app version", edit(status, ["host", "appVersion"], emoji(64))),
    no("65 code points of app version", edit(status, ["host", "appVersion"], emoji(65))),
    no("spec 1", edit(status, ["integration", "spec"], 1)),
    no("contract 2", { ...status, contract: 2 }),
    no("missing integration", { contract: 1 }),
    no("two-part version", edit(status, ["integration", "version"], "1.0")),
    no("leading zero", edit(status, ["integration", "version"], "01.0.0")),
    no("unknown host state", edit(status, ["host", "state"], "broken")),
    no("host without state", { ...status, host: { action: "install" } }),
    no("unknown action", edit(status, ["host", "action"], "repair")),
    no("app version with a separator", edit(status, ["host", "appVersion"], "5.2/x")),
    no("app version with a backslash", edit(status, ["host", "appVersion"], "C:\\Blender")),
    no("app version with a control character", edit(status, ["host", "appVersion"], "5.2\u0007")),
    no("part version tag", edit(status, ["host", "partVersion"], "latest")),
    no("range with letters", edit(status, ["host", "expectedRange"], "next")),
    no("unknown connection state", edit(status, ["connection", "state"], "online")),
    no("17 offers", edit(status, ["connection", "offers"], 17)),
    no("fractional offers", edit(status, ["connection", "offers"], 1.5)),
    no("10001 attached sessions", edit(status, ["connection", "attachedSessions"], 10_001)),
    no("duplicate notices", { ...status, notices: ["legacy_install", "legacy_install"] }),
    no("uppercase notice", { ...status, notices: ["Legacy"] }),
    no("nine notices", { ...status, notices: Array.from({ length: 9 }, (_, index) => `n${index}`) }),
    ...notObjects,
  ],
  "installHost.input": [ok("empty", {}), ok("default target", { target: "default" }), no("other target", { target: "user" }), no("unknown key", { force: true })],
  "installHost.output": [
    ok("installed", { outcome: "installed" }),
    ok("refused with detail", { outcome: "refused", detail: "The OpenCode daemon runs in WSL; install the application part from the Windows side." }),
    ok("unknown field (reader)", { outcome: "failed", code: 1 }),
    no("Windows path in detail", { outcome: "failed", detail: "D:\\Apps\\a" }),
    no("301 characters of detail", { outcome: "failed", detail: "x".repeat(301) }),
    no("empty detail", { outcome: "failed", detail: "" }),
    no("newline in detail", { outcome: "failed", detail: "a\nb" }),
    no("unknown outcome", { outcome: "ok" }),
    no("missing outcome", {}),
  ],
  "hosts.input": [ok("empty", {}), no("unknown key", { all: true })],
  "hosts.output": [
    ok("one offer", { offers: [offer] }),
    ok("no offer", { offers: [] }),
    ok("offer with document and app version", { offers: [{ ...offer, document: "scene.blend", appVersion: "5.2.0" }] }),
    ok("unknown offer field (reader)", { offers: [{ ...offer, live: true }] }),
    ok("120 astral code points of label", { offers: [{ ...offer, label: emoji(120) }] }),
    no("121 characters of label", { offers: [{ ...offer, label: "x".repeat(121) }] }),
    no("document path", { offers: [{ ...offer, document: "/home/a/scene.blend" }] }),
    no("Windows document path", { offers: [{ ...offer, document: "C:\\scene.blend" }] }),
    no("short offer ID", { offers: [{ ...offer, offerID: "abc" }] }),
    no("offer ID with a dot", { offers: [{ ...offer, offerID: "offer.abcdefgh" }] }),
    no("unknown protocol verdict", { offers: [{ ...offer, protocol: "unknown" }] }),
    no("missing label", { offers: [{ offerID: offer.offerID, protocol: "ok" }] }),
    no("17 offers", { offers: Array(17).fill(offer) }),
    no("missing offers", {}),
  ],
  "attachHost.input": [
    ok("attach", { offerID: offer.offerID, sessionID: "ses_abc" }),
    no("session ID with a dot", { offerID: offer.offerID, sessionID: "ses.abc" }),
    no("129-character session ID", { offerID: offer.offerID, sessionID: "s".repeat(129) }),
    no("missing offer", { sessionID: "ses_abc" }),
    no("unknown key", { offerID: offer.offerID, sessionID: "ses_abc", force: true }),
  ],
  "attachHost.output": [ok("attached", { outcome: "attached" }), ok("unknown field (reader)", { outcome: "gone", why: "x" }), no("unknown outcome", { outcome: "unknown" })],
  "detachHost.input": [ok("detach", { sessionID: "ses_abc" }), no("missing session", {}), no("empty session", { sessionID: "" })],
  "detachHost.output": [ok("detached", { outcome: "detached" }), ok("none", { outcome: "none" }), no("unknown outcome", { outcome: "gone" })],
  "advertise.input": [
    ok("announcement", advertise),
    ok("script handle with a path", { ...advertise, script_handle: "C:/scenes/a.blend" }),
    no("localhost", { ...advertise, host: "localhost" }),
    no("IPv6 loopback", { ...advertise, host: "::1" }),
    no("port 0", { ...advertise, port: 0 }),
    no("port 65536", { ...advertise, port: 65_536 }),
    no("uppercase token", { ...advertise, token: "A".repeat(64) }),
    no("short token", { ...advertise, token: "a".repeat(63) }),
    no("control character in script handle", { ...advertise, script_handle: "a\u0000" }),
    no("201 characters of script handle", { ...advertise, script_handle: "a".repeat(201) }),
    no("label with a separator", { ...advertise, label: "a/b" }),
    no("protocol 1001", { ...advertise, protocol: 1001 }),
    no("65-character offer key", { ...advertise, offer_key: "k".repeat(65) }),
    no("unknown key", { ...advertise, binding_key: "x" }),
    no("missing token", edit(advertise, ["token"], REMOVE)),
  ],
  // The conformance package refuses this extra offer ID in its strict producer form; readers accept and drop it.
  "advertise.output": [ok("accepted", { outcome: "accepted" }), ok("unknown field (reader)", { outcome: "accepted", offerID: offer.offerID }), no("unknown outcome", { outcome: "ok" })],
  "withdraw.input": [ok("withdraw", { offer_key: "blender.1234", token: "b".repeat(64) }), no("missing token", { offer_key: "blender.1234" }), no("unknown key", { offer_key: "k", token: "b".repeat(64), port: 1 })],
  "withdraw.output": [ok("withdrawn", { outcome: "withdrawn" }), no("unknown outcome", { outcome: "removed" })],
  "status_changed.event": [ok("no payload", {}), no("payload", { state: "ok" }), ...notObjects],
  "hosts_changed.event": [ok("no payload", {}), no("payload", { offers: 1 })],
}

describe("integration RPC parity", () => {
  it("defines a zod schema for every rpc.schema.json definition and no other", () => {
    assert.deepEqual(Object.keys(integrationRpcSchemas).sort(), Object.keys(rpcJson.$defs).sort())
    assert.deepEqual(Object.keys(rpcSamples).sort(), Object.keys(rpcJson.$defs).sort())
  })

  for (const [name, samples] of Object.entries(rpcSamples)) {
    it(`accepts and refuses the same values as ${name}`, () => {
      assertParity(name, integrationRpcSchemas[name as keyof typeof integrationRpcSchemas], validators.rpc(name), samples)
    })
  }
})

describe("vendored specification", () => {
  it("matches the pinned opencode-integrations revision byte for byte", () => {
    const manifest = json("VENDORED.json")
    assert.match(manifest.revision, /^[0-9a-f]{40}$/)
    const root = new URL("../../../../../", import.meta.url)
    for (const [path, { blob }] of Object.entries(manifest.files as Record<string, { blob: string }>)) {
      // Git blob ID of the LF-normalized content, so an autocrlf checkout still matches.
      const content = Buffer.from(readFileSync(fileURLToPath(new URL(path, root)), "utf8").replace(/\r\n/g, "\n"))
      const id = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex")
      assert.equal(id, blob, `${path} differs from the pinned revision`)
    }
  })
})
