import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createECDH, randomBytes } from "node:crypto"
import { AuthManager } from "../auth/manager"
import { createLogger } from "../logger"
import { EventBus } from "../events/bus"
import { RemoteDeviceRegistry } from "../remote-control/devices"
import { RemoteControlManager } from "../remote-control/manager"
import { SettingsService } from "../settings/service"
import { resolveConfigLocation } from "../config/location"
import { acquirePushHost, readPushPolicy } from "./host"
import Fastify from "fastify"
import { registerAuthRoutes } from "../server/routes/auth"
import { DEVICE_COOKIE_NAME, gateRemoteRequest } from "../remote-control/gate"
import type { WorkspaceManager } from "../workspaces/manager"
import type { PushPrincipal } from "./service"

const origin = "https://push.code.example"
test("administrator push policy and contact are validated independently of activation", () => {
  assert.deepEqual(readPushPolicy({}), { disabled: false, subject: "https://github.com/NeuralNomadsAI/CodeNomad" })
  assert.equal(readPushPolicy({ CODENOMAD_WEB_PUSH: "disabled" }).disabled, true)
  assert.equal(readPushPolicy({ CODENOMAD_WEB_PUSH_SUBJECT: "mailto:admin@example.com" }).subject, "mailto:admin@example.com")
  for (const value of ["enabled", " ", "false"]) assert.throws(() => readPushPolicy({ CODENOMAD_WEB_PUSH: value }))
  for (const subject of ["http://bad.example", "https://user:password@bad.example", "mailto:invalid"]) {
    assert.throws(() => readPushPolicy({ CODENOMAD_WEB_PUSH_SUBJECT: subject }))
  }
})
function consent() {
  const curve = createECDH("prime256v1")
  return { subscription: { endpoint: "https://fcm.googleapis.com/push/" + randomBytes(8).toString("hex"),
    keys: { p256dh: curve.generateKeys().toString("base64url"), auth: randomBytes(16).toString("base64url") } },
  projects: ["project"], preferences: { v: 1, needsInput: true, sessionDone: true } }
}
async function fixture(t: test.TestContext, idleMs = 24 * 60 * 60 * 1000) {
  let ready = true
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-host-"))
  const logger = createLogger({ level: "silent" } as never), eventBus = new EventBus()
  const location = resolveConfigLocation(path.join(dir, "config.yaml"))
  const settings = new SettingsService(location, eventBus, logger)
  settings.mergePatchOwner("config", "ui", { settings: { multiBackend: true } })
  const authManager = new AuthManager({ configPath: location.configYamlPath, username: "user", generateToken: true, sessionIdleMs: idleMs }, logger)
  const remoteControlManager = new RemoteControlManager({
    registry: new RemoteDeviceRegistry(path.join(dir, "devices.json")), logger,
    directHttpsOrigins: () => ready ? [origin] : [], router: () => null,
    openTunnel: async () => ({ url: "https://push.tunnel.example", hostname: "push.tunnel.example",
      status: () => ({ state: "connected", connections: 0 }), closed: new Promise<string>(() => {}), close: async () => {} }),
  })
  const workspaceManager = { list: () => [{ id: "project" }] } as unknown as WorkspaceManager
  const deps = { authManager, remoteControlManager, settings, eventBus, workspaceManager, authorityReady: () => ready }
  const host = acquirePushHost(deps)
  t.after(async () => { host.release(); await remoteControlManager.shutdown(); fs.rmSync(dir, { recursive: true, force: true }) })
  const pairing = remoteControlManager.createDirectPairing(origin)
  const device = remoteControlManager.exchangeDirectPairing(new URL(pairing.url).hash.slice(1), origin, undefined)!
  const devicePrincipal: PushPrincipal = { id: `remote-device:${device.device.id}`, channel: "https", origin }
  const session = authManager.createSession("user")
  const sessionPrincipal: PushPrincipal = { id: session.id, channel: "https", origin }
  return { ...deps, host, devicePrincipal, deviceToken: device.token, sessionPrincipal, setReady: (value: boolean) => { ready = value } }
}

test("one host across listeners; logout and password replacement revoke actual private consent", async t => {
  const f = await fixture(t)
  const other = acquirePushHost(f)
  t.after(other.release)
  assert.equal(f.host.push, other.push)
  f.host.push.subscribe(f.devicePrincipal, consent())
  f.host.push.subscribe(f.sessionPrincipal, consent())
  const app = Fastify()
  registerAuthRoutes(app, { authManager: f.authManager })
  const url = await app.listen({ host: "127.0.0.1", port: 0 })
  t.after(() => app.close())
  assert.equal((await fetch(`${url}/api/auth/logout`, { method: "POST",
    headers: { cookie: `${f.authManager.getCookieName()}=${f.sessionPrincipal.id}` } })).status, 200)
  assert.equal(f.host.push.status(f.sessionPrincipal).subscribed, false)
  assert.equal(f.host.push.status(f.devicePrincipal).subscribed, true)
  await f.authManager.setPassword("a-long-new-password")
  assert.equal(f.host.push.status(f.devicePrincipal).subscribed, false)
})

