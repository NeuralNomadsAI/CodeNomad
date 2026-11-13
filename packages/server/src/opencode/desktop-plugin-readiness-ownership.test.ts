import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash, randomUUID } from "node:crypto"
import { syncBuiltinESMExports } from "node:module"
import { setTimeout as delay } from "node:timers/promises"
import { createServer } from "node:http"
import { OpenCode } from "@opencode/client"
import { ownReadiness, registeredReadiness } from "./desktop-plugin-readiness"
import { DesktopPluginLifecycle } from "./desktop-plugin-lifecycle"
import { followPresence } from "./desktop-plugin-presence"
import type { ServiceConnection } from "../workspaces/opencode-service"

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "readiness-ownership-"))
  const lease = path.join(root, `${randomUUID()}.lease`)
  await fs.writeFile(lease, "")
  const owner = ownReadiness(lease)
  t.after(async () => { await owner.close(); await fs.rm(root, { recursive: true, force: true }) })
  return { root, lease, owner }
}
async function until(read: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await read()) return; await delay(5) }
  throw new Error("Fixture condition timed out")
}
const scopeNamespace = (root: string, location = root) => path.join(root, "readiness", createHash("sha256").update(location).digest("hex"))

test("real exclusive request collision preserves foreign request and ACK through owner close", async t => {
  const f = await fixture(t), original = fs.open
  let collided = ""
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith(".json") && args[1] === "wx") {
      collided = String(args[0])
      await fs.writeFile(collided, "foreign request", { flag: "wx" })
      await fs.writeFile(collided.slice(0, -5) + ".ack", "foreign ACK", { flag: "wx" })
    }
    return original(...args)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(f.owner.prepare(f.root, AbortSignal.timeout(1_000), () => {}), /EEXIST/)
    await f.owner.close()
    assert.equal(await fs.readFile(collided, "utf8"), "foreign request")
    assert.equal(await fs.readFile(collided.slice(0, -5) + ".ack", "utf8"), "foreign ACK")
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
})

test("scope collision acquires no ownership and scope replacement survives close", async t => {
  const f = await fixture(t), original = fs.open
  let marker = ""
  const scope = registeredReadiness(f.root, f.root, () => {})
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith(".scope") && args[1] === "wx") {
      marker = String(args[0]); await fs.writeFile(marker, "foreign scope", { flag: "wx" })
    }
    return original(...args)
  })
  syncBuiltinESMExports()
  try { await assert.rejects(scope.reconcile([]), /EEXIST/); await scope.close(); assert.equal(await fs.readFile(marker, "utf8"), "foreign scope") }
  finally { t.mock.restoreAll(); syncBuiltinESMExports() }
  const replacement = registeredReadiness(f.root, f.root, () => {})
  await replacement.reconcile([])
  const own = (await fs.readdir(f.root)).find(name => name.endsWith(".scope") && path.join(f.root, name) !== marker)!
  await fs.rm(path.join(f.root, own)); await fs.writeFile(path.join(f.root, own), "replacement")
  await replacement.close()
  assert.equal(await fs.readFile(path.join(f.root, own), "utf8"), "replacement")
})

test("foreign prepare directory and a replaced owned directory survive close", async t => {
  const f = await fixture(t), directory = `${f.lease}.prepare`
  await fs.mkdir(directory)
  await assert.rejects(f.owner.prepare(f.root, AbortSignal.timeout(40), () => {}))
  await f.owner.close()
  assert((await fs.stat(directory)).isDirectory())
  const lease = path.join(f.root, `${randomUUID()}.lease`)
  await fs.writeFile(lease, "")
  const owner = ownReadiness(lease), controller = new AbortController()
  const pending = owner.prepare(f.root, controller.signal, () => {})
  const refused = assert.rejects(pending)
  await until(async () => (await fs.readdir(`${lease}.prepare`).catch(() => [])).length > 0)
  // Windows holds the parent while the request handle is open. Settle that
  // request first; directory ownership must still survive until owner.close.
  controller.abort(); await refused
  await fs.rename(`${lease}.prepare`, `${lease}.moved`)
  await fs.mkdir(`${lease}.prepare`)
  await fs.writeFile(path.join(`${lease}.prepare`, "foreign"), "preserved")
  await owner.close()
  assert.equal(await fs.readFile(path.join(`${lease}.prepare`, "foreign"), "utf8"), "preserved")
})

