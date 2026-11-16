import assert from "node:assert/strict"
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto"
import dns from "node:dns"
import https from "node:https"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { once } from "node:events"
import test from "node:test"
import forge from "node-forge"
import { createPushTransport, generateKeys, send, validateSubscription } from "./transport"
import { PushService } from "./service"

const receiver = createECDH("prime256v1")
receiver.generateKeys()
const auth = randomBytes(16)
const subscription = {
  endpoint: "https://fcm.googleapis.com/send/fixture",
  keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
}

test("subscription boundary admits only reviewed HTTPS push services and valid keys", () => {
  for (const host of ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]) {
    assert.equal(new URL(validateSubscription({ ...subscription, endpoint: `https://${host}/x` }).endpoint).hostname, host)
  }
  for (const endpoint of [
    "http://fcm.googleapis.com/x", "https://user:secret@fcm.googleapis.com/x", "https://fcm.googleapis.com/x#secret",
    "https://fcm.googleapis.com/x#", "https://@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "https://fcm.googleapis.com.evil.test/x",
    "https://evil.web.push.apple.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://[::1]/x",
  ]) assert.throws(() => validateSubscription({ ...subscription, endpoint }))
  for (const keys of [{ ...subscription.keys, auth: "bad" }, { ...subscription.keys, p256dh: randomBytes(65).toString("base64url") }]) {
    assert.throws(() => validateSubscription({ ...subscription, keys }))
  }
  assert.throws(() => validateSubscription(null))
})

test("production resolution refuses private answers, aliases and mixed DNS answers before HTTPS", async t => {
  const vapid = generateKeys()
  let dispatches = 0
  t.mock.method(https, "request", () => { dispatches++; throw new Error("Forbidden fixture dispatch") })
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1"]) {
    const mock = t.mock.method(dns.promises, "lookup", async () => [
      { address: "8.8.8.8", family: 4 }, { address, family: address.includes(":") ? 6 : 4 },
    ])
    await assert.rejects(send(subscription, "private", vapid), /destination/i)
    mock.mock.restore()
  }
  assert.equal(dispatches, 0)
})

test("a provider DNS alias resolving through the OS to localhost is refused before HTTPS", async t => {
  const lookup = dns.promises.lookup
  let resolutions = 0
  t.mock.method(dns.promises, "lookup", async (hostname: string) => {
    assert.equal(hostname, "fcm.googleapis.com")
    resolutions++
    return lookup("localhost", { all: true })
  })
  let dispatches = 0
  t.mock.method(https, "request", () => { dispatches++; throw new Error("Forbidden alias dispatch") })
  await assert.rejects(send(subscription, "fixture", generateKeys()), /destination/i)
  assert.equal(resolutions, 1)
  assert.equal(dispatches, 0)
})

function decrypt(body: Buffer): string {
  const salt = body.subarray(0, 16)
  const serverKey = body.subarray(21, 21 + body[20])
  const ciphertext = body.subarray(21 + body[20], -16)
  const derive = (key: Buffer, salt: Buffer, info: Buffer, length: number) =>
    Buffer.from(hkdfSync("sha256", key, salt, info, length))
  const ikm = derive(receiver.computeSecret(serverKey), auth,
    Buffer.concat([Buffer.from("WebPush: info\0"), receiver.getPublicKey(), serverKey]), 32)
  const cek = derive(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16)
  const nonce = derive(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12)
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce)
  decipher.setAuthTag(body.subarray(-16))
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  assert.equal(plain.at(-1), 2)
  return plain.subarray(0, -1).toString("utf8")
}

test("production public DNS is resolved once and pinned, retaining TLS verification", async t => {
  let lookups = 0
  t.mock.method(dns.promises, "lookup", async () => {
    lookups++
    return [{ address: "8.8.8.8", family: 4 }]
  })
  const stopped = new Error("Fixture stopped before external IO")
  t.mock.method(https, "request", (_url: URL, options: https.RequestOptions) => {
    assert.equal(options.servername, "fcm.googleapis.com")
    assert.equal(options.rejectUnauthorized, true)
    assert.equal(options.agent, false)
    assert.equal(options.port, 443)
    options.lookup!("fcm.googleapis.com", { all: true }, (error, addresses) => {
      assert.equal(error, null)
      assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }])
    })
    throw stopped
  })
  await assert.rejects(send(subscription, "fixture", generateKeys()), error => error === stopped)
  assert.equal(lookups, 1)
})

