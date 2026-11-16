import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { AuthManager } from "../../auth/manager"
import { createLogger } from "../../logger"
import { RemoteDeviceRegistry } from "../../remote-control/devices"
import { verifiedDirectHttpsOrigin } from "../../remote-control/direct-https"
import { DEVICE_COOKIE_NAME, gateRemoteRequest } from "../../remote-control/gate"
import { RemoteControlManager } from "../../remote-control/manager"
import { PushInputError, PushService, type PushPrincipal } from "../../web-push/service"
import type { PushSubscription } from "../../web-push/transport"
import { registerPushRoutes } from "./push"
import { registerAuthRoutes } from "./auth"

const origin = "https://code.example.test"
const tunnelOrigin = "https://push.device.tunnel.test"
const logger = createLogger({ level: "silent" } as never)
const body = { subscription: { endpoint: "https://push.example.test/send", keys: { p256dh: "key", auth: "auth" } },
  projects: ["project"], preferences: { v: 1, needsInput: true, sessionDone: false } }

async function fixture(t: test.TestContext, skipAuth = false, realPush = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-push-routes-"))
  const auth = new AuthManager({ configPath: path.join(directory, "config.yaml"), username: "user",
    generateToken: true, dangerouslySkipAuth: skipAuth }, logger)
  const app = Fastify()
  let ingress = "", multiBackend = true
  let failTunnel!: (error: string) => void
  const remoteControl = new RemoteControlManager({
    registry: new RemoteDeviceRegistry(path.join(directory, "devices.json")), logger,
    directHttpsOrigins: () => [origin],
    router: () => (request, response) => { app.server.emit("request", request, response) },
    openTunnel: async ({ target }) => {
      ingress = `http://${target}`
      return { url: tunnelOrigin, hostname: new URL(tunnelOrigin).host,
        status: () => ({ state: "connected", connections: 0 }),
        closed: new Promise<string>((resolve) => { failTunnel = resolve }), close: async () => {} }
    },
  })
  const calls: Array<{ method: string; principal: unknown; value?: unknown }> = []
  const pushMock = {
    consent(principal: unknown) { calls.push({ method: "consent", principal }); return { publicKey: "public" } },
    status(principal: unknown) { calls.push({ method: "status", principal }); return { enabled: true, subscribed: true, publicKey: "public" } },
    subscribe(principal: unknown, value: unknown) { calls.push({ method: "subscribe", principal, value }); return { publicKey: "public" } },
    unsubscribe(principal: unknown) { calls.push({ method: "unsubscribe", principal }) },
    async resolve(principal: unknown, token: string) {
      calls.push({ method: "resolve", principal, value: token })
      return token === "owned-token" ? { instanceId: "project", sessionId: "session" } : undefined
    },
  }
  const push = realPush ? new PushService({
    file: path.join(directory, "push.json"), enabled: () => multiBackend, projects: () => ["project"],
    channelEpoch: (principal) => principal.channel === "tunnel" ? remoteControl.tunnelPushEpoch() : "",
    authority: (principal) => principal.id.startsWith("remote-device:")
      ? remoteControl.pushAuthority(principal.id.slice(14), principal.channel, principal.origin)
      : auth.isSessionValid(principal.id) ? "active" : "revoked",
    validate: (subscription) => subscription as PushSubscription,
    keys: () => ({ publicKey: "public", privateKey: "private" }),
  }) : pushMock
  if (push instanceof PushService) {
    const passwordOff = auth.onPasswordChanged(() => push.revoke())
    const logoutOff = auth.onPrincipalLoggedOut((id) => push.revoke(id))
    const deviceOff = remoteControl.onPushRevoked((id, channel) => push.revoke(id ?? undefined, channel))
    t.after(() => { passwordOff(); logoutOff(); deviceOff(); push.close() })
  }
  app.addHook("onRequest", async (request, reply) => { gateRemoteRequest(request, reply, remoteControl.gate()) })
  registerPushRoutes(app, { push, auth, remoteControl,
    httpsOrigin: (request) => verifiedDirectHttpsOrigin(request, [origin]), multiBackend: () => multiBackend })
  registerAuthRoutes(app, { authManager: auth })
  const local = await app.listen({ host: "127.0.0.1", port: 0 })
  t.after(async () => {
    await remoteControl.shutdown()
    await app.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const cookie = `${auth.getCookieName()}=${auth.createSession("user").id}`
  const request = (url: string, route: string, method = "GET", headers: Record<string, string> = {}, value?: unknown) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }>((resolve, reject) => {
      const req = http.request(new URL(route, url), { method, headers: { connection: "close", ...headers,
        ...(value === undefined ? {} : { "content-type": "application/json" }) } }, (response) => {
        let text = ""
        response.setEncoding("utf8").on("data", (chunk) => { text += chunk })
        response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: text ? JSON.parse(text) : null }))
      })
      req.on("error", reject)
      req.end(value === undefined ? undefined : JSON.stringify(value))
    })
  return { auth, directory, remoteControl, push, calls, cookie, local, request, ingress: () => ingress,
    disable: () => { multiBackend = false }, failTunnel: () => failTunnel("temporary outage") }
}

