import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import Fastify from "fastify"
import { PANEL_EXTENSION_LIMITS } from "./contract"
import { fixtureArchive, fixtureManifest, fixtureZip } from "./archive-fixture"
import { readPanelExtensionArchive } from "./archive"
import { PanelExtensionStore } from "./store"
import { registerPanelExtensionRoutes } from "../server/routes/panel-extensions"

test("ZIP contract is bounded and rejects unsupported APIs, paths, links, duplicate entries and extra code", async () => {
  const pkg = await readPanelExtensionArchive(fixtureArchive())
  assert.equal(pkg.manifest.id, fixtureManifest.id)
  assert.match(pkg.digest, /^[a-f0-9]{64}$/)
  for (const changes of [{ apiVersion: 2 }, { permissions: ["filesystem"] }, { repository: "https://github.com.evil.test/a/b" },
    { id: "../outside" }, { server: "index.js" }, { repository: "https://github.com/a/b?token=secret" }]) {
    await assert.rejects(readPanelExtensionArchive(fixtureArchive("<p>x</p>", changes)), { code: "invalid" })
  }
  const manifest = { name: "manifest.json", data: JSON.stringify(fixtureManifest) }
  for (const files of [
    [manifest, { name: "../panel.html", data: "x" }],
    [manifest, { name: "panel.html", data: "x", mode: 0o120777 }],
    [manifest, { name: "panel.html", data: "x" }, { name: "panel.html", data: "y" }],
    [manifest, { name: "panel.html", data: "x" }, { name: "index.js", data: "x" }],
    [manifest, { name: "panel.html", data: "x", size: PANEL_EXTENSION_LIMITS.htmlBytes + 1 }],
    [manifest, { name: "panel.html", data: Buffer.from([0xff]) }],
  ]) await assert.rejects(readPanelExtensionArchive(fixtureZip(files)), { code: "invalid" })
  await assert.rejects(readPanelExtensionArchive(Buffer.alloc(PANEL_EXTENSION_LIMITS.archiveBytes + 1)), { code: "limit" })
})

test("install, scoped consent, restart, replacement revocation and concurrent edits preserve authoritative state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-panel-extension-"))
  try {
    let changes = 0
    const store = new PanelExtensionStore(directory, () => changes++)
    const first = await readPanelExtensionArchive(fixtureArchive())
    await store.install(first)
    assert.equal((await store.list("/repo"))[0].enabled, false)
    await assert.rejects(store.panel(first.manifest.id, first.digest, "/repo"), { code: "disabled" })
    await Promise.all([
      store.activate(first.manifest.id, first.digest, "/repo", "project", true),
      store.activate(first.manifest.id, first.digest, "/second", "project", true),
    ])
    assert.equal((await new PanelExtensionStore(directory).list("/repo"))[0].enabled, true)
    assert.equal((await store.list("/repo/sibling"))[0].enabled, false)
    assert.equal(await store.panel(first.manifest.id, first.digest, "/second"), first.html)
    await store.activate(first.manifest.id, first.digest, "/repo", "global", true)
    assert.equal((await store.list("/unrelated"))[0].enabled, true)
    const second = await readPanelExtensionArchive(fixtureArchive("<p>Updated</p>", { version: "1.1.0" }))
    await assert.rejects(store.install(second), { code: "conflict" })
    await store.install(second, first.digest)
    assert.equal((await store.list("/repo"))[0].enabled, false)
    await assert.rejects(store.activate(first.manifest.id, first.digest, "/repo", "global", true), { code: "conflict" })
    await store.remove(second.manifest.id, second.digest)
    assert.deepEqual(await store.list("/repo"), [])
    assert.ok(changes >= 6)
    await writeFile(path.join(directory, "installed.json"), "corrupt")
    await assert.rejects(store.install(first), { code: "unavailable" })
    assert.equal(await readFile(path.join(directory, "installed.json"), "utf8"), "corrupt")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("typed routes demand consent, digest and owned folder; exports contain no executable HTML", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-panel-route-"))
  const app = Fastify()
  const workspace = { id: "owned", path: "/owned" } as any
  registerPanelExtensionRoutes(app, { store: new PanelExtensionStore(directory), workspaceManager: { get: id => id === "owned" ? workspace : undefined } })
  try {
    const archiveBase64 = fixtureArchive().toString("base64")
    const inspection = await app.inject({ method: "POST", url: "/api/panel-extensions/inspect", payload: { archiveBase64 } })
    assert.equal(inspection.statusCode, 200)
    const { digest } = inspection.json()
    assert.equal((await app.inject({ method: "POST", url: "/api/panel-extensions", payload: { archiveBase64, digest } })).statusCode, 400)
    assert.equal((await app.inject({ method: "POST", url: "/api/panel-extensions", payload: { archiveBase64, digest, acknowledged: true } })).statusCode, 200)
    const panel = `/api/panel-extensions/${fixtureManifest.id}/panel?instanceId=owned&digest=${digest}`
    assert.equal((await app.inject(panel)).statusCode, 403)
    assert.equal((await app.inject({ method: "PATCH", url: `/api/panel-extensions/${fixtureManifest.id}?instanceId=foreign`,
      payload: { digest, scope: "project", enabled: true } })).statusCode, 404)
    assert.equal((await app.inject({ method: "PATCH", url: `/api/panel-extensions/${fixtureManifest.id}?instanceId=owned`,
      payload: { digest, scope: "project", enabled: true, directory: "/foreign" } })).statusCode, 400)
    assert.equal((await app.inject({ method: "PATCH", url: `/api/panel-extensions/${fixtureManifest.id}?instanceId=owned`,
      payload: { digest, scope: "project", enabled: true } })).statusCode, 200)
    assert.equal((await app.inject(panel)).json().html, "<p>Example</p>")
    const catalogue = await app.inject("/api/panel-extensions?instanceId=owned")
    assert.equal(catalogue.headers["cache-control"], "no-store")
    assert.equal(catalogue.body.includes("<p>Example"), false)
    assert.equal((await app.inject("/api/panel-extensions?instanceId=owned&directory=/foreign")).statusCode, 400)
    const invalid = await app.inject({ method: "POST", url: "/api/panel-extensions/inspect", payload: { archiveBase64: "secret-not-a-zip" } })
    assert.equal(invalid.statusCode, 400)
    assert.equal(invalid.body.includes("secret-not"), false)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