test("device revoke and explicit tunnel Stop purge only their bound channel", async t => {
  const f = await fixture(t)
  const started = await f.remoteControlManager.start()
  const device = f.remoteControlManager.exchangePairing(new URL(started.pairing.url).hash.slice(1), undefined)!
  const tunnel: PushPrincipal = { id: `remote-device:${device.device.id}`, channel: "tunnel", origin: "https://push.tunnel.example" }
  f.host.push.subscribe(tunnel, consent())
  f.host.push.subscribe(f.devicePrincipal, consent())
  await f.remoteControlManager.stop()
  assert.equal(f.host.push.status(tunnel).subscribed, false)
  assert.equal(f.host.push.status(f.devicePrincipal).subscribed, true)
  f.remoteControlManager.revokeDevice(f.devicePrincipal.id.slice(14))
  assert.equal(f.host.push.status(f.devicePrincipal).subscribed, false)
})

test("idle session expiry revokes consent without refreshing its activity", async t => {
  const f = await fixture(t, 40)
  f.host.push.subscribe(f.sessionPrincipal, consent())
  await new Promise(resolve => setTimeout(resolve, 70))
  assert.equal(f.host.push.status(f.sessionPrincipal).subscribed, false)
})

test("host restart preserves VAPID/device consent and drops password-session bindings", async t => {
  const f = await fixture(t)
  f.host.push.subscribe(f.sessionPrincipal, consent())
  f.host.push.subscribe(f.devicePrincipal, consent())
  const publicKey = f.host.push.status(f.devicePrincipal).publicKey
  f.host.release()
  const restarted = acquirePushHost(f)
  t.after(restarted.release)
  assert.equal(restarted.push.status(f.sessionPrincipal).subscribed, false)
  assert.equal(restarted.push.status(f.devicePrincipal).subscribed, true)
  assert.equal(restarted.push.status(f.devicePrincipal).publicKey, publicKey)
})

test("restart waits for listener origins before revalidating persisted HTTPS consent", async t => {
  const f = await fixture(t)
  f.host.push.subscribe(f.devicePrincipal, consent())
  const file = path.join(path.dirname(f.settings.configYamlPathForAuthority()), "web-push.json")
  const before = fs.readFileSync(file, "utf8")
  f.host.release()
  f.setReady(false)
  const restarted = acquirePushHost(f)
  t.after(restarted.release)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(fs.readFileSync(file, "utf8"), before)
  f.setReady(true)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(restarted.push.status(f.devicePrincipal).subscribed, true)
})

test("a genuinely revoked HTTPS device is removed after listener authority is ready", async t => {
  const f = await fixture(t)
  f.host.push.subscribe(f.devicePrincipal, consent())
  f.host.release()
  f.remoteControlManager.revokeDevice(f.devicePrincipal.id.slice(14))
  f.setReady(false)
  const restarted = acquirePushHost(f)
  t.after(restarted.release)
  f.setReady(true)
  restarted.push.status(f.devicePrincipal)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(restarted.push.status(f.devicePrincipal).subscribed, false)
  const file = path.join(path.dirname(f.settings.configYamlPathForAuthority()), "web-push.json")
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).entries, [])
})

test("dormant push performs no storage reads and device logout stays revoked across restart", async t => {
  const f = await fixture(t)
  f.host.push.subscribe(f.devicePrincipal, consent())
  f.host.release()
  f.settings.mergePatchOwner("config", "ui", { settings: { multiBackend: false } })
  const file = path.join(path.dirname(f.settings.configYamlPathForAuthority()), "web-push.json")
  const bytes = fs.readFileSync(file, "utf8"), read = fs.readFileSync
  let reads = 0
  const mock = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === file) reads++
    return read(...args)
  })
  const dormant = acquirePushHost(f)
  t.after(dormant.release)
  assert.equal(dormant.push.status(f.devicePrincipal).enabled, false)
  const app = Fastify()
  app.addHook("onRequest", async (request, reply) => { gateRemoteRequest(request, reply, f.remoteControlManager.gate()) })
  registerAuthRoutes(app, { authManager: f.authManager })
  const url = await app.listen({ host: "127.0.0.1", port: 0 })
  t.after(() => app.close())
  assert.equal((await fetch(`${url}/api/auth/logout`, { method: "POST", headers: {
    host: new URL(origin).host, origin, cookie: `${DEVICE_COOKIE_NAME}=${f.deviceToken}`,
  } })).status, 200)
  assert.equal(reads, 0)
  dormant.release()
  mock.mock.restore()
  assert.equal(fs.readFileSync(file, "utf8"), bytes)
  f.settings.mergePatchOwner("config", "ui", { settings: { multiBackend: true } })
  const restarted = acquirePushHost(f)
  t.after(restarted.release)
  assert.equal(restarted.push.status(f.devicePrincipal).subscribed, false)
})