test("HTTPS push APIs use the authenticated principal and disable caching", async (t) => {
  const f = await fixture(t)
  const headers = { host: new URL(origin).host, origin, cookie: f.cookie }
  const principal = { id: f.cookie.split("=")[1], channel: "https", origin }
  await f.request(f.local, "/api/push/status", "GET", headers)
  assert.deepEqual(f.calls.map((call) => call.method), ["status"])
  const consent = await f.request(f.local, "/api/push/subscription", "PUT", headers, { consent: true })
  assert.equal(consent.status, 200)
  assert.deepEqual(consent.body, { publicKey: "public" })
  for (const [route, method, value] of [
    ["/api/push/status", "GET"], ["/api/push/subscription", "PUT", body],
    ["/api/push/routes/owned-token", "GET"], ["/api/push/subscription", "DELETE"],
  ] as const) {
    const response = await f.request(f.local, route, method, headers, value)
    assert.equal(response.status, method === "DELETE" ? 204 : 200)
    assert.equal(response.headers["cache-control"], "no-store")
  }
  assert(f.calls.every((call) => JSON.stringify(call.principal) === JSON.stringify(principal)))
  assert.deepEqual(f.calls.find((call) => call.method === "subscribe")?.value, body)
  assert.equal((await f.request(f.local, "/api/push/routes/unknown", "GET", headers)).status, 404)
  assert.equal((await f.request(f.local, "/api/push/subscription", "PUT", headers, { ...body, preferences: { v: 2 } })).status, 400)
  assert.equal((await f.request(f.local, "/api/push/subscription", "PUT", headers, { consent: false })).status, 400)
})

test("push refuses missing authentication, HTTP, explicit server protocol and disabled capability", async (t) => {
  const f = await fixture(t)
  const good = { host: new URL(origin).host, origin, cookie: f.cookie }
  assert.equal((await f.request(f.local, "/api/push/status", "GET", { ...good, cookie: "" })).status, 401)
  assert.equal((await f.request(f.local, "/api/push/status", "GET", { cookie: f.cookie, origin: "http://lan.test" })).status, 403)
  assert.equal((await f.request(f.local, "/api/push/status", "GET", { ...good, "x-codenomad-server-request": "1" })).status >= 400, true)
  f.disable()
  assert.equal((await f.request(f.local, "/api/push/status", "GET", good)).status, 404)
  assert.equal(f.calls.length, 0)
  const skipped = await fixture(t, true)
  assert.equal((await skipped.request(skipped.local, "/api/push/status", "GET", good)).status, 403)
})

test("physical tunnel ingress and direct HTTPS devices retain their distinct principals", async (t) => {
  const f = await fixture(t)
  const started = await f.remoteControl.start()
  const tunnel = f.remoteControl.exchangePairing(new URL(started.pairing.url).hash.slice(1), undefined)!
  const tunnelHeaders = { host: new URL(tunnelOrigin).host, origin: tunnelOrigin, cookie: `${DEVICE_COOKIE_NAME}=${tunnel.token}` }
  assert.equal((await f.request(f.ingress(), "/api/push/subscription", "PUT", tunnelHeaders, body)).status, 200)
  assert.deepEqual(f.calls[0].principal, { id: `remote-device:${tunnel.device.id}`, channel: "tunnel", origin: tunnelOrigin })
  assert.equal((await f.request(f.ingress(), "/api/push/status", "GET", { ...tunnelHeaders, origin })).status, 403)
  const pairing = f.remoteControl.createDirectPairing(origin)
  const direct = f.remoteControl.exchangeDirectPairing(new URL(pairing.url).hash.slice(1), origin, undefined)!
  const directHeaders = { host: new URL(origin).host, origin, cookie: `${DEVICE_COOKIE_NAME}=${direct.token}` }
  assert.equal((await f.request(f.local, "/api/push/status", "GET", directHeaders)).status, 200)
  assert.deepEqual(f.calls.at(-1)?.principal, { id: `remote-device:${direct.device.id}`, channel: "https", origin })
})