function verifyVapid(authorization: string, publicKey: string, subject: string) {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization)!
  assert.ok(match)
  assert.equal(match[2], publicKey)
  const [header, payload, signature] = match[1].split(".")
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { typ: "JWT", alg: "ES256" })
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString())
  assert.equal(claims.aud, "https://fcm.googleapis.com")
  assert.equal(claims.sub, subject)
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 86400)
  const raw = Buffer.from(publicKey, "base64url")
  const key = createPublicKey({ format: "jwk", key: {
    kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url"),
  } })
  assert.equal(verify("sha256", Buffer.from(`${header}.${payload}`),
    { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")), true)
}

test("real HTTPS decrypts aes128gcm, verifies VAPID, surfaces status/retry and never redirects", async t => {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = "01"
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date(Date.now() + 86_400_000)
  cert.setSubject([{ name: "commonName", value: "fcm.googleapis.com" }])
  cert.setIssuer(cert.subject.attributes)
  cert.setExtensions([{ name: "basicConstraints", cA: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: "fcm.googleapis.com" }] }])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const ca = forge.pki.certificateToPem(cert)
  const vapid = generateKeys()
  let requests = 0
  let status = 201
  let retry = "7"
  let received = ""
  const deliveries: Array<{ payload: string; headers: string; ciphertext: string; endpoint: string }> = []
  let subject = "https://github.com/NeuralNomadsAI/CodeNomad"
  const server = https.createServer({ key: forge.pki.privateKeyToPem(keys.privateKey), cert: ca }, async (req, res) => {
    requests++
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    try {
      assert.equal(req.headers.host, "fcm.googleapis.com")
      assert.equal(req.headers["content-encoding"], "aes128gcm")
      assert.equal(req.headers.ttl, "300")
      assert.ok(Buffer.concat(chunks).length <= 4096)
      assert.equal(req.method, "POST")
      verifyVapid(req.headers.authorization!, vapid.publicKey, subject)
      received = decrypt(Buffer.concat(chunks))
      if (req.url === "/hang") return
      deliveries.push({ payload: received, headers: JSON.stringify(req.headers),
        ciphertext: Buffer.concat(chunks).toString("base64"), endpoint: req.url! })
      res.writeHead(status, { "Retry-After": retry, Location: "https://127.0.0.1/forbidden" })
      res.end("ignored service body")
    } catch (error) { res.destroy(error as Error) }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => { server.closeAllConnections(); server.close() })
  const port = (server.address() as { port: number }).port
  let resolutions = 0
  const resolve = async () => { resolutions++; return { address: "127.0.0.1", family: 4 as const, port } }
  const transport = createPushTransport({ resolve, ca, timeoutMs: 250 })
  assert.deepEqual(await transport.send(subscription, '{"hello":"世界"}', vapid), { status: 201, retryAfterMs: 7000 })
  assert.equal(received, '{"hello":"世界"}')
  assert.equal(resolutions, 1)
  for (status of [301, 404, 410, 429, 503]) {
    assert.equal((await transport.send(subscription, "fixture", vapid)).status, status)
  }
  assert.equal(requests, 6)
  retry = new Date(Date.now() + 30_000).toUTCString()
  const result = await transport.send(subscription, "fixture", vapid)
  assert.ok(result.retryAfterMs! > 28_000 && result.retryAfterMs! <= 30_000)
  retry = "garbage"
  assert.deepEqual(await transport.send(subscription, "", vapid), { status: 503 })
  assert.equal(received, "")
  await transport.send(subscription, "x".repeat(3993), vapid)
  assert.equal(String(received).length, 3993)
  for (subject of ["https://admin.example/contact", "mailto:push-admin@example.com"]) {
    await transport.send(subscription, "override", { ...vapid, subject })
  }
  subject = "https://github.com/NeuralNomadsAI/CodeNomad"
  await assert.rejects(createPushTransport({ resolve }).send(subscription, "untrusted", vapid))
  await assert.rejects(transport.send({ ...subscription, endpoint: "https://fcm.googleapis.com/hang" }, "x", vapid), /timeout/i)
  const controller = new AbortController()
  const contacted = once(server, "request")
  const pending = transport.send({ ...subscription, endpoint: "https://fcm.googleapis.com/hang" }, "x", vapid, controller.signal)
  await contacted
  controller.abort()
  await assert.rejects(pending)
  const before = requests
  await assert.rejects(transport.send(subscription, "x".repeat(4096), vapid), /payload/i)
  for (const subject of ["http://admin.example", "https://user:secret@admin.example", "https://@admin.example",
    "https://admin.example/#", "mailto:admin@example.com#fragment", "mailto:missing-email", "not a URL"]) {
    await assert.rejects(transport.send(subscription, "fixture", { ...vapid, subject }), /subject/i)
  }
  assert.equal(requests, before)

  await t.test("dedicated push security-sentinel companion exercises the real service and HTTPS transport", { timeout: 2000 }, async t => {
    const root = path.join(os.tmpdir(), "opencode")
    fs.mkdirSync(root, { recursive: true })
    const directory = fs.mkdtempSync(path.join(root, "push-sentinels-"))
    const file = path.join(directory, "push-private.json")
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const sentinels = ["PRIVATE_SESSION_NAME_S7", "D:/private/work/project_S7",
      "password-S7-never-send", "proof-S7-never-send", "PRIVATE_INSTANCE_S7"]
    const principal = { id: "remote-device:fixture-owner", channel: "https" as const, origin: "https://ui.example.test" }
    const event = { key: sentinels.join("|"), category: "needsInput" as const,
      instanceId: sentinels[4], sessionId: sentinels[0] }
    const service = new PushService({
      file, enabled: () => true, authority: () => "active", projects: () => [event.instanceId],
      keys: () => vapid, send: transport.send,
    })
    t.after(() => service.close())
    const logs: string[] = []
    for (const method of ["log", "warn", "error", "info", "debug"] as const) {
      t.mock.method(console, method, (...args: unknown[]) => { logs.push(args.map(String).join(" ")) })
    }
    const subscribe = () => {
      for (const browser of ["browser-a", "browser-b"]) service.subscribe(principal, {
        subscription: { ...subscription, endpoint: `https://fcm.googleapis.com/send/${browser}` },
        projects: [event.instanceId], preferences: { v: 1, needsInput: true, sessionDone: true },
      })
    }
    subscribe()
    assert.equal(service.status(principal).subscribed, true)
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    deliveries.length = 0
    status = 201
    retry = "60"
    const initialRequests = requests
    await Promise.all([service.publish(event), service.publish(event)])
    assert.equal(requests - initialRequests, 2)
    assert.equal(deliveries.length, 2)
    assert.deepEqual(new Set(deliveries.map(entry => entry.endpoint)),
      new Set(["/send/browser-a", "/send/browser-b"]))
    const notifications = deliveries.map(entry => JSON.parse(entry.payload))
    assert.equal(new Set(notifications.map(value => value.route)).size, 2)
    assert.equal(new Set(notifications.map(value => value.notificationId)).size, 2)
    for (const notification of notifications) {
      assert.deepEqual(Object.keys(notification).sort(), ["body", "expiresAt", "notificationId", "route", "title", "v"])
      assert.equal(notification.title, "CodeNomad")
      assert.equal(notification.body, "A conversation needs your answer.")
      assert.deepEqual(await service.resolve(principal, notification.route),
        { instanceId: event.instanceId, sessionId: event.sessionId })
      for (const foreign of [
        { ...principal, id: "remote-device:other-owner" },
        { ...principal, origin: "https://other.example.test" },
        { ...principal, channel: "tunnel" as const },
      ]) assert.equal(await service.resolve(foreign, notification.route), undefined)
    }
    for (status of [429, 503]) {
      const before = requests
      const started = Date.now()
      await service.publish({ ...event, key: `${event.key}:retry-${status}` })
      assert.equal(requests - before, 2, "Retry-After 60 suppresses retry beyond the delivery budget")
      assert.ok(Date.now() - started < 1000, "long Retry-After returns without waiting")
      assert.equal(service.status(principal).subscribed, true)
    }
    for (status of [404, 410]) {
      subscribe()
      const before = requests
      await service.publish({ ...event, key: `${event.key}:gone-${status}` })
      assert.equal(requests - before, 2)
      assert.equal(service.status(principal).subscribed, false)
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).entries, [])
      assert.equal(await service.resolve(principal, notifications[0].route), undefined)
    }
    assert.equal(deliveries.length, 10)
    const exposed = JSON.stringify(deliveries)
    for (const sentinel of sentinels) {
      assert.equal(exposed.includes(sentinel), false)
      assert.equal(logs.join("\n").includes(sentinel), false)
    }
    assert.deepEqual(logs, [])
  })
})

test("deadline and cancellation cover DNS without late dispatch", async t => {
  let finish!: (destination: { address: string; family: 4 }) => void
  let dispatches = 0
  t.mock.method(https, "request", () => { dispatches++; throw new Error("Forbidden late dispatch") })
  const transport = createPushTransport({
    resolve: () => new Promise(resolve => { finish = resolve }), timeoutMs: 30,
  })
  await assert.rejects(transport.send(subscription, "fixture", generateKeys()), /timeout/i)
  finish({ address: "127.0.0.1", family: 4 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(dispatches, 0)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(transport.send(subscription, "fixture", generateKeys(), controller.signal))
})
