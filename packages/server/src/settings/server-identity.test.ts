import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { parse } from "yaml"
import { SettingsService } from "./service"
import { resolveConfigLocation } from "../config/location"
import { createLogger } from "../logger"

const childPath = fileURLToPath(new URL("./fixtures/server-identity-child.ts", import.meta.url))
function child(root: string, who = "restart", mode = "read") {
  const processChild = spawn(process.execPath, ["--import", "tsx", childPath, root, who, mode], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  })
  let out = "", err = ""
  processChild.stdout.on("data", data => { out += data })
  processChild.stderr.on("data", data => { err += data })
  const timeout = setTimeout(() => processChild.kill(), 30_000)
  return new Promise<{ code: number | null; id: string }>((resolve, reject) => {
    processChild.on("error", reject)
    processChild.on("close", code => {
      clearTimeout(timeout)
      if (code !== 0 && code !== 73) reject(new Error(`Child exited ${code}: ${err}`))
      else resolve({ code, id: out.trim() })
    })
  })
}

test("concurrent real processes advertise one persisted identity, including after restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-identity-race-"))
  try {
    const config = path.join(root, "config.yaml")
    fs.writeFileSync(config, "ui:\n  locale: fr\nserver:\n  logLevel: INFO\n")
    const results = await Promise.allSettled([child(root, "a", "race"), child(root, "b", "race")])
    const ids = results.map(result => {
      if (result.status === "rejected") throw result.reason
      assert.equal(result.value.code, 0)
      return result.value.id
    })
    assert.match(ids[0], /^[0-9a-f-]{36}$/)
    assert.equal(ids[0], ids[1], "both processes must advertise the same identity")
    const persisted = fs.readFileSync(config, "utf8")
    assert.equal(parse(persisted).server.serverId, ids[0])
    assert.equal(parse(persisted).server.logLevel, "INFO")
    assert.equal(parse(persisted).ui.locale, "fr")
    assert.equal((await child(root)).id, ids[0])
    assert.equal(fs.readFileSync(config, "utf8"), persisted)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

for (const mode of ["crash-before-claim", "crash-after-claim"]) {
  test(`identity initialization recovers after ${mode} without replacing a claim`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-identity-crash-"))
    try {
      assert.equal((await child(root, "crash", mode)).code, 73)
      const claimPath = path.join(root, "config.yaml.server-id")
      const claim = fs.existsSync(claimPath) ? fs.readFileSync(claimPath, "utf8") : undefined
      const restarted = await child(root)
      assert.match(restarted.id, /^[0-9a-f-]{36}$/)
      if (claim) assert.equal(restarted.id, claim)
      assert.equal((await child(root)).id, restarted.id)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
}

test("read-only, corrupt config and corrupt claims fail without replacing the identity", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-identity-errors-"))
  const config = path.join(root, "config.yaml")
  const claimPath = `${config}.server-id`
  const logger = createLogger({ level: "ERROR" })
  const settings = () => new SettingsService(resolveConfigLocation(config), undefined, logger)
  try {
    fs.writeFileSync(config, "ui:\n  locale: fr\n")
    const instance = settings()
    const access = t.mock.method(fs, "accessSync", () => {
      throw Object.assign(new Error("read-only config"), { code: "EACCES" })
    })
    assert.throws(() => instance.getServerId(), /read-only config/)
    access.mock.restore()
    const claimed = fs.readFileSync(claimPath, "utf8")
    assert.equal(fs.readFileSync(config, "utf8"), "ui:\n  locale: fr\n")
    fs.writeFileSync(config, "server: [")
    assert.throws(() => settings().getServerId())
    assert.equal(fs.readFileSync(config, "utf8"), "server: [")
    assert.equal(fs.readFileSync(claimPath, "utf8"), claimed)
    fs.writeFileSync(config, "ui:\n  locale: fr\n")
    assert.equal(settings().getServerId(), claimed)
    fs.chmodSync(config, 0o400)
    try {
      assert.equal(settings().getServerId(), claimed, "an existing identity needs no write")
    } finally { fs.chmodSync(config, 0o600) }
    fs.writeFileSync(config, "ui:\n  locale: fr\n")
    fs.writeFileSync(claimPath, "")
    assert.throws(() => settings().getServerId())
    assert.equal(fs.readFileSync(claimPath, "utf8"), "")
    assert.equal(fs.readFileSync(config, "utf8"), "ui:\n  locale: fr\n")
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
