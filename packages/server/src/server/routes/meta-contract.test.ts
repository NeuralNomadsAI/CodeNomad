import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import test from "node:test"
import Fastify from "fastify"
import { parse } from "yaml"
import { resolveConfigLocation } from "../../config/location"
import { createLogger } from "../../logger"
import { CODENOMAD_API_CONTRACT, CODENOMAD_CAPABILITIES } from "../../meta-contract"
import { SettingsService } from "../../settings/service"
import { registerMetaRoutes } from "./meta"

const logger = createLogger({ level: "ERROR", component: "meta-contract-test" })

test("metadata identity persists across HTTP server restarts and separates configs without disclosing secrets", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codenomad-meta-"))
  const config = path.join(root, "one.yaml")
  const secret = "meta-contract-secret-must-stay-private"
  writeFileSync(config, `server:\n  speech:\n    apiKey: ${secret}\nui:\n  locale: fr\n`)
  async function start(configPath: string) {
    const settings = new SettingsService(resolveConfigLocation(configPath), undefined, logger)
    const app = Fastify()
    registerMetaRoutes(app, {
      serverMeta: {
        serverId: settings.getServerId(), apiContract: CODENOMAD_API_CONTRACT,
        capabilities: [...CODENOMAD_CAPABILITIES],
        localUrl: "http://127.0.0.1:9899", eventsUrl: "/api/events", host: "127.0.0.1",
        listeningMode: "local", localPort: 9899, hostLabel: "fixture", workspaceRoot: root, addresses: [],
      },
      remotePreviewsAllowed: () => false,
    })
    await app.listen({ host: "127.0.0.1", port: 0 })
    try {
      const response = await fetch(`${app.listeningOrigin}/api/meta`)
      assert.equal(response.status, 200)
      const text = await response.text()
      assert.ok(!text.includes(secret))
      assert.ok(!text.includes("apiKey"))
      const meta = JSON.parse(text)
      assert.equal(meta.apiContract, 1)
      assert.deepEqual(meta.capabilities, ["workspaces", "workspace-files", "workspace-git", "events"])
      assert.match(meta.serverId, /^[0-9a-f-]{36}$/)
      assert.equal(meta.localRequest, true)
      assert.deepEqual(Object.keys(meta).sort(), [
        "serverId", "apiContract", "capabilities", "localUrl", "eventsUrl", "host", "listeningMode",
        "localPort", "hostLabel", "workspaceRoot", "addresses", "system", "localRequest",
      ].sort())
      return meta.serverId as string
    } finally { await app.close() }
  }
  try {
    const first = await start(config)
    const persisted = readFileSync(config, "utf8")
    assert.equal(parse(persisted).server.serverId, first)
    assert.equal(parse(persisted).server.speech.apiKey, secret)
    assert.equal(parse(persisted).ui.locale, "fr")
    assert.equal(await start(config), first)
    assert.equal(readFileSync(config, "utf8"), persisted, "restart must not rewrite the identity")
    assert.notEqual(await start(path.join(root, "two.yaml")), first)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("identity initialization omits serverId after invalid/unreadable config and failed persistence", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codenomad-meta-errors-"))
  const config = path.join(root, "config.yaml")
  try {
    for (const content of ["server: [", "server: 42", "server:\n  serverId: not-a-uuid\n"]) {
      writeFileSync(config, content)
      const settings = new SettingsService(resolveConfigLocation(config), undefined, logger)
      assert.equal(settings.getServerId(), undefined)
      assert.equal(readFileSync(config, "utf8"), content, "bad config must remain untouched")
    }
    rmSync(config)
    const settings = new SettingsService(resolveConfigLocation(config), undefined, logger)
    mkdirSync(config)
    assert.equal(settings.getServerId(), undefined)
    rmSync(config, { recursive: true })
    // A file in place of the parent directory fails portably, even with elevated privileges.
    const blocked = path.join(root, "blocked")
    writeFileSync(blocked, "file")
    const unwritable = new SettingsService(resolveConfigLocation(path.join(blocked, "config.yaml")), undefined, logger)
    assert.equal(unwritable.getServerId(), undefined)
    assert.equal(readFileSync(blocked, "utf8"), "file")
    writeFileSync(config, "ui:\n  locale: fr\n")
    const retry = new SettingsService(resolveConfigLocation(config), undefined, logger)
    const rename = t.mock.method(fs, "renameSync", () => { throw new Error("injected persist failure") })
    assert.equal(retry.getServerId(), undefined)
    assert.equal(readFileSync(config, "utf8"), "ui:\n  locale: fr\n")
    assert.deepEqual(fs.readdirSync(root).sort(), ["blocked", "config.yaml", "config.yaml.server-id"])
    rename.mock.restore()
    assert.equal(parse(readFileSync(config, "utf8")).server, undefined)
    const persistedId = retry.getServerId()
    assert.equal(parse(readFileSync(config, "utf8")).server.serverId, persistedId)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("HTTP metadata remains available without a stable identity after corrupt config", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codenomad-meta-fallback-"))
  const config = path.join(root, "config.yaml")
  const app = Fastify()
  try {
    writeFileSync(config, "server: [")
    const settings = new SettingsService(resolveConfigLocation(config), undefined, logger)
    registerMetaRoutes(app, {
      serverMeta: {
        serverId: settings.getServerId(), apiContract: CODENOMAD_API_CONTRACT,
        capabilities: [...CODENOMAD_CAPABILITIES], localUrl: "http://127.0.0.1:9899",
        eventsUrl: "/api/events", host: "127.0.0.1", listeningMode: "local", localPort: 9899,
        hostLabel: "fixture", workspaceRoot: root, addresses: [],
      },
      remotePreviewsAllowed: () => false,
    })
    await app.listen({ host: "127.0.0.1", port: 0 })
    const response = await fetch(`${app.listeningOrigin}/api/meta`)
    assert.equal(response.status, 200)
    const meta = await response.json() as Record<string, unknown>
    assert.equal(Object.prototype.hasOwnProperty.call(meta, "serverId"), false)
    assert.equal(meta.apiContract, CODENOMAD_API_CONTRACT)
    assert.equal(readFileSync(config, "utf8"), "server: [")
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }) }
})
