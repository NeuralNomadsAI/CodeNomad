import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { it } from "node:test"
import Fastify from "fastify"
import pino from "pino"
import { AuthManager } from "../../auth/manager"
import { registerAuthRoutes } from "./auth"

const username = "fixture-user"
const password = "fixture-password"

async function fixture(options: { persist?: boolean; generateToken?: boolean; password?: string; dangerouslySkipAuth?: boolean } = {}) {
  const tempRoot = path.join(os.tmpdir(), "opencode")
  await fs.mkdir(tempRoot, { recursive: true })
  const directory = await fs.mkdtemp(path.join(tempRoot, "codenomad-auth-responsive-"))
  // An existing v1 record, produced independently with the old synchronous API.
  const salt = Buffer.from("0123456789abcdef")
  const params = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }
  if (options.persist !== false) await fs.writeFile(path.join(directory, "auth.json"), JSON.stringify({
    version: 1,
    username,
    password: {
      algorithm: "scrypt", saltBase64: salt.toString("base64"),
      hashBase64: crypto.scryptSync(password, salt, 64, params).toString("base64"),
      keyLength: 64, params,
    },
    userProvided: true,
    updatedAt: "2026-01-01T00:00:00.000Z",
  }))
  const manager = new AuthManager({
    configPath: path.join(directory, "config.yaml"), username, generateToken: false, ...options,
  }, pino({ level: "silent" }))
  const app = Fastify({ logger: false })
  registerAuthRoutes(app, { authManager: manager })
  return {
    app, manager, directory,
    async close() {
      await app.close()
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}

function observeWork<T>(work: () => T, state: { pending: number; completed: number; maxCallMs: number }): T {
  state.pending++
  const start = performance.now()
  try {
    const result = work()
    state.maxCallMs = Math.max(state.maxCallMs, performance.now() - start)
    if (result && typeof (result as unknown as Promise<unknown>).then === "function") {
      return Promise.resolve(result).finally(() => { state.pending--; state.completed++ }) as T
    }
    state.pending--
    state.completed++
    return result
  } catch (error) {
    state.pending--
    state.completed++
    throw error
  }
}

it("services a witness endpoint while a bounded burst of login verifications is pending", async (t) => {
  const f = await fixture()
  try {
    const state = { pending: 0, completed: 0, maxCallMs: 0 }
    f.app.get("/fixture-heartbeat", async () => ({ pending: state.pending, completed: state.completed }))
    const validate = f.manager.validateLogin.bind(f.manager)
    let probe: Promise<{ pending: number; completed: number }> | undefined
    let probeMs = 0
    f.manager.validateLogin = (...args) => {
      if (!probe) {
        const start = performance.now()
        probe = new Promise((resolve, reject) => setImmediate(() => {
          f.app.inject({ method: "GET", url: "/fixture-heartbeat" }).then((response) => {
            probeMs = performance.now() - start
            resolve(response.json())
          }, reject)
        }))
      }
      return observeWork(() => validate(...args), state)
    }
    const start = performance.now()
    const responses = await Promise.all(Array.from({ length: 8 }, () => f.app.inject({
      method: "POST", url: "/api/auth/login", payload: { username, password: "invalid-password" },
    })))
    const witness = await probe!
    t.diagnostic(JSON.stringify({ operation: "login", totalMs: performance.now() - start, probeMs, ...state, witness }))
    for (const response of responses) {
      assert.equal(response.statusCode, 401)
      assert.deepEqual(response.json(), { error: "Invalid credentials" })
      assert.equal(response.headers["set-cookie"], undefined)
    }
    assert.ok(witness.pending > 0, "the HTTP witness must run before all expensive verifications finish")
  } finally {
    await f.close()
  }
})

it("awaits login results for valid credentials, rejects wrong usernames and authenticates the cookie", async () => {
  const f = await fixture()
  try {
    const responses = await Promise.all([
      { username, password },
      { username: "not-the-user", password },
      { username, password: "not-the-password" },
    ].map((payload) => f.app.inject({ method: "POST", url: "/api/auth/login", payload })))
    assert.deepEqual(responses.map((response) => response.statusCode), [200, 401, 401])
    assert.deepEqual(responses[0].json(), { ok: true })
    const cookie = String(responses[0].headers["set-cookie"])
    assert.match(cookie, /HttpOnly; Path=\/; SameSite=Lax/)
    const status = await f.app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie } })
    assert.deepEqual(status.json(), { authenticated: true, username, passwordUserProvided: true })
  } finally {
    await f.close()
  }
})

it("rejects a pending login verified against a password replaced before verification returns", async (t) => {
  const f = await fixture()
  let release: (() => void) | undefined
  let pendingLogin: Promise<unknown> | undefined
  try {
    let notifyDerived!: () => void
    const derived = new Promise<void>((resolve) => { notifyDerived = resolve })
    const scrypt = crypto.scrypt.bind(crypto)
    let held = false
    // Run real scrypt, but hold the first old-password callback until the new
    // password is durably committed. No scheduler or elapsed-time assumptions.
    const scryptMock = t.mock.method(crypto, "scrypt", (
      input: crypto.BinaryLike, salt: crypto.BinaryLike, keyLength: number,
      options: crypto.ScryptOptions, callback: (error: Error | null, key: Buffer) => void,
    ) => scrypt(input, salt, keyLength, options, (error, key) => {
      if (input === password && !held) {
        held = true
        release = () => { release = undefined; callback(error, key) }
        notifyDerived()
      } else {
        callback(error, key)
      }
    }))
    const login = f.app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } })
      .then((response) => response)
    pendingLogin = login
    await derived
    const session = f.manager.createSession(username)
    const changed = await f.app.inject({
      method: "POST", url: "/api/auth/password", payload: { password: "replacement-password" },
      headers: { cookie: `${f.manager.getCookieName()}=${session.id}` },
    })
    assert.equal(changed.statusCode, 200)
    assert.equal(await f.manager.validateLogin(username, "replacement-password"), true)
    release!()
    const stale = await login
    assert.equal(stale.statusCode, 401, "a successful derivation of superseded credentials must not authorize a login")
    assert.deepEqual(stale.json(), { error: "Invalid credentials" })
    assert.equal(stale.headers["set-cookie"], undefined)
    assert.equal(scryptMock.mock.callCount(), 3, "do not replay the old login against the replacement password")
    assert.equal(await f.manager.validateLogin(username, password), false)
  } finally {
    release?.()
    await pendingLogin
    t.mock.restoreAll()
    await f.close()
  }
})

