import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { resolveConfigLocation } from "../../config/location"
import { createLogger } from "../../logger"
import { CODENOMAD_API_CONTRACT, CODENOMAD_CAPABILITIES } from "../../meta-contract"
import { SettingsService } from "../../settings/service"
import { registerMetaRoutes } from "./meta"

const logger = createLogger({ level: "ERROR", component: "meta-contract-test" })

async function metadata(root: string, file: string) {
  const settings = new SettingsService(resolveConfigLocation(path.join(root, file)), undefined, logger)
  const app = Fastify()
  try {
    registerMetaRoutes(app, {
      serverMeta: {
        serverId: settings.getServerId(), apiContract: CODENOMAD_API_CONTRACT,
        capabilities: [...CODENOMAD_CAPABILITIES], localUrl: "http://127.0.0.1:9899",
        eventsUrl: "/api/events", host: "127.0.0.1", listeningMode: "local", localPort: 9899,
        hostLabel: "fixture", workspaceRoot: root, addresses: [],
      },
      remotePreviewsAllowed: () => false,
    })
    const response = await app.inject("/api/meta")
    assert.equal(response.statusCode, 200)
    return response
  } finally { await app.close() }
}

test("metadata publishes the public contract and separates configs without disclosing secrets", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codenomad-meta-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const secret = "meta-contract-secret-must-stay-private"
  writeFileSync(path.join(root, "one.yaml"), `server:\n  speech:\n    apiKey: ${secret}\n`)
  const response = await metadata(root, "one.yaml")
  assert.ok(!response.body.includes(secret))
  assert.ok(!response.body.includes("apiKey"))
  const meta = response.json()
  assert.equal(meta.apiContract, 1)
  assert.deepEqual(meta.capabilities, ["workspaces", "workspace-files", "workspace-git", "events"])
  assert.match(meta.serverId, /^[0-9a-f-]{36}$/)
  const other = (await metadata(root, "two.yaml")).json()
  assert.match(other.serverId, /^[0-9a-f-]{36}$/)
  assert.notEqual(other.serverId, meta.serverId)
})

test("HTTP metadata remains available without a stable identity after invalid config", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codenomad-meta-fallback-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = "config.yaml", config = path.join(root, file)
  for (const content of ["server: [", "server: 42", "server:\n  serverId: not-a-uuid\n"]) {
    writeFileSync(config, content)
    const meta = (await metadata(root, file)).json()
    assert.equal(Object.hasOwn(meta, "serverId"), false)
    assert.equal(meta.apiContract, CODENOMAD_API_CONTRACT)
    assert.equal(readFileSync(config, "utf8"), content)
  }
})
