import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import http from "node:http"
import { test, type TestContext } from "node:test"
import { createBackendCookieInstaller, exchangeBackendBootstrap, type BackendBootstrapCookie } from "./backend-bootstrap"
import { BackendBootstrapCoordinator } from "./startup"

const name = "codenomad_session_fixture"
const proof = randomBytes(32).toString("base64url")
const value = randomBytes(32).toString("base64url")
const cookie = `${name}=${value}; HttpOnly; Path=/; SameSite=Lax`

async function fixture(t: TestContext, handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return `http://127.0.0.1:${address.port}`
}

test("private bootstrap posts its proof once and returns only a native cookie descriptor", async (t) => {
  let available = true
  const origin = await fixture(t, (request, response) => {
    assert.equal(request.method, "POST")
    assert.equal(request.url, "/api/auth/token")
    assert.equal(request.headers.cookie, undefined)
    let body = ""
    request.on("data", (chunk) => { body += chunk })
    request.on("end", () => {
      assert.deepEqual(JSON.parse(body), { token: proof })
      if (!available) { response.writeHead(401).end(); return }
      available = false
      response.writeHead(200, { "Set-Cookie": cookie }).end('{"ok":true}')
    })
  })
  assert.deepEqual(await exchangeBackendBootstrap(origin, proof, name), {
    url: origin, name, value, httpOnly: true, path: "/", sameSite: "lax",
  })
  assert.equal(await exchangeBackendBootstrap(origin, proof, name), undefined)
})

test("rejects non-exact origins, invalid proofs and missing or invalid expected names before network access", async (t) => {
  let requests = 0
  const origin = await fixture(t, (_request, response) => { requests++; response.end() })
  const port = new URL(origin).port
  for (const invalid of [
    `${origin}/`, `${origin}/api`, `${origin}/../`, `${origin}?x=1`, `${origin}#x`,
    origin.replace("http:", "https:"), `http://localhost:${port}`, `http://127.1:${port}`,
    `http://user@127.0.0.1:${port}`, `http://127.0.0.1:0`, `http://127.0.0.1:65536`,
    `http://127.0.0.1:0${port}`, ` ${origin}`, `${origin}\n`,
  ]) assert.equal(await exchangeBackendBootstrap(invalid, proof, name), undefined, invalid)
  for (const invalid of ["", "a".repeat(42), "a".repeat(44), "!".repeat(43)]) {
    assert.equal(await exchangeBackendBootstrap(origin, invalid, name), undefined)
  }
  for (const invalid of ["", "bad name", "x".repeat(257), "name\r\nInjected: true"]) {
    assert.equal(await exchangeBackendBootstrap(origin, proof, invalid), undefined)
  }
  assert.equal(requests, 0)
})

test("rejects wrong, duplicate and malformed native cookies and never follows redirects", async (t) => {
  const replies: Array<{ status?: number; cookies?: string | string[] }> = [
    {}, { cookies: cookie.replace(name, "other") }, { cookies: [cookie, cookie] },
    { cookies: cookie.replace(value, "%ZZ") }, { cookies: cookie.replace(value, "short") },
    { cookies: `${cookie}; Domain=example.com` }, { cookies: cookie.replace("Path=/", "Path=/other") },
    { cookies: cookie.replace("HttpOnly; ", "") }, { status: 302, cookies: cookie },
  ]
  let requests = 0
  const origin = await fixture(t, (_request, response) => {
    const reply = replies[requests++]
    assert.ok(reply, "unexpected redirect or retry")
    response.writeHead(reply.status ?? 200, {
      ...(reply.cookies ? { "Set-Cookie": reply.cookies } : {}), Location: "/redirected",
    }).end()
  })
  for (const _reply of replies) assert.equal(await exchangeBackendBootstrap(origin, proof, name), undefined)
  assert.equal(requests, replies.length)
})

test("native cookie attributes retain their meaning in any order", async (t) => {
  const origin = await fixture(t, (_request, response) => {
    response.writeHead(200, { "Set-Cookie": `${name}=${value}; SameSite=Lax; Path=/; HttpOnly` }).end()
  })
  assert.equal((await exchangeBackendBootstrap(origin, proof, name))?.value, value)
})

test("bounds response headers/body and handles truncated or failed connections", async (t) => {
  let requests = 0
  const origin = await fixture(t, (_request, response) => {
    switch (requests++) {
      case 0: response.writeHead(200, { "Set-Cookie": cookie, "X-Large": "x".repeat(8192) }).end(); break
      case 1: response.writeHead(200, { "Set-Cookie": cookie }).end("x".repeat(4097)); break
      case 2:
        response.writeHead(200, { "Set-Cookie": cookie, "Content-Length": 100 })
        response.write("short")
        response.socket?.destroy()
        break
      default: response.socket?.destroy()
    }
  })
  for (let i = 0; i < 4; i++) assert.equal(await exchangeBackendBootstrap(origin, proof, name), undefined)
})

test("absolute deadline includes a response body that never finishes", async (t) => {
  const origin = await fixture(t, (_request, response) => {
    response.writeHead(200, { "Set-Cookie": cookie })
    response.write("pending")
  })
  const started = Date.now()
  assert.equal(await exchangeBackendBootstrap(origin, proof, name), undefined)
  assert.ok(Date.now() - started < 8000, "fixed deadline must settle without body completion")
})