it("preserves unauthenticated, runtime-override and disabled-auth password errors", async () => {
  for (const options of [{}, { password }, { dangerouslySkipAuth: true }]) {
    const f = await fixture(options)
    try {
      if (!options.dangerouslySkipAuth) {
        const unauthorized = await f.app.inject({ method: "POST", url: "/api/auth/password", payload: { password } })
        assert.equal(unauthorized.statusCode, 401)
        assert.deepEqual(unauthorized.json(), { error: "Unauthorized" })
      }
      if (options.password || options.dangerouslySkipAuth) {
        const session = f.manager.createSession(username)
        const response = await f.app.inject({
          method: "POST", url: "/api/auth/password", payload: { password: "next-password" },
          headers: { cookie: `${f.manager.getCookieName()}=${session.id}` },
        })
        assert.equal(response.statusCode, 409)
        assert.match(response.body, options.password ? /provided via CLI\/env/ : /authentication is disabled/)
        assert.match(String(response.headers["content-type"]), /^text\/plain/)
      }
      if (options.password) assert.equal(await f.manager.validateLogin(username, password), true)
      if (options.dangerouslySkipAuth) assert.equal(await f.manager.validateLogin("any", "anything"), true)
    } finally {
      await f.close()
    }
  }
})

it("keeps bootstrap password changes ordered and recovers the queue after a persistence failure", async () => {
  const f = await fixture({ persist: false, generateToken: true })
  try {
    assert.equal(await f.manager.validateLogin(username, password), false)
    assert.deepEqual(f.manager.getStatus(), { username, passwordUserProvided: false })
    const authPath = path.join(f.directory, "auth.json")
    await fs.mkdir(authPath)
    const session = f.manager.createSession(username)
    const failed = await f.app.inject({
      method: "POST", url: "/api/auth/password", payload: { password: "failed-password" },
      headers: { cookie: `${f.manager.getCookieName()}=${session.id}` },
    })
    assert.equal(failed.statusCode, 409)
    assert.match(String(failed.headers["content-type"]), /^text\/plain/)
    assert.deepEqual(f.manager.getStatus(), { username, passwordUserProvided: false })
    await fs.rmdir(authPath)
    const changes = ["first-password", "second-password", "final-password"]
    await Promise.all(changes.map((next) => f.manager.setPassword(next)))
    assert.equal(await f.manager.validateLogin(username, changes[0]), false)
    assert.equal(await f.manager.validateLogin(username, changes[2]), true)
    const persisted = JSON.parse(await fs.readFile(authPath, "utf8"))
    assert.equal(persisted.username, username)
    assert.equal(persisted.userProvided, true)
    // Independent synchronous verification proves persisted format compatibility.
    const record = persisted.password
    assert.equal(crypto.scryptSync(changes[2], Buffer.from(record.saltBase64, "base64"), record.keyLength, record.params)
      .toString("base64"), record.hashBase64)
  } finally {
    await f.close()
  }
})

it("services a witness endpoint during password derivation and awaits persistence", async (t) => {
  const f = await fixture()
  try {
    const session = f.manager.createSession(username)
    const cookie = `${f.manager.getCookieName()}=${session.id}`
    const state = { pending: 0, completed: 0, maxCallMs: 0 }
    f.app.get("/fixture-heartbeat", async () => ({ pending: state.pending, completed: state.completed }))
    const setPassword = f.manager.setPassword.bind(f.manager)
    let probe: Promise<{ pending: number; completed: number }> | undefined
    let probeMs = 0
    f.manager.setPassword = (...args) => {
      if (!probe) {
        const start = performance.now()
        probe = new Promise((resolve, reject) => setImmediate(() => {
          f.app.inject({ method: "GET", url: "/fixture-heartbeat" }).then((response) => {
            probeMs = performance.now() - start
            resolve(response.json())
          }, reject)
        }))
      }
      return observeWork(() => setPassword(...args), state)
    }
    const start = performance.now()
    const responses = await Promise.all(Array.from({ length: 4 }, (_, index) => f.app.inject({
      method: "POST", url: "/api/auth/password", headers: { cookie },
      payload: { password: `new-password-${index}` },
    })))
    const witness = await probe!
    t.diagnostic(JSON.stringify({ operation: "password", totalMs: performance.now() - start, probeMs, ...state, witness }))
    for (const response of responses) {
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json(), { ok: true, username, passwordUserProvided: true })
    }
    assert.equal(await f.manager.validateLogin(username, "new-password-3"), true)
    const persisted = JSON.parse(await fs.readFile(path.join(f.directory, "auth.json"), "utf8"))
    assert.equal(persisted.version, 1)
    assert.equal(persisted.password.algorithm, "scrypt")
    assert.ok(witness.pending > 0, "the HTTP witness must run before all expensive password changes finish")
  } finally {
    await f.close()
  }
})