test("paired devices retain push authority when shared password authentication is skipped", async (t) => {
  const f = await fixture(t, true)
  const started = await f.remoteControl.start()
  const tunnel = f.remoteControl.exchangePairing(new URL(started.pairing.url).hash.slice(1), undefined)!
  const tunnelHeaders = { host: new URL(tunnelOrigin).host, origin: tunnelOrigin, cookie: `${DEVICE_COOKIE_NAME}=${tunnel.token}` }
  assert.equal((await f.request(f.ingress(), "/api/push/subscription", "PUT", tunnelHeaders, { consent: true })).status, 200)
  const pairing = f.remoteControl.createDirectPairing(origin)
  const direct = f.remoteControl.exchangeDirectPairing(new URL(pairing.url).hash.slice(1), origin, undefined)!
  const headers = { host: new URL(origin).host, origin, cookie: `${DEVICE_COOKIE_NAME}=${direct.token}` }
  assert.equal((await f.request(f.local, "/api/push/subscription", "PUT", headers, body)).status, 200)
  assert(f.calls.every((call) => (call.principal as PushPrincipal).id.startsWith("remote-device:")))
  assert.equal((await f.request(f.local, "/api/push/subscription", "PUT", { host: new URL(origin).host, origin }, { consent: true })).status, 403)
})

test("disabled policy and service failures have stable sanitized HTTP responses", async (t) => {
  const f = await fixture(t)
  const headers = { host: new URL(origin).host, origin, cookie: f.cookie }
  f.push.status = () => ({ enabled: false, subscribed: false, publicKey: "public" })
  for (const value of [{ consent: true }, body]) {
    const response = await f.request(f.local, "/api/push/subscription", "PUT", headers, value)
    assert.equal(response.status, 403)
    assert.equal(response.body.code, "web_push_disabled")
  }
  f.push.status = () => ({ enabled: true, subscribed: false, publicKey: "public" })
  f.push.subscribe = () => { throw new PushInputError("private-input-sentinel") }
  const invalid = await f.request(f.local, "/api/push/subscription", "PUT", headers, body)
  assert.equal(invalid.status, 400)
  assert.deepEqual(invalid.body, { error: "Invalid push subscription" })
  f.push.consent = () => { throw new Error("private-storage-sentinel") }
  const failed = await f.request(f.local, "/api/push/subscription", "PUT", headers, { consent: true })
  assert.equal(failed.status, 503)
  assert.deepEqual(failed.body, { error: "Push storage unavailable" })
})

test("real push consent hooks purge devices on password change, isolate Stop and preserve transient suspension", async (t) => {
  const f = await fixture(t, false, true)
  const push = f.push as PushService
  const started = await f.remoteControl.start()
  const tunnelDevice = f.remoteControl.exchangePairing(new URL(started.pairing.url).hash.slice(1), undefined)!
  const directPairing = f.remoteControl.createDirectPairing(origin)
  const directDevice = f.remoteControl.exchangeDirectPairing(new URL(directPairing.url).hash.slice(1), origin, undefined)!
  const tunnel: PushPrincipal = { id: `remote-device:${tunnelDevice.device.id}`, channel: "tunnel", origin: tunnelOrigin }
  const direct: PushPrincipal = { id: `remote-device:${directDevice.device.id}`, channel: "https", origin }
  const session: PushPrincipal = { id: f.cookie.split("=")[1], channel: "https", origin }
  const subscribe = (principal: PushPrincipal, suffix: string) =>
    push.subscribe(principal, { ...body, subscription: { ...body.subscription, endpoint: `${body.subscription.endpoint}/${suffix}` } })
  subscribe(tunnel, "tunnel")
  subscribe(direct, "direct")
  subscribe(session, "session")
  await f.remoteControl.stop()
  assert.equal(push.status(tunnel).subscribed, false)
  assert.equal(push.status(direct).subscribed, true)
  assert.equal(push.status(session).subscribed, true)
  assert.equal(f.remoteControl.pushAuthority(tunnelDevice.device.id, "tunnel", tunnelOrigin), "revoked")
  await f.remoteControl.start()
  subscribe(tunnel, "tunnel")
  f.failTunnel()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.remoteControl.pushAuthority(tunnelDevice.device.id, "tunnel", tunnelOrigin), "suspended")
  assert.equal(push.status(tunnel).subscribed, true)
  assert.equal(push.status(direct).subscribed, true)
  await f.auth.setPassword("replace-password")
  for (const principal of [session, direct, tunnel]) assert.equal(push.status(principal).subscribed, false)
})

