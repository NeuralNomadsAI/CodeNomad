import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import Fastify from "fastify"
import pino from "pino"
import { AuthManager } from "../../auth/manager"
import { handleManagedSessionControl } from "../../auth/managed-session-control"
import { registerAuthRoutes } from "./auth"

test("only the process parent renews an expired managed session; logout and password changes retire that right", async t => {
  const clock = t.mock.method(Date, "now", () => 1_000)
  const directory = await mkdtemp(join(tmpdir(), "managed-session-"))
  const auth = new AuthManager({ configPath: join(directory, "config.yaml"), username: "local",
    generateToken: true, managedLocal: true, sessionIdleMs: 20_000 }, pino({ level: "silent" }) as never)
  const app = Fastify()
  t.after(async () => { clock.mock.restore(); await app.close(); await rm(directory, { recursive: true, force: true }) })
  registerAuthRoutes(app, { authManager: auth })
  app.get("/private", (request, reply) => auth.getSessionFromRequest(request) ? { ok: true } : reply.code(401).send())
  const first = auth.issueBootstrapToken()!
  const bootstrap = (token: string) => app.inject({ method: "POST", url: "/api/auth/token", payload: { token } })
  const publicStatus = (cookie: string) => app.inject({ url: "/api/auth/status", headers: { cookie } })
  const read = (cookie: string) => app.inject({ url: "/private", headers: { cookie } })
  const reply = () => {
    const id = "9d754f99-0b08-44d0-a99c-0d6c95229647", lines: string[] = []
    assert(handleManagedSessionControl(`codenomad:renew-session ${id}`, auth, line => lines.push(line)))
    assert.equal(lines.length, 1)
    assert.match(lines[0], new RegExp(`^CODENOMAD_MANAGED_SESSION:${id} (?:[-_A-Za-z0-9]{43}|-)$`))
    return lines[0].split(" ")[1]
  }
  const original = await bootstrap(first)
  assert.equal(original.statusCode, 200)
  const oldCookie = (original.headers["set-cookie"] as string).split(";")[0]
  assert.equal(reply(), "-")
  clock.mock.mockImplementation(() => 21_001)
  assert.equal((await read(oldCookie)).statusCode, 401)
  assert.deepEqual((await publicStatus(oldCookie)).json(), { authenticated: false })
  assert.equal((await bootstrap(first)).statusCode, 401)
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/renew", headers: { cookie: oldCookie } })).statusCode, 404)
  const renewed = reply()
  assert.match(renewed, /^[-_A-Za-z0-9]{43}$/)
  assert.equal(reply(), renewed, "the same hand-off survives a lost response")
  const cookie = `${auth.getCookieName()}=${renewed}`
  assert.notEqual(cookie, oldCookie)
  assert.equal((await read(cookie)).statusCode, 200)
  assert.equal((await read(oldCookie)).statusCode, 401)
  clock.mock.mockImplementation(() => 41_002)
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } })).statusCode, 200)
  assert.equal(reply(), "-")

  const raced = await bootstrap(auth.issueBootstrapToken()!)
  const raceCookie = (raced.headers["set-cookie"] as string).split(";")[0]
  clock.mock.mockImplementation(() => 61_003)
  const uninstalled = reply()
  assert.notEqual(uninstalled, "-")
  assert.equal((await read(`${auth.getCookieName()}=${uninstalled}`)).statusCode, 200)
  clock.mock.mockImplementation(() => 72_004)
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: raceCookie },
    remoteAddress: "192.0.2.1" })).statusCode, 200)
  assert.equal((await read(`${auth.getCookieName()}=${uninstalled}`)).statusCode, 401)
  assert.equal(reply(), "-")

  const bootAgain = await bootstrap(auth.issueBootstrapToken()!)
  const newCookie = (bootAgain.headers["set-cookie"] as string).split(";")[0]
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/password", headers: { cookie: newCookie },
    payload: { password: "fixture-only" } })).statusCode, 200)
  assert.equal((await read(newCookie)).statusCode, 401)
  assert.equal(reply(), "-")
})
