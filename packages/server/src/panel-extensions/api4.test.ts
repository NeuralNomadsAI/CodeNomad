import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PANEL_EXTENSION_API4_PERMISSIONS } from "./contract"
import { fixtureArchive, fixtureManifest } from "./archive-fixture"
import { createPanelExtensionCatalog, PANEL_EXTENSION_CATALOG_URL } from "./catalog"
import { readPanelExtensionArchive } from "./archive"
import { PanelExtensionStore } from "./store"
import { extensionsRequestDesign } from "../opencode/design/demand"

const api4 = (permissions: unknown, extra = {}) => readPanelExtensionArchive(fixtureArchive("<p>x</p>", { apiVersion: 4, permissions, ...extra }))
const design = ["session.context", ...PANEL_EXTENSION_API4_PERMISSIONS]

test("API 4 manifests: session.context plus a non-empty subset of the finite set, in any order", async () => {
  assert.deepEqual((await api4(design)).manifest.permissions, design)
  for (const permission of PANEL_EXTENSION_API4_PERMISSIONS.filter(value => value !== "session.images.prompts")) {
    assert.deepEqual((await api4(["session.context", permission])).manifest.permissions, ["session.context", permission])
  }
  assert.deepEqual((await api4(["composer.prefill", "session.images.prompts", "session.images.read", "session.context"])).manifest.apiVersion, 4)
  for (const permissions of [
    ["session.context"], // empty subset
    ["session.images.read"], // no session.context
    ["session.context", "session.images.read", "session.images.read"], // duplicate
    ["session.context", "session.context", "session.images.read"],
    ["session.context", "session.images.prompts"], // prompts without the gallery
    ["session.context", "session.images.prompts", "composer.prefill"],
    ["session.context", "filesystem.read"], // unknown
    ["session.context", "session.assets.read"], // another API's permission
    ["session.context", "repository.workItems.read"],
    [...design, "panel.preferences"],
    "session.context",
  ]) await assert.rejects(api4(permissions), { code: "invalid" }, JSON.stringify(permissions))
  // APIs 1 to 3 keep their exact tuples: an API 4 permission never widens them.
  for (const [apiVersion, permissions] of [[1, ["session.context", "panel.preferences"]], [2, ["session.context", "session.images.read"]],
    [3, ["session.context", "composer.prefill"]]] as const) {
    await assert.rejects(readPanelExtensionArchive(fixtureArchive("<p>x</p>", { apiVersion, permissions })), { code: "invalid" })
  }
})

test("the catalogue marks API 4 entries compatible only with known permissions; incompatible ones never download or install", async () => {
  const valid = { ...fixtureManifest, id: "example.design", apiVersion: 4, permissions: design }
  const entries = [valid, { ...valid, id: "example.future", permissions: ["session.context", "session.images.write"] },
    { ...valid, id: "example.next", apiVersion: 5 }].map(manifest => ({ manifest, description: "Panel", digest: "a".repeat(64),
    release: { tag: "v1.0.0", asset: "panel-1.0.0.zip" } }))
  let downloads = 0
  const catalog = createPanelExtensionCatalog((async (url: string | URL | Request) => {
    if (String(url) === PANEL_EXTENSION_CATALOG_URL) return new Response(JSON.stringify({ schemaVersion: 1, extensions: entries }))
    downloads++
    return new Response("never")
  }) as typeof fetch)
  assert.deepEqual((await catalog.list()).entries.map(entry => entry.compatible), [true, false, false])
  for (const id of ["example.future", "example.next"]) await assert.rejects(catalog.inspect(id, "a".repeat(64)), { code: "invalid" })
  assert.equal(downloads, 0)
  // Manual installation reads only the manifest before refusing.
  await assert.rejects(api4(["session.context", "session.images.write"]), { code: "invalid" })
  await assert.rejects(readPanelExtensionArchive(fixtureArchive("<script>throw 1</script>", { apiVersion: 5, permissions: design })), { code: "invalid" })
})

