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
      assert.deepEqual(Object.keys(meta).sort(), [
        "serverId", "apiContract", "capabilities", "localUrl", "eventsUrl", "host", "listeningMode",
        "localPort", "hostLabel", "workspaceRoot", "addresses", "system",
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

test("identity initialization refuses invalid/unreadable config and failed persistence", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codenomad-meta-errors-"))
  const config = path.join(root, "config.yaml")
  try {
    for (const content of ["server: [", "server: 42", "server:\n  serverId: not-a-uuid\n"]) {
      writeFileSync(config, content)
      const settings = new SettingsService(resolveConfigLocation(config), undefined, logger)
      assert.throws(() => settings.getServerId())
      assert.equal(readFileSync(config, "utf8"), content, "bad config must remain untouched")
    }
    rmSync(config)
    const settings = new SettingsService(resolveConfigLocation(config), undefined, logger)
    mkdirSync(config)
    assert.throws(() => settings.getServerId(), /could not be read authoritatively/)
    rmSync(config, { recursive: true })
    // A file in place of the parent directory fails portably, even with elevated privileges.
    const blocked = path.join(root, "blocked")
    writeFileSync(blocked, "file")
    const unwritable = new SettingsService(resolveConfigLocation(path.join(blocked, "config.yaml")), undefined, logger)
    assert.throws(() => unwritable.getServerId())
    assert.equal(readFileSync(blocked, "utf8"), "file")
    writeFileSync(config, "ui:\n  locale: fr\n")
    const retry = new SettingsService(resolveConfigLocation(config), undefined, logger)
    const rename = t.mock.method(fs, "renameSync", () => { throw new Error("injected persist failure") })
    assert.throws(() => retry.getServerId(), /injected persist failure/)
    assert.equal(readFileSync(config, "utf8"), "ui:\n  locale: fr\n")
    assert.deepEqual(fs.readdirSync(root).sort(), ["blocked", "config.yaml"])
    rename.mock.restore()
    assert.equal(parse(readFileSync(config, "utf8")).server, undefined)
    const persistedId = retry.getServerId()
    assert.equal(parse(readFileSync(config, "utf8")).server.serverId, persistedId)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