function nativeFixture() {
  const owned: BackendBootstrapCookie = { url: "http://127.0.0.1:1234", name, value, httpOnly: true, path: "/", sameSite: "lax" }
  const store = new Map<string, { name: string; value: string; domain: string; path: string; httpOnly: boolean; sameSite: string }>()
  const publish = (cookie: BackendBootstrapCookie) => store.set(cookie.name, {
    name: cookie.name, value: cookie.value, domain: "127.0.0.1", path: cookie.path, httpOnly: true, sameSite: "lax",
  })
  const native = {
    set: async (cookie: BackendBootstrapCookie) => { publish(cookie) },
    get: async (filter: { name: string }) => [...store.values()].filter(cookie => cookie.name === filter.name),
    remove: async (_url: string, name: string) => { store.delete(name) },
  }
  return { owned, store, publish, native }
}

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

test("generation reset during native installation removes stale cookie before installing its successor", async () => {
  const { owned, store, publish, native } = nativeFixture()
  const started = gate(), receipt = gate()
  const order: string[] = []
  const successor = { ...owned, value: "s".repeat(43) }
  publish({ ...owned, name: "unrelated" })
  store.set("same-name-other-path", { ...store.get("unrelated")!, name, path: "/other" })
  native.set = async cookie => {
    if (cookie.value === owned.value) { started.release(); await receipt.promise }
    publish(cookie)
    order.push(`set:${cookie.value}`)
  }
  native.remove = async (_url, name) => { store.delete(name); order.push("remove:stale") }
  const install = createBackendCookieInstaller(native)
  const navigation: string[] = []
  const coordinator = new BackendBootstrapCoordinator((_url, token, current) => install(token === "old" ? owned : successor, current),
    url => { navigation.push(url) })
  coordinator.setReady(owned.url); coordinator.setToken("old")
  await started.promise
  coordinator.reset()
  coordinator.setReady(owned.url); coordinator.setToken("new")
  receipt.release()
  await coordinator.idle()
  assert.deepEqual(order, [`set:${owned.value}`, "remove:stale", `set:${successor.value}`])
  assert.equal(store.get(name)?.value, successor.value)
  assert.equal(store.get("unrelated")?.value, owned.value)
  assert.equal(store.get("same-name-other-path")?.path, "/other")
  assert.deepEqual(navigation, [owned.url])
})

test("late native failure cleans its possible effect before admitting a fresh successor", async () => {
  const { owned, store, publish, native } = nativeFixture()
  const started = gate(), receipt = gate()
  let current = true
  native.set = async cookie => {
    if (cookie.value === owned.value) {
      started.release(); await receipt.promise; publish(cookie); throw new Error("late native failure")
    }
    publish(cookie)
  }
  const install = createBackendCookieInstaller(native)
  const old = install(owned, () => current)
  const rejected = assert.rejects(old, /late native failure/)
  await started.promise
  current = false
  const successor = { ...owned, value: "s".repeat(43) }
  const next = install(successor, () => true)
  receipt.release()
  await rejected
  assert.equal(await next, true)
  assert.equal(store.get(name)?.value, successor.value)
})

test("failed stale cleanup permanently fences successors without clearing unrelated cookies", async () => {
  for (const failure of ["rejection", "missing removal receipt"]) {
    const { owned, store, publish, native } = nativeFixture()
    let current = true, sets = 0
    publish({ ...owned, name: "unrelated" })
    native.set = async cookie => { sets++; publish(cookie); current = false }
    native.remove = async () => { if (failure === "rejection") throw new Error("native cleanup rejected") }
    const install = createBackendCookieInstaller(native)
    await assert.rejects(install(owned, () => current), /cleanup remains unconfirmed/)
    await assert.rejects(install({ ...owned, value: "s".repeat(43) }, () => true), /cleanup remains unconfirmed/)
    assert.equal(sets, 1)
    assert.equal(store.get("unrelated")?.value, owned.value)
  }
})

test("native rejection or missing readback falls back to login and never replays a proof", async () => {
  for (const failure of ["rejection", "missing receipt"]) {
    const { owned, native } = nativeFixture()
    let sets = 0
    native.set = async () => { sets++; if (failure === "rejection") throw new Error("native rejected") }
    const install = createBackendCookieInstaller(native)
    const navigation: string[] = []
    const coordinator = new BackendBootstrapCoordinator((_url, _token, current) => install(owned, current),
      url => { navigation.push(url) })
    coordinator.setReady(owned.url); coordinator.setToken("proof")
    await coordinator.idle()
    assert.equal(sets, 1)
    assert.deepEqual(navigation, [`${owned.url}/login`])
  }
})

test("stale cleanup preserves a replaced cookie and pre-install identity changes do not mutate", async () => {
  const { owned, store, publish, native } = nativeFixture()
  const replacement = { ...owned, value: "r".repeat(43) }
  let current = true
  native.set = async () => { publish(replacement); current = false }
  const install = createBackendCookieInstaller(native)
  await assert.rejects(install(owned, () => current), /installation was not confirmed/)
  assert.equal(store.get(name)?.value, replacement.value)
  await assert.rejects(install(owned, () => true), /identity is already occupied/)
  assert.equal(await install(owned, () => false), false)
  assert.equal(store.get(name)?.value, replacement.value)
})

test("readback must retain native cookie attributes and a changed expected identity prevents installation", async () => {
  const { owned, store, publish, native } = nativeFixture()
  native.set = async cookie => { publish(cookie); store.get(cookie.name)!.httpOnly = false }
  const install = createBackendCookieInstaller(native)
  await assert.rejects(install(owned, () => true), /installation was not confirmed/)
  assert.equal(store.has(name), false)
  let expectedName = owned.name
  native.get = async () => { expectedName = "new-backend-cookie"; return [] }
  native.set = async () => { assert.fail("Expected cookie identity changed before native installation") }
  assert.equal(await install(owned, () => expectedName === owned.name), false)
})