test("direct-device logout purges only its push consent without revoking device authentication", async (t) => {
  const f = await fixture(t, false, true)
  const push = f.push as PushService
  const pairing = f.remoteControl.createDirectPairing(origin)
  const device = f.remoteControl.exchangeDirectPairing(new URL(pairing.url).hash.slice(1), origin, undefined)!
  const principal: PushPrincipal = { id: `remote-device:${device.device.id}`, channel: "https", origin }
  const session: PushPrincipal = { id: f.cookie.split("=")[1], channel: "https", origin }
  push.subscribe(session, { ...body, subscription: { ...body.subscription, endpoint: `${body.subscription.endpoint}/session` } })
  const headers = { host: new URL(origin).host, origin, cookie: `${DEVICE_COOKIE_NAME}=${device.token}` }
  assert.equal((await f.request(f.local, "/api/push/subscription", "PUT", headers, body)).status, 200)
  assert.equal(push.status(principal).subscribed, true)
  const loggedOut: string[] = []
  const off = f.auth.onPrincipalLoggedOut((id) => loggedOut.push(id))
  const response = await f.request(f.local, "/api/auth/logout", "POST", headers)
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { ok: true })
  assert.deepEqual(response.headers["set-cookie"], [`${DEVICE_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`])
  assert.deepEqual(loggedOut, [principal.id])
  assert.equal(push.status(principal).subscribed, false)
  assert.equal(push.status(session).subscribed, true)
  assert.equal(f.remoteControl.isDeviceAuthorized(device.device.id), true)
  assert.equal((await f.request(f.local, "/api/push/status", "GET", headers)).status, 200)
  off()
  const localLogout = await f.request(f.local, "/api/auth/logout", "POST", { ...headers, cookie: f.cookie })
  assert.equal(localLogout.status, 200)
  assert(localLogout.headers["set-cookie"]?.[0].startsWith(`${f.auth.getCookieName()}=;`))
  assert.deepEqual(loggedOut, [principal.id])
  assert.equal(push.status(session).subscribed, false)
})

test("tunnel-device logout clears its secure device cookie and revokes push before responding", async (t) => {
  const f = await fixture(t, false, true)
  const push = f.push as PushService
  const started = await f.remoteControl.start()
  const device = f.remoteControl.exchangePairing(new URL(started.pairing.url).hash.slice(1), undefined)!
  const principal: PushPrincipal = { id: `remote-device:${device.device.id}`, channel: "tunnel", origin: tunnelOrigin }
  const headers = { host: new URL(tunnelOrigin).host, origin: tunnelOrigin, cookie: `${DEVICE_COOKIE_NAME}=${device.token}` }
  assert.equal((await f.request(f.ingress(), "/api/push/subscription", "PUT", headers, body)).status, 200)
  assert.equal(push.status(principal).subscribed, true)
  const response = await f.request(f.ingress(), "/api/auth/logout", "POST", headers)
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { ok: true })
  assert.deepEqual(response.headers["set-cookie"], [`${DEVICE_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`])
  assert.equal(push.status(principal).subscribed, false)
  assert.equal(f.remoteControl.isDeviceAuthorized(device.device.id), true)
})

test("device logout refuses success when a push purge fails and still invokes every observer", async (t) => {
  const f = await fixture(t, false, true)
  const push = f.push as PushService
  const pairing = f.remoteControl.createDirectPairing(origin)
  const device = f.remoteControl.exchangeDirectPairing(new URL(pairing.url).hash.slice(1), origin, undefined)!
  const principal: PushPrincipal = { id: `remote-device:${device.device.id}`, channel: "https", origin }
  push.subscribe(principal, body)
  const original = push.revoke
  push.revoke = () => { throw new Error("private-storage-path-sentinel") }
  t.after(() => { push.revoke = original })
  const seen: string[] = []
  f.auth.onPrincipalLoggedOut((id) => seen.push(id))
  const headers = { host: new URL(origin).host, origin, cookie: `${DEVICE_COOKIE_NAME}=${device.token}` }
  const response = await f.request(f.local, "/api/auth/logout", "POST", headers)
  assert.equal(response.status, 503)
  assert.deepEqual(response.body, { error: "Logout unavailable" })
  assert.equal(response.headers["set-cookie"], undefined)
  assert.deepEqual(seen, [principal.id])
  assert.equal(push.status(principal).subscribed, true)
})