test("an installed, enabled API 4 extension declaring opencode.designAgent requests Design; disabled or another one does not", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-api4-design-"))
  try {
    const store = new PanelExtensionStore(directory)
    const pkg = await api4(["session.context", "opencode.designAgent"])
    await store.install(pkg)
    assert.equal(extensionsRequestDesign(await store.list()), false)
    await store.activate(pkg.manifest.id, pkg.digest, true)
    assert.equal(extensionsRequestDesign(await store.list()), true)
    const other = await api4(["session.context", "panel.preferences"])
    await store.install(other, pkg.digest)
    await store.activate(other.manifest.id, other.digest, true)
    assert.equal(extensionsRequestDesign(await store.list()), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("preferences: {} by default, 4 KiB whole objects, per extension, kept on disable, reset on replace and remove, durable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-api4-preferences-"))
  try {
    let changes = 0
    const store = new PanelExtensionStore(directory, () => changes++)
    const first = await api4(["session.context", "panel.preferences"])
    const second = await api4(["session.context", "panel.preferences"], { id: "example.other" })
    for (const pkg of [first, second]) { await store.install(pkg); await store.activate(pkg.manifest.id, pkg.digest, true) }
    const id = first.manifest.id
    assert.deepEqual(await store.preferences(id, first.digest), {})
    const notified = changes
    assert.equal(await store.setPreferences(id, first.digest, { imagesPerTurn: 2 }), "saved")
    assert.equal(changes, notified, "a preference write is not a catalogue change")
    assert.deepEqual(await store.preferences(id, first.digest), { imagesPerTurn: 2 })
    assert.deepEqual(await store.preferences(second.manifest.id, second.digest), {}, "extensions are isolated")
    // Whole-object replacement within 4,096 serialized UTF-8 bytes (`{"v":"…"}` is 8 bytes of framing).
    assert.equal(await store.setPreferences(id, first.digest, { v: "é".repeat((4096 - 8) / 2) }), "saved")
    assert.equal(await store.setPreferences(id, first.digest, { v: "x".repeat(4096 - 8 + 1) }), "too-large")
    assert.equal(await store.setPreferences(id, first.digest, { theme: "dark" }), "saved")
    assert.deepEqual(await store.preferences(id, first.digest), { theme: "dark" })
    for (const value of [[], null, "text", 3, true]) assert.equal(await store.setPreferences(id, first.digest, value), "invalid")
    assert.deepEqual(await new PanelExtensionStore(directory).preferences(id, first.digest), { theme: "dark" }, "kept across restarts")

    await store.activate(id, first.digest, false)
    await assert.rejects(store.preferences(id, first.digest), { code: "unavailable" }, "a disabled package has no authority")
    await assert.rejects(store.setPreferences(id, first.digest, {}), { code: "unavailable" })
    await store.activate(id, first.digest, true)
    assert.deepEqual(await store.preferences(id, first.digest), { theme: "dark" }, "disabling keeps them")

    await assert.rejects(store.preferences(id, "f".repeat(64)), { code: "unavailable" }, "a digest that is not installed")
    await assert.rejects(store.preferences("example.absent", first.digest), { code: "unavailable" })
    const noGrant = await readPanelExtensionArchive(fixtureArchive("<p>y</p>", { id: "example.plain" }))
    await store.install(noGrant); await store.activate(noGrant.manifest.id, noGrant.digest, true)
    await assert.rejects(store.preferences(noGrant.manifest.id, noGrant.digest), { code: "unavailable" }, "the permission is required")

    const replacement = await api4(["session.context", "panel.preferences"], { version: "1.1.0" })
    await store.install(replacement, first.digest)
    await assert.rejects(store.preferences(id, first.digest), { code: "unavailable" })
    await store.activate(id, replacement.digest, true)
    assert.deepEqual(await store.preferences(id, replacement.digest), {}, "replacement resets")
    await store.setPreferences(id, replacement.digest, { theme: "light" })
    await store.remove(id, replacement.digest)
    await store.install(replacement); await store.activate(id, replacement.digest, true)
    assert.deepEqual(await store.preferences(id, replacement.digest), {}, "removal resets")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("preferences: an invalid entry alone reads {}; a corrupt store is unavailable and stays byte-identical", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-api4-corrupt-"))
  try {
    const store = new PanelExtensionStore(directory)
    const pkg = await api4(["session.context", "panel.preferences"])
    await store.install(pkg); await store.activate(pkg.manifest.id, pkg.digest, true)
    const file = path.join(directory, "installed.json")
    const stored = JSON.parse(await readFile(file, "utf8"))
    for (const invalid of [[1, 2], "text", { big: "x".repeat(5000) }]) {
      stored.records[0].preferences = invalid
      await writeFile(file, JSON.stringify(stored))
      assert.deepEqual(await store.preferences(pkg.manifest.id, pkg.digest), {})
    }
    for (const corrupt of ["corrupt", JSON.stringify({ version: 2, records: [] })]) {
      await writeFile(file, corrupt)
      await assert.rejects(store.preferences(pkg.manifest.id, pkg.digest), { code: "unavailable" })
      await assert.rejects(store.setPreferences(pkg.manifest.id, pkg.digest, { a: 1 }), { code: "unavailable" })
      assert.equal(await readFile(file, "utf8"), corrupt)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
