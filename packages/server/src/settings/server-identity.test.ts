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
  return new Promise<{ code: number | null; id: string; err: string }>((resolve, reject) => {
    processChild.on("error", reject)
    processChild.on("close", code => {
      clearTimeout(timeout)
      if (code !== 0 && code !== 73) reject(new Error(`Child exited ${code}: ${err}`))
      else resolve({ code, id: out.trim(), err })
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

test("read-only, corrupt config and corrupt claims omit identity without replacing files", (t) => {
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
    assert.equal(instance.getServerId(), undefined)
    access.mock.restore()
    const claimed = fs.readFileSync(claimPath, "utf8")
    assert.equal(fs.readFileSync(config, "utf8"), "ui:\n  locale: fr\n")
    fs.writeFileSync(config, "server: [")
    assert.equal(settings().getServerId(), undefined)
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
    const before = Date.now()
    assert.equal(settings().getServerId(), undefined)
    assert.ok(Date.now() - before < 3000, "incomplete claims have a bounded wait")
    assert.equal(fs.readFileSync(claimPath, "utf8"), "")
    assert.equal(fs.readFileSync(config, "utf8"), "ui:\n  locale: fr\n")
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("a real contender waits for the exclusive writer to finish its partial UUID", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-identity-slow-"))
  try {
    const [writer, contender] = await Promise.all([child(root, "a", "slow-writer"), child(root, "b", "contender")])
    assert.match(writer.id, /^[0-9a-f-]{36}$/, writer.err)
    assert.equal(contender.id, writer.id, contender.err)
    assert.equal((await child(root)).id, writer.id)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("a crashed partial writer is preserved across restarts until explicit repair", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-identity-partial-"))
  try {
    assert.equal((await child(root, "crash", "crash-partial")).code, 73)
    const claimPath = path.join(root, "config.yaml.server-id")
    const partial = fs.readFileSync(claimPath, "utf8")
    assert.equal(partial.length, 8)
    const restarted = await child(root)
    assert.equal(restarted.id, "undefined")
    assert.match(restarted.err, /explicit repair required/)
    assert.equal((await child(root)).id, "undefined")
    assert.equal(fs.readFileSync(claimPath, "utf8"), partial)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("identity creation needs no hard links and read-only storage logs a fallback", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-identity-storage-"))
  try {
    t.mock.method(fs, "linkSync", () => { throw new Error("hard links unsupported") })
    const logger = createLogger({ level: "ERROR" })
    const config = path.join(root, "config.yaml")
    const settings = new SettingsService(resolveConfigLocation(config), undefined, logger)
    assert.match(settings.getServerId()!, /^[0-9a-f-]{36}$/)
    const warn = t.mock.method(logger, "warn")
    const blocked = new SettingsService(resolveConfigLocation(path.join(root, "blocked.yaml")), undefined, logger)
    const open = fs.openSync
    t.mock.method(fs, "openSync", (file: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      if (flags === "wx") throw Object.assign(new Error("read-only storage"), { code: "EROFS" })
      return open(file, flags, mode)
    })
    assert.equal(blocked.getServerId(), undefined)
    assert.equal(warn.mock.callCount(), 1)
    assert.match(String(warn.mock.calls[0].arguments[1]), /identity unavailable/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("a failed YAML rename accepts only the same identity committed by another initializer", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-identity-rename-"))
  const config = path.join(root, "config.yaml")
  try {
    const settings = new SettingsService(resolveConfigLocation(config), undefined, createLogger({ level: "ERROR" }))
    let conflict = false
    const otherId = "715941e7-8f5e-422a-b64d-25e56c672553"
    t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      fs.writeFileSync(to, conflict ? `server:\n  serverId: ${otherId}\n` : fs.readFileSync(from))
      throw Object.assign(new Error("concurrent rename refused"), { code: "EPERM" })
    })
    const id = settings.getServerId()
    assert.match(id!, /^[0-9a-f-]{36}$/)
    assert.equal(parse(fs.readFileSync(config, "utf8")).server.serverId, id)
    fs.writeFileSync(config, "ui:\n  locale: fr\n")
    conflict = true
    assert.equal(settings.getServerId(), undefined)
    assert.equal(parse(fs.readFileSync(config, "utf8")).server.serverId, otherId)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