test("push credential epoch follows persisted password identity across restart and purge failure", async (t) => {
  const f = await fixture(t)
  const before = f.auth.pushCredentialEpoch()
  assert.match(before, /^[a-f0-9]{64}$/)
  f.auth.onPasswordChanged(() => { throw new Error("push purge failed") })
  await f.auth.setPassword("replacement-password")
  const after = f.auth.pushCredentialEpoch()
  assert.notEqual(after, before)
  assert.equal(f.auth.pushCredentialEpoch(), after)
  const restarted = new AuthManager({ configPath: path.join(f.directory, "config.yaml"), username: "user", generateToken: true }, logger)
  assert.equal(restarted.pushCredentialEpoch(), after)
})

test("runtime password push epoch is stable across restart with the host salt and isolated by password or host", async (t) => {
  const f = await fixture(t)
  const manager = (password: string) => new AuthManager({
    configPath: path.join(f.directory, "config.yaml"), username: "user", password, generateToken: true,
  }, logger)
  const first = manager(" runtime-password ")
  const restarted = manager("runtime-password")
  const different = manager("different-password")
  const salt = "durable-public-vapid-key"
  const epoch = first.pushCredentialEpoch(salt)
  assert.match(epoch, /^[a-f0-9]{64}$/)
  assert.equal(restarted.pushCredentialEpoch(salt), epoch)
  assert.notEqual(different.pushCredentialEpoch(salt), epoch)
  assert.equal(first.pushCredentialEpoch(salt), epoch)
  assert.equal(first.pushCredentialEpoch(salt), epoch)
  assert.notEqual(first.pushCredentialEpoch("different-host-vapid-key"), epoch)
  assert.equal(first.pushCredentialEpoch(salt), epoch)
})

test("Stop epoch survives failed push purge, Start and restart without removing HTTPS consent", async (t) => {
  const f = await fixture(t, false, true)
  const push = f.push as PushService
  const started = await f.remoteControl.start()
  const device = f.remoteControl.exchangePairing(new URL(started.pairing.url).hash.slice(1), undefined)!
  const pairing = f.remoteControl.createDirectPairing(origin)
  const directDevice = f.remoteControl.exchangeDirectPairing(new URL(pairing.url).hash.slice(1), origin, undefined)!
  const tunnel: PushPrincipal = { id: `remote-device:${device.device.id}`, channel: "tunnel", origin: tunnelOrigin }
  const direct: PushPrincipal = { id: `remote-device:${directDevice.device.id}`, channel: "https", origin }
  push.subscribe(tunnel, body)
  push.subscribe(direct, { ...body, subscription: { ...body.subscription, endpoint: `${body.subscription.endpoint}/direct` } })
  const before = f.remoteControl.tunnelPushEpoch()
  const original = push.revoke
  push.revoke = () => { throw new Error("push purge failed") }
  t.after(() => { push.revoke = original })
  await f.remoteControl.stop()
  const stopped = f.remoteControl.tunnelPushEpoch()
  assert.notEqual(stopped, before)
  const registryFile = path.join(f.directory, "devices.json")
  const stoppedState = JSON.parse(fs.readFileSync(registryFile, "utf8"))
  assert.equal(stoppedState.enabled, false)
  assert.equal(stoppedState.tunnelPushEpoch, stopped)
  push.close()
  await f.remoteControl.start()
  const registry = new RemoteDeviceRegistry(registryFile)
  assert.equal(registry.startsOnLaunch(), true)
  assert.equal(registry.tunnelPushEpoch(), stopped)
  const restarted = new PushService({
    file: path.join(f.directory, "push.json"), enabled: () => true, projects: () => ["project"],
    authority: (principal) => registry.isPaired(principal.id.slice(14), principal.channel === "https" ? principal.origin : undefined) ? "active" : "revoked",
    channelEpoch: (principal) => principal.channel === "tunnel" ? registry.tunnelPushEpoch() : "",
    validate: (subscription) => subscription as PushSubscription,
  })
  t.after(() => restarted.close())
  assert.equal(restarted.status(tunnel).subscribed, false)
  assert.equal(restarted.status(direct).subscribed, true)
})

