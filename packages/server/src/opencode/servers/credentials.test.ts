import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import pino from "pino"
import { OpenCodeServerCredentials } from "./credentials"
import { OpenCodeServerRegistry } from "./registry"
import { sanitizeConfigDoc } from "../../settings/public-config"
import { SettingsService } from "../../settings/service"
import { resolveConfigLocation } from "../../config/location"
import type { EventBus } from "../../events/bus"

const scope = { profileKey: "stable", configIdentity: "config-a" }
const username = "username-sentinel-never-persist"
const password = "password-sentinel-never-persist"
const secret = JSON.stringify({ username, password })
const authorization = Buffer.from(`${username}:${password}`).toString("base64")
const profile = { kind: "explicit", id: "target", label: "Target", origin: "https://example.test" } as const

function fixture() {
  let metadata: unknown = [profile]
  const registry = new OpenCodeServerRegistry(() => metadata, next => { metadata = next })
  const create = (ownerScope = scope) => new OpenCodeServerCredentials(ownerScope, registry)
  return { registry, create, metadata: () => metadata }
}

test("memory rotation and clearing never publish metadata; every fresh owner requires entry", async () => {
  const f = fixture(), owner = f.create()
  assert.deepEqual(await owner.status("target"), { hasCredentials: false, needsCredentials: true })
  assert.equal(await owner.set("target", secret), undefined)
  assert.equal(await owner.readForConnection("target"), secret)
  assert.deepEqual(await owner.status("target"), { hasCredentials: true, needsCredentials: false })
  for (const scopeValue of [scope, { ...scope, profileKey: "dev" }, { ...scope, configIdentity: "other" }]) {
    assert.deepEqual(await f.create(scopeValue).status("target"), { hasCredentials: false, needsCredentials: true })
  }
  await Promise.all([owner.set("target", "one"), owner.set("target", "two")])
  assert.equal(await owner.readForConnection("target"), "two")
  assert.deepEqual(f.metadata(), [profile])
  assert.deepEqual(JSON.parse(JSON.stringify(owner)), {})
  await Promise.all([owner.set("target", "three"), owner.clear("target")])
  assert.equal(await owner.readForConnection("target"), null)
  await owner.clear("target")
  await owner.dispose()
  for (const action of [() => owner.set("target", secret), () => owner.readForConnection("target"),
    () => owner.status("target"), () => owner.clear("target")]) await assert.rejects(action(), { code: "closed" })
})

test("server and origin changes isolate credentials; forget remains safe after metadata removal", async () => {
  const f = fixture(), owner = f.create()
  f.registry.replace([profile, { ...profile, id: "other" }])
  await owner.set("target", secret)
  assert.equal(await owner.readForConnection("other"), null)
  f.registry.replace([{ ...profile, origin: "https://other.test" }])
  assert.equal(await owner.readForConnection("target"), null)
  f.registry.replace([profile])
  assert.equal(await owner.readForConnection("target"), null)
  await owner.set("target", secret)
  f.registry.replace([])
  await owner.clear("target")
  f.registry.replace([profile])
  assert.equal(await owner.readForConnection("target"), null)
  await owner.set("target", secret)
  f.registry.replace([])
  await assert.rejects(owner.readForConnection("target"), { code: "unknown_server" })
  f.registry.replace([profile])
  assert.equal(await owner.readForConnection("target"), null)
})

test("validation and metadata errors use fixed codes and preserve the active value", async () => {
  const f = fixture(), owner = f.create()
  await owner.set("target", secret)
  for (const value of ["", "x".repeat(16 * 1024 + 1), null, {}, 1]) {
    await assert.rejects(owner.set("target", value as string), { code: "invalid_credentials", message: "invalid_credentials" })
  }
  assert.equal(await owner.readForConnection("target"), secret)
  for (const id of ["local-shared", "missing"]) await assert.rejects(owner.set(id, secret), { code: "unknown_server" })
  const broken = new OpenCodeServerCredentials(scope, new OpenCodeServerRegistry(() => { throw new Error(secret) }, () => {}))
  await assert.rejects(broken.set("target", secret), { code: "metadata_unavailable", message: "metadata_unavailable" })
})

test("real config, backups, logs, API/event/browser projections exclude username, password and Authorization", async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-credentials-"))
  const events: unknown[] = []
  const destination = pino.destination({ dest: path.join(root, "backend.log"), sync: true })
  const logger = pino(destination)
  try {
    const location = resolveConfigLocation(path.join(root, "config.yaml"))
    const settings = new SettingsService(location,
      { publish: (event: unknown) => events.push(event) } as unknown as EventBus, logger)
    const registry = settings.getOpenCodeServerRegistry()
    registry.replace([profile])
    const owner = new OpenCodeServerCredentials(scope, registry)
    const before = fs.readFileSync(location.configYamlPath, "utf8")
    await owner.set("target", secret)
    await owner.set("target", authorization)
    await owner.set("target", secret)
    assert.equal(fs.readFileSync(location.configYamlPath, "utf8"), before)
    const restartedSettings = new SettingsService(location, undefined, logger)
    const restartedOwner = new OpenCodeServerCredentials(scope, restartedSettings.getOpenCodeServerRegistry())
    assert.equal((await restartedOwner.status("target")).needsCredentials, true)
    await restartedOwner.dispose()
    const restarted = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import pino from 'pino';
      import { SettingsService } from './packages/server/src/settings/service.ts';
      import { resolveConfigLocation } from './packages/server/src/config/location.ts';
      import { OpenCodeServerCredentials } from './packages/server/src/opencode/servers/credentials.ts';
      const settings = new SettingsService(resolveConfigLocation(process.argv[1]), undefined, pino({level:'silent'}));
      const owner = new OpenCodeServerCredentials(${JSON.stringify(scope)}, settings.getOpenCodeServerRegistry());
      console.log(JSON.stringify(await owner.status('target')));
    `, location.configYamlPath], { encoding: "utf8", windowsHide: true })
    assert.deepEqual(JSON.parse(restarted), { hasCredentials: false, needsCredentials: true })
    fs.copyFileSync(location.configYamlPath, path.join(root, "config.yaml.backup"))
    settings.mergePatchOwner("config", "server", { logLevel: "WARN" })
    registry.replace([{ ...profile, label: "Changed" }])
    assert.equal(await owner.readForConnection("target"), secret)
    const api = sanitizeConfigDoc(settings.getDoc("config"))
    logger.info(await owner.status("target"), "credential status")
    const assertSafe = (value: string) => {
      for (const sentinel of [username, password, authorization]) assert.ok(!value.includes(sentinel))
      assert.doesNotMatch(value, /credentialRef|credentialMode|credentialStoreStatus/)
    }
    assertSafe(JSON.stringify({ events, api, browser: structuredClone(api), owner }))
    const scan = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) scan(file)
        else assertSafe(fs.readFileSync(file, "utf8"))
      }
    }
    scan(root)
    await owner.clear("target")
    await owner.dispose()
  } finally {
    destination.end()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
