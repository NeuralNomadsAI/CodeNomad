import assert from "node:assert/strict"
import { test } from "node:test"
import { createAuthRecovery } from "./auth-recovery"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test("coalesces status checks and only explicit unauthenticated status opens recovery", async () => {
  let calls = 0
  const response = deferred<Response>()
  const recovery = createAuthRecovery("https://fixture.invalid", async (input, init) => {
    calls++
    assert.equal(String(input), "https://fixture.invalid/api/auth/status")
    assert.equal(init?.credentials, "include")
    assert.equal(init?.cache, "no-store")
    return response.promise
  })
  const first = recovery.check(), second = recovery.check()
  assert.equal(calls, 1)
  response.resolve(Response.json({ authenticated: false }))
  await Promise.all([first, second])
  assert.equal(recovery.required(), true)
  for (const body of [{}, { authenticated: "false" }, { authenticated: true }]) {
    const other = createAuthRecovery(undefined, async () => Response.json(body))
    await other.check()
    assert.equal(other.required(), false)
  }
  for (const result of [async () => new Response("down", { status: 503 }), async () => { throw Error("offline") }]) {
    const other = createAuthRecovery(undefined, result)
    await other.check()
    assert.equal(other.required(), false)
  }
})

test("login fences probes begun before and during authentication", async () => {
  for (const during of [false, true]) {
    const status = deferred<Response>(), login = deferred<Response>()
    let restored = 0, requests = 0
    const recovery = createAuthRecovery(undefined, async (input) => {
      if (String(input).endsWith("/login")) return login.promise
      requests++
      return requests === 1 ? Response.json({ authenticated: false }) : status.promise
    })
    recovery.onRestored(() => { restored++ })
    await recovery.check()
    const pendingStatus = during ? undefined : recovery.check()
    const pendingLogin = recovery.signIn("person", "secret")
    const duringStatus = during ? recovery.check() : undefined
    login.resolve(Response.json({ ok: true }))
    assert.equal(await pendingLogin, "ok")
    status.resolve(Response.json({ authenticated: false }))
    await Promise.all([pendingStatus, duringStatus])
    assert.equal(recovery.required(), false)
    assert.equal(restored, 1)
  }
})

test("wrong credentials, offline login and malformed success preserve recovery without replay", async () => {
  for (const [status, body, expected] of [[401, {}, "credentials"], [503, {}, "unavailable"], [200, {}, "unavailable"]] as const) {
    const requests: string[] = []
    const recovery = createAuthRecovery(undefined, async (input) => {
      requests.push(String(input))
      return String(input).endsWith("/status") ? Response.json({ authenticated: false }) : Response.json(body, { status })
    })
    await recovery.check()
    assert.equal(await recovery.signIn("person", "secret"), expected)
    assert.equal(recovery.required(), true)
    assert.deepEqual(requests, ["/api/auth/status", "/api/auth/login"])
  }
})

test("a renewed cookie in another tab restores once without a login POST", async () => {
  let authenticated = false, notifications = 0
  const recovery = createAuthRecovery(undefined, async () => Response.json({ authenticated }))
  const unsubscribe = recovery.onRestored(() => { notifications++ })
  await recovery.check()
  authenticated = true
  await recovery.check()
  await recovery.check()
  assert.equal(recovery.required(), false)
  assert.equal(notifications, 1)
  unsubscribe()
})