test("registry tunnel push epochs default empty, rotate on every Stop and reject malformed persisted values", async (t) => {
  const f = await fixture(t)
  const file = path.join(f.directory, "epoch-registry.json")
  const registry = new RemoteDeviceRegistry(file)
  assert.equal(registry.tunnelPushEpoch(), "")
  assert.equal(fs.existsSync(file), false)
  registry.setStartsOnLaunch(true)
  registry.setStartsOnLaunch(false)
  const first = registry.tunnelPushEpoch()
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(new RemoteDeviceRegistry(file).tunnelPushEpoch(), first)
  registry.setStartsOnLaunch(false)
  assert.notEqual(registry.tunnelPushEpoch(), first)
  const valid = JSON.parse(fs.readFileSync(file, "utf8"))
  for (const invalid of ["", "not-a-uuid", 1, null]) {
    fs.writeFileSync(file, JSON.stringify({ ...valid, tunnelPushEpoch: invalid }))
    const refused = new RemoteDeviceRegistry(file)
    assert.equal(refused.tunnelPushEpoch(), "")
    assert.notEqual(refused.route(), valid.route)
  }
})

test("push revocation observers distinguish explicit stop, device removal, eviction and shutdown", async (t) => {
  const f = await fixture(t)
  const revoked: Array<[string | null, "tunnel" | undefined]> = []
  const off = f.remoteControl.onPushRevoked((id, channel) => revoked.push([id, channel]))
  const started = await f.remoteControl.start()
  const tunnel = f.remoteControl.exchangePairing(new URL(started.pairing.url).hash.slice(1), undefined)!
  assert.equal(f.remoteControl.pushAuthority(tunnel.device.id, "tunnel", tunnelOrigin), "active")
  const restarting = new RemoteControlManager({
    registry: new RemoteDeviceRegistry(path.join(f.directory, "devices.json")),
    logger, router: () => null,
  })
  assert.equal(restarting.pushAuthority(tunnel.device.id, "tunnel", tunnelOrigin), "suspended")
  const pairing = f.remoteControl.createDirectPairing(origin)
  const device = f.remoteControl.exchangeDirectPairing(new URL(pairing.url).hash.slice(1), origin, undefined)!
  assert.equal(f.remoteControl.pushAuthority(device.device.id, "https", origin), "active")
  assert.equal(f.remoteControl.pushAuthority(device.device.id, "https", "https://other.test"), "revoked")
  f.remoteControl.revokeDevice(device.device.id)
  assert.deepEqual(revoked, [[device.device.id, undefined]])
  for (let i = 0; i < 33; i++) {
    const pairing = f.remoteControl.createDirectPairing(origin)
    f.remoteControl.exchangeDirectPairing(new URL(pairing.url).hash.slice(1), origin, undefined)
  }
  assert.equal(revoked.length, 3)
  await f.remoteControl.stop()
  assert.deepEqual(revoked.at(-1), [null, "tunnel"])
  await f.remoteControl.start()
  const latestPairing = f.remoteControl.createPairing()
  const latest = f.remoteControl.exchangePairing(new URL(latestPairing.url).hash.slice(1), undefined)!
  f.failTunnel()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.remoteControl.pushAuthority(latest.device.id, "tunnel", tunnelOrigin), "suspended")
  const count = revoked.length
  await f.remoteControl.shutdown()
  assert.equal(revoked.length, count)
  off()
})

test("password observers run after persistence and before session revocation; validity does not refresh idle expiry", async (t) => {
  const f = await fixture(t)
  const session = f.auth.createSession("user")
  let observed = 0
  let persisted = false, validDuringNotification = false
  const off = f.auth.onPasswordChanged(() => {
    observed++
    persisted = fs.existsSync(path.join(f.directory, "auth.json"))
    validDuringNotification = f.auth.isSessionValid(session.id)
  })
  await f.auth.setPassword("a-new-password")
  assert.equal(observed, 1)
  assert.equal(persisted, true)
  assert.equal(validDuringNotification, true)
  assert.equal(f.auth.isSessionValid(session.id), false)
  off()
  const expiring = f.auth.createSession("user")
  const now = Date.now
  const created = now()
  Date.now = () => created + 23 * 60 * 60 * 1000
  try {
    assert.equal(f.auth.isSessionValid(expiring.id), true)
    Date.now = () => created + 25 * 60 * 60 * 1000
    assert.equal(f.auth.isSessionValid(expiring.id), false)
  } finally { Date.now = now }
})
