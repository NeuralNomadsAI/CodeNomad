import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { it } from "node:test"
import Fastify from "fastify"
import pino from "pino"
import { AuthManager, PASSWORD_SESSION_TTL_MS } from "../../auth/manager"
import { registerAuthRoutes } from "./auth"

async function fixture(generateToken = false) {
  const tempRoot = path.join(os.tmpdir(), "opencode")
  await fs.mkdir(tempRoot, { recursive: true })
  const directory = await fs.mkdtemp(path.join(tempRoot, "codenomad-auth-lifetime-"))
  const manager = new AuthManager({
    configPath: path.join(directory, "config.yaml"), username: "user", password: "fixture-password", generateToken,
  }, pino({ level: "silent" }))
  const app = Fastify({ logger: false })
  registerAuthRoutes(app, { authManager: manager })
  return { app, manager, async close() { await app.close(); await fs.rm(directory, { recursive: true, force: true }) } }
}

const cookieOf = (header: string | string[] | number | undefined) => String(Array.isArray(header) ? header[0] : header)

it("a password login cookie outlives the browser for the session's lifetime, keeping its protections", async () => {
  const f = await fixture()
  try {
    const login = await f.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "user", password: "fixture-password" } })
    assert.equal(login.statusCode, 200)
    const cookie = cookieOf(login.headers["set-cookie"])
    const parts = cookie.split("; ")
    assert.ok(parts.includes("HttpOnly"))
    assert.ok(parts.includes("SameSite=Lax"))
    assert.ok(parts.includes("Path=/"))
    // Plain HTTP stays without Secure, exactly as before.
    assert.ok(!parts.includes("Secure"))
    assert.ok(parts.includes(`Max-Age=${PASSWORD_SESSION_TTL_MS / 1000}`), cookie)

    const value = parts[0]!
    const status = await f.app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie: value } })
    assert.equal(status.json().authenticated, true)

    // Logging out ends the session on the server, not only in this browser.
    const logout = await f.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: value } })
    assert.match(cookieOf(logout.headers["set-cookie"]), /Max-Age=0/)
    const after = await f.app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie: value } })
    assert.equal(after.json().authenticated, false)
  } finally { await f.close() }
})

it("a desktop bootstrap token session keeps a browser-session cookie that lasts as long as the server", async () => {
  const f = await fixture(true)
  try {
    const token = f.manager.issueBootstrapToken()!
    const response = await f.app.inject({ method: "POST", url: "/api/auth/token", payload: { token }, remoteAddress: "127.0.0.1" })
    assert.equal(response.statusCode, 200)
    assert.doesNotMatch(cookieOf(response.headers["set-cookie"]), /Max-Age/)
  } finally { await f.close() }
})