test("partial owned write is cleaned, while request and ACK replacements stay foreign", async t => {
  const f = await fixture(t), original = fs.writeFile
  let file = ""
  const originalOpen = fs.open
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith(".json") && args[1] === "wx") file = String(args[0])
    return originalOpen(...args)
  })
  t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (typeof args[0] === "object" && "fd" in args[0]) { await original(args[0], "partial"); throw new Error("partial write") }
    return original(...args)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(f.owner.prepare(f.root, AbortSignal.timeout(1_000), () => {}), /partial write/)
    assert.equal(await fs.stat(file).catch(() => undefined), undefined)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
  const scope = registeredReadiness(f.root, f.root, () => {}), controller = new AbortController()
  const pending = f.owner.prepare(f.root, controller.signal, () => {})
  const settled = pending.catch(() => {})
  await until(async () => (await fs.readdir(`${f.lease}.prepare`)).some(name => name.endsWith(".json")))
  file = path.join(`${f.lease}.prepare`, (await fs.readdir(`${f.lease}.prepare`)).find(name => name.endsWith(".json"))!)
  await scope.reconcile([path.basename(f.lease)])
  const ack = file.slice(0, -5) + ".ack"
  await fs.rm(file); await fs.writeFile(file, "request replacement")
  await fs.rm(ack); await fs.writeFile(ack, "ACK replacement")
  controller.abort(); await settled; await scope.close(); await f.owner.close()
  assert.equal(await fs.readFile(file, "utf8"), "request replacement")
  assert.equal(await fs.readFile(ack, "utf8"), "ACK replacement")
})

test("later lease overflow publishes no ACK, then a fresh request succeeds after removal", async t => {
  const f = await fixture(t), scope = registeredReadiness(f.root, f.root, () => {})
  t.after(() => scope.close())
  const other = `${randomUUID()}.lease`, folder = path.join(f.root, `${other}.prepare`)
  await fs.writeFile(path.join(f.root, other), ""); await fs.mkdir(folder)
  for (let i = 0; i < 65; i++) await fs.writeFile(path.join(folder, `${randomUUID()}.json`), "{}")
  const controller = new AbortController()
  const pending = f.owner.prepare(f.root, AbortSignal.any([controller.signal, AbortSignal.timeout(400)]), () => {})
  let accepted = false
  void pending.then(() => { accepted = true }, () => {})
  const refused = assert.rejects(pending)
  await until(async () => (await fs.readdir(`${f.lease}.prepare`).catch(() => [])).some(n => n.endsWith(".json")))
  await assert.rejects(scope.reconcile([path.basename(f.lease), other]), /exceeds limit/)
  assert.equal((await fs.readdir(`${f.lease}.prepare`)).some(n => n.endsWith(".ack")), false)
  await refused
  assert.equal(accepted, false, "the real backend must not accept partial proof from the refused reconciliation")
  await fs.rm(folder, { recursive: true })
  const fresh = f.owner.prepare(f.root, AbortSignal.timeout(2_000), () => {})
  await until(async () => (await fs.readdir(`${f.lease}.prepare`)).some(n => n.endsWith(".json")))
  await scope.reconcile([path.basename(f.lease), other]); await fresh
  await scope.reconcile([path.basename(f.lease)]); await scope.close(); await f.owner.close()
  assert.equal(await fs.stat(`${f.lease}.prepare`).catch(() => undefined), undefined)
})

test("response capacity 64 accepts the edge and refuses a whole new 65-response plan", async t => {
  const f = await fixture(t), scope = registeredReadiness(f.root, f.root, () => {})
  t.after(() => scope.close())
  const leases: string[] = [], requests: string[] = []
  for (let j = 0; j < 3; j++) {
    const lease = `${randomUUID()}.lease`, folder = path.join(f.root, `${lease}.prepare`)
    leases.push(lease); await fs.writeFile(path.join(f.root, lease), ""); await fs.mkdir(folder)
    for (let i = 0; i < (j === 2 ? 1 : 32); i++) {
      const nonce = randomUUID(), file = path.join(folder, `${nonce}.json`)
      await fs.writeFile(file, JSON.stringify({ version: 1, nonce, lease, directory: f.root, expires: Date.now() + 5_000 })); requests.push(file)
    }
  }
  await assert.rejects(scope.reconcile(leases), /Too many readiness responses/)
  for (const file of requests) assert.equal(await fs.stat(file.slice(0, -5) + ".ack").catch(() => undefined), undefined)
  await scope.reconcile(leases.slice(0, 2))
  for (const file of requests.slice(0, 64)) assert((await fs.stat(file.slice(0, -5) + ".ack")).isFile())
  await assert.rejects(scope.reconcile(leases), /Too many readiness responses/)
  await fs.rm(requests[0])
  await scope.reconcile(leases)
  assert((await fs.stat(requests[64].slice(0, -5) + ".ack")).isFile())
})

