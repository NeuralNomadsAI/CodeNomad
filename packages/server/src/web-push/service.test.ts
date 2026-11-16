import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PushService, type PushPrincipal } from "./service"

const principal: PushPrincipal = { id: "session-secret-sentinel", channel: "https", origin: "https://code.example" }
const subscription = { endpoint: "https://fcm.googleapis.com/push/test", keys: {
  p256dh: "BILWILj62sY38jRqmiVZcNS2nmUX_8y4l0Z8tTLCjI7Z9_Kb8x2F8Ur9R8FhR5x8hQxEhnnP9hP0wAAAKiJeYHk",
  auth: Buffer.alloc(16).toString("base64url"),
} }
function fixture(t: any, overrides: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-service-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const sends: any[] = []
  const options = { file: path.join(dir, "push.json"), enabled: () => true,
    authority: () => "active" as const, projects: () => ["project"], validate: (s: any) => s,
    keys: () => ({ publicKey: "public", privateKey: "private-key-sentinel" }),
    send: async (...args: any[]) => { sends.push(args); return { status: 201 } }, ...overrides }
  const push = new PushService(options as any)
  t.after(() => push.close())
  return { push, sends, options }
}
const consent = (endpoint = subscription.endpoint) => ({ subscription: { ...subscription, endpoint },
  projects: ["project"], preferences: { v: 1 as const, needsInput: true, sessionDone: false } })
const event = { key: "event-1", category: "needsInput" as const, instanceId: "project", sessionId: "session-name-sentinel" }

test("consent persists private keys and hashed owner; dedupe is per event and subscription", async t => {
  const { push, sends, options } = fixture(t)
  assert.deepEqual(push.status(principal), { enabled: true, subscribed: false })
  push.subscribe(principal, consent())
  push.subscribe(principal, consent("https://fcm.googleapis.com/push/second"))
  await Promise.all([push.publish(event), push.publish(event)])
  assert.equal(sends.length, 2)
  const payload = JSON.parse(sends[0][1])
  assert.deepEqual(Object.keys(payload).sort(), ["body", "expiresAt", "notificationId", "route", "title", "v"])
  assert.equal(JSON.stringify(payload).includes("sentinel"), false)
  assert.deepEqual(await push.resolve(principal, payload.route), { instanceId: "project", sessionId: "session-name-sentinel" })
  assert.equal(await push.resolve({ ...principal, id: "other" }, payload.route), undefined)
  const stored = fs.readFileSync(options.file, "utf8")
  assert.equal(stored.includes(principal.id), false)
  assert.equal(stored.includes("private-key-sentinel"), true)
  if (process.platform !== "win32") assert.equal(fs.statSync(options.file).mode & 0o777, 0o600)
  await push.publish({ ...event, key: "done", category: "sessionDone" })
  assert.equal(sends.length, 2)
})

test("policy and revocation fence queued work and abort active sends", async t => {
  let enabled = true
  let release!: () => void
  const active: AbortSignal[] = []
  const { push } = fixture(t, { enabled: () => enabled,
    send: async (_s: unknown, _p: unknown, _k: unknown, signal: AbortSignal) => {
      active.push(signal); await new Promise<void>(r => { release = r }); return { status: 201 }
    } })
  push.subscribe(principal, consent())
  const pending = push.publish(event)
  await new Promise(r => setImmediate(r))
  assert.equal(active.length, 1)
  push.revoke(principal.id)
  assert.equal(active[0].aborted, true)
  release()
  await pending
  enabled = false
  assert.throws(() => push.subscribe(principal, consent()), /disabled/)
  await push.publish({ ...event, key: "next" })
  assert.equal(active.length, 1)
})

test("restart drops sessions; gone subscriptions purge; suspended tunnel retains consent", async t => {
  let authority = "active"
  const { push, options } = fixture(t, { authority: () => authority, send: async () => ({ status: 410 }) })
  push.subscribe(principal, consent())
  push.close()
  const restarted = new PushService(options as any)
  t.after(() => restarted.close())
  assert.equal(restarted.status(principal).subscribed, false)
  const device: PushPrincipal = { id: "remote-device:device", channel: "tunnel", origin: "https://tunnel.example" }
  restarted.subscribe(device, consent())
  authority = "suspended"
  await restarted.publish(event)
  assert.equal(restarted.status(device).subscribed, true)
  authority = "active"
  await restarted.publish({ ...event, key: "next" })
  assert.equal(restarted.status(device).subscribed, false)
})