test("inert scope namespace has a finite admission bound and preserves crash residues", async t => {
  const f = await fixture(t), residue: string[] = []
  const namespace = scopeNamespace(f.root)
  await fs.mkdir(namespace, { recursive: true })
  for (let i = 0; i < 256; i++) { const file = path.join(namespace, `${randomUUID()}.claim`); residue.push(file); await fs.writeFile(file, "crash residue") }
  const blocked = registeredReadiness(f.root, f.root, () => {})
  await assert.rejects(blocked.reconcile([]), /namespace exceeds limit/); await blocked.close()
  assert.equal((await fs.readdir(namespace)).length, 256)
  assert.equal(await fs.readFile(residue[0], "utf8"), "crash residue")
  await fs.rm(residue.pop()!)
  const fresh = registeredReadiness(f.root, f.root, () => {})
  await fresh.reconcile([]); assert.equal((await fs.readdir(namespace)).length, 256)
  await fresh.close(); assert.equal((await fs.readdir(namespace)).length, 255)
})

test("historical backend presence entries cannot prevent a Location from registering readiness", async t => {
  const f = await fixture(t)
  for (let i = 0; i < 445; i++) {
    const file = path.join(f.root, `${randomUUID()}.lease`)
    await fs.writeFile(file, "")
    await fs.utimes(file, new Date(0), new Date(0))
  }
  const scope = registeredReadiness(f.root, f.root, () => {})
  t.after(() => scope.close())
  await scope.reconcile([path.basename(f.lease)])
  const marker = (await fs.readdir(f.root)).find(name => name.endsWith(".scope"))!
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, marker), "utf8")).directory, f.root)
  await scope.close()
  assert.equal((await fs.readdir(f.root)).filter(name => name.endsWith(".lease")).length, 446)
})

test("a full registration namespace is isolated to its exact native Location", async t => {
  const f = await fixture(t), other = path.join(f.root, "other")
  const namespace = scopeNamespace(f.root, other)
  await fs.mkdir(namespace, { recursive: true })
  for (let i = 0; i < 256; i++) await fs.writeFile(path.join(namespace, `${randomUUID()}.claim`), "other Location")
  const scope = registeredReadiness(f.root, f.root, () => {})
  t.after(() => scope.close())
  await scope.reconcile([])
  assert.equal((await fs.readdir(scopeNamespace(f.root))).length, 1)
  const blocked = registeredReadiness(f.root, other, () => {})
  await assert.rejects(blocked.reconcile([]), /namespace exceeds limit/)
  await blocked.close(); await scope.close()
  assert.equal((await fs.readdir(namespace)).length, 256)
  assert.equal((await fs.readdir(scopeNamespace(f.root))).length, 0)
})

test("registration reservation replacement survives scope close", async t => {
  const f = await fixture(t), scope = registeredReadiness(f.root, f.root, () => {})
  t.after(() => scope.close())
  await scope.reconcile([])
  const namespace = scopeNamespace(f.root)
  const file = path.join(namespace, (await fs.readdir(namespace))[0])
  await fs.rm(file); await fs.writeFile(file, "foreign reservation")
  await scope.close()
  assert.equal(await fs.readFile(file, "utf8"), "foreign reservation")
})

for (const level of ["parent", "Location"] as const) test(`readiness rejects a symbolic ${level} namespace without writing through it`, async t => {
  const f = await fixture(t), target = path.join(f.root, "foreign")
  await fs.mkdir(target)
  const parent = path.join(f.root, "readiness")
  if (level === "Location") await fs.mkdir(parent)
  await fs.symlink(target, level === "parent" ? parent : scopeNamespace(f.root), "junction")
  const scope = registeredReadiness(f.root, f.root, () => {})
  await assert.rejects(scope.reconcile([]), /Invalid readiness directory/)
  await scope.close()
  assert.deepEqual(await fs.readdir(target), [])
  assert.equal((await fs.readdir(f.root)).some(name => name.endsWith(".scope")), false)
})

test("scope admission rechecks concurrent namespace growth and cleans only its own new scope", async t => {
  const f = await fixture(t), original = fs.open
  const scope = registeredReadiness(f.root, f.root, () => {})
  let marker = ""
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith(".claim") && args[1] === "wx") {
      marker = String(args[0])
      for (let i = 0; i < 256; i++) await fs.writeFile(path.join(scopeNamespace(f.root), `${randomUUID()}.claim`), "concurrent scope")
    }
    return original(...args)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(scope.reconcile([]), /exceeds limit/); await scope.close()
    assert.equal(await fs.stat(marker).catch(() => undefined), undefined)
    assert.equal((await fs.readdir(scopeNamespace(f.root))).length, 256)
    assert.equal((await fs.readdir(f.root)).some(name => name.endsWith(".scope")), false)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
})

test("an ACK creation collision stays owned by its actual foreign creator", async t => {
  const f = await fixture(t), scope = registeredReadiness(f.root, f.root, () => {}), controller = new AbortController()
  const pending = f.owner.prepare(f.root, controller.signal, () => {}), refused = assert.rejects(pending)
  await until(async () => (await fs.readdir(`${f.lease}.prepare`).catch(() => [])).some(n => n.endsWith(".json")))
  const request = (await fs.readdir(`${f.lease}.prepare`)).find(n => n.endsWith(".json"))!
  const ack = path.join(`${f.lease}.prepare`, request.slice(0, -5) + ".ack")
  await fs.writeFile(ack, "foreign ACK", { flag: "wx" })
  try { await scope.reconcile([path.basename(f.lease)]) }
  finally { controller.abort(); await refused; await scope.close(); await f.owner.close() }
  assert.equal(await fs.readFile(ack, "utf8"), "foreign ACK")
})

for (const mode of ["abort", "deadline", "replace"] as const) test(`catalogue ${mode} joins its admitted settlement before readiness returns`, async t => {
  const f = await fixture(t), lifecycle = new DesktopPluginLifecycle("session-pruning", async () => Buffer.from("export {}"))
  let release!: () => void, entered!: () => void, returned = false, current = true, transportSignal: AbortSignal | undefined
  const hold = new Promise<void>(resolve => { release = resolve }), admitted = new Promise<void>(resolve => { entered = resolve })
  const controller = new AbortController()
  const connection = { assertCurrent() { if (!current) throw new Error("connection replaced") }, client: { plugin: { list: async ({ location }: any, { signal }: any) => {
    transportSignal = signal; entered(); await hold; return { location, data: [] }
  } } } } as unknown as ServiceConnection
  const prepared = await lifecycle.prepare({ config: path.join(f.root, "config"), data: path.join(f.root, "data") }, () => {}, connection)
  prepared.commit(); await prepared.release()
  const pending = lifecycle.ready({ connection, location: { directory: f.root }, signal: controller.signal, deadlineAt: Date.now() + (mode === "deadline" ? 60 : 2_000), assertCurrent() {} })
  const refused = assert.rejects(pending, /cancelled|timed out|replaced/).then(() => { returned = true })
  try {
    await admitted
    if (mode === "abort") controller.abort(new Error("cancelled"))
    if (mode === "replace") current = false
    await delay(mode === "deadline" ? 90 : 30)
    assert.equal(returned, false)
    if (mode !== "replace") assert.equal(transportSignal?.aborted, true)
    release(); await refused
    assert.equal((await fs.readdir(path.join(f.root, "data", "session-pruning", "presence"))).some(n => n.endsWith(".prepare")), false)
  } finally { release(); await refused; await lifecycle.stop() }
})

test("real HTTP catalogue stream abort settles without cancelling another caller's installation", async t => {
  const f = await fixture(t), lifecycle = new DesktopPluginLifecycle("session-pruning", async () => Buffer.from("export {}"))
  let entered!: () => void, closed!: () => void
  const admitted = new Promise<void>(resolve => { entered = resolve }), transportClosed = new Promise<void>(resolve => { closed = resolve })
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" }); response.write('{"location":')
    response.once("close", closed); entered()
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  const controller = new AbortController()
  const connection = { assertCurrent() {}, client: OpenCode.make({ baseUrl: `http://127.0.0.1:${address.port}` }) } as ServiceConnection
  const prepared = await lifecycle.prepare({ config: path.join(f.root, "config"), data: path.join(f.root, "data") }, () => {}, connection)
  prepared.commit(); await prepared.release()
  const other = { assertCurrent() {}, client: { plugin: { list: async ({ location }: any) => ({ location, data: [{ id: "codenomad-session-pruning", state: { status: "active" } }] }) } } } as unknown as ServiceConnection
  const claim = await lifecycle.prepare({ config: path.join(f.root, "config"), data: path.join(f.root, "data") }, () => {}, other)
  claim.commit(); await claim.release()
  const stop = await followPresence(path.join(f.root, "data", "session-pruning", "presence"), async () => () => {}, undefined, undefined, f.root)
  const pending = lifecycle.ready({ connection, location: { directory: f.root }, signal: controller.signal, assertCurrent() {} })
  const refused = assert.rejects(pending)
  try {
    await admitted; controller.abort(new Error("HTTP cancelled")); await refused; await transportClosed
    await lifecycle.ready({ connection: other, location: { directory: f.root }, signal: AbortSignal.timeout(5_000), assertCurrent() {} })
    assert.equal((await fs.readdir(path.join(f.root, "data", "session-pruning", "presence"))).filter(n => n.endsWith(".lease")).length, 1)
  } finally {
    controller.abort(); await refused; await stop(); await lifecycle.stop()
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