test("four-send concurrency bound; revoked queued subscriptions never dispatch", async t => {
  let calls = 0
  const signals: AbortSignal[] = []
  const { push } = fixture(t, { send: async (_s: unknown, _p: unknown, _k: unknown, signal: AbortSignal) => {
    calls++; signals.push(signal)
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
    return { status: 201 }
  } })
  for (let i = 0; i < 8; i++) push.subscribe(principal, consent(`https://fcm.googleapis.com/push/${i}`))
  const pending = push.publish(event)
  await new Promise(r => setImmediate(r))
  assert.equal(calls, 4)
  push.unsubscribe(principal)
  await pending
  assert.equal(calls, 4)
  assert.equal(signals.every(s => s.aborted), true)
})

test("late 410 cannot remove replacement consent; routes expire and keys initialize only after consent", async t => {
  let release!: () => void
  const { push } = fixture(t, { send: async () => {
    await new Promise<void>(r => { release = r }); return { status: 410 }
  } })
  assert.equal(push.status(principal).publicKey, undefined)
  assert.deepEqual(push.consent(principal), { publicKey: "public" })
  push.subscribe(principal, consent())
  const pending = push.publish(event)
  await new Promise(r => setImmediate(r))
  push.subscribe(principal, consent())
  release(); await pending
  assert.equal(push.status(principal).subscribed, true)
})

test("queued work past five-minute expiry and other owners never delivers", async t => {
  let now = Date.now(), calls = 0
  t.mock.method(Date, "now", () => now)
  const releases: (() => void)[] = []
  const { push } = fixture(t, { send: async () => {
    calls++; await new Promise<void>(r => releases.push(r)); return { status: 201 }
  } })
  for (let i = 0; i < 8; i++) push.subscribe(principal, consent(`https://fcm.googleapis.com/push/${i}`))
  assert.throws(() => push.subscribe({ ...principal, id: "other" }, consent("https://fcm.googleapis.com/push/0")), /owned/)
  const pending = push.publish(event)
  await new Promise(r => setImmediate(r))
  now += 300_001
  releases.forEach(r => r())
  await pending
  assert.equal(calls, 4)
})

test("unreadable private storage fails closed rather than replacing it", t => {
  const { options, push } = fixture(t)
  push.consent(principal); push.close()
  fs.writeFileSync(options.file, "invalid private storage")
  const unavailable = new PushService(options as any)
  t.after(() => unavailable.close())
  assert.equal(unavailable.status(principal).enabled, false)
  assert.throws(() => unavailable.consent(principal), /storage unavailable/)
  assert.equal(fs.readFileSync(options.file, "utf8"), "invalid private storage")
})

test("password epoch prevents device-consent resurrection when purge persistence fails", t => {
  let epoch = "password-one"
  const { options, push } = fixture(t, { epoch: () => epoch })
  const device: PushPrincipal = { id: "remote-device:device", channel: "https", origin: principal.origin }
  push.subscribe(device, consent())
  const publicKey = push.status(device).publicKey
  epoch = "password-two"
  const mock = t.mock.method(fs, "renameSync", () => { throw new Error("Disk full") })
  assert.throws(() => push.revoke(), /Disk full/)
  assert.equal(push.status(device).subscribed, false)
  mock.mock.restore()
  push.close()
  const restarted = new PushService(options as any)
  t.after(() => restarted.close())
  assert.equal(restarted.status(device).subscribed, false)
  assert.equal(restarted.status(device).publicKey, publicKey)
})

test("opaque route revalidates session/location and fences revocation during the lookup", async t => {
  let qualify = true, release: (() => void) | undefined
  const { push, sends } = fixture(t, { qualifyRoute: async () => {
    if (release) await new Promise<void>(r => { release = r })
    return qualify
  } })
  push.subscribe(principal, consent())
  await push.publish(event)
  const token = JSON.parse(sends[0][1]).route
  assert.ok(await push.resolve(principal, token))
  qualify = false
  assert.equal(await push.resolve(principal, token), undefined)
  qualify = true
  release = () => {}
  const resolving = push.resolve(principal, token)
  push.unsubscribe(principal)
  release()
  assert.equal(await resolving, undefined)
})

test("Stop epoch prevents tunnel-consent resurrection after Start despite failed purge", t => {
  let epoch = "tunnel-generation-one"
  const { options, push } = fixture(t, { channelEpoch: () => epoch })
  const device: PushPrincipal = { id: "remote-device:device", channel: "tunnel", origin: "https://tunnel.example" }
  push.subscribe(device, consent())
  epoch = "tunnel-generation-two"
  const mock = t.mock.method(fs, "renameSync", () => { throw new Error("Disk full") })
  assert.throws(() => push.revoke(undefined, "tunnel"), /Disk full/)
  mock.mock.restore()
  push.close()
  const restarted = new PushService(options as any)
  t.after(() => restarted.close())
  assert.equal(restarted.status(device).subscribed, false)
})
