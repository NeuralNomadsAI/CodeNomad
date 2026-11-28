import assert from "node:assert/strict"
import { test } from "node:test"
import { authenticatedFetch, authRecovery, createAuthenticatedFetch, createAuthRecovery } from "./auth-recovery"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test("a confirmed local expiration renews and reconnects without replaying the failed request", async () => {
  const observed: string[] = []
  let authenticated = false
  const transport: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/api/auth/status")) {
      observed.push("status")
      return Response.json({ authenticated })
    }
    observed.push(init?.method ?? "GET")
    return new Response(null, { status: 401 })
  }
  const recovery = createAuthRecovery(undefined, transport, undefined, async () => {
    observed.push("renew")
    authenticated = true
    return true
  })
  recovery.onRestored(() => observed.push("reconnect"))
  assert.equal((await createAuthenticatedFetch(recovery, transport)("/api/example", { method: "POST" })).status, 401)
  await recovery.check()
  assert.deepEqual(observed, ["POST", "status", "renew", "status", "reconnect"])
  assert.equal(recovery.required(), false)
})

test("a paired device never asks the local host to renew", async () => {
  const recovery = createAuthRecovery(undefined,
    async () => Response.json({ authenticated: false, pairingRequired: true }), undefined,
    async () => assert.fail("paired device offered local renewal"))
  await recovery.check()
  assert.equal(recovery.pairingRequired(), true)
})

test("validation stays local and authentication still probes globally without replaying the action", async () => {
  const original = globalThis.fetch, requests: string[] = []
  let status = 400
  globalThis.fetch = async input => {
    requests.push(String(input))
    return String(input).endsWith("/api/auth/status") ? Response.json({ authenticated: false }) : Response.json({}, { status })
  }
  try {
    await authenticatedFetch("/api/workspaces/fixture/missions/recurrence/schedule/control", { method: "POST" })
    assert.equal(requests.length, 1)
    status = 401
    await authenticatedFetch("/api/workspaces/fixture/missions/recurrence/schedule/control", { method: "POST" })
    await authRecovery.check()
    assert.equal(authRecovery.required(), true)
    assert.deepEqual(requests, ["/api/workspaces/fixture/missions/recurrence/schedule/control",
      "/api/workspaces/fixture/missions/recurrence/schedule/control", "/api/auth/status"])
  } finally { globalThis.fetch = original }
})

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

test("auth status transport stops at caller cancellation and at its own deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  for (const cancelled of [true, false]) {
    const caller = new AbortController()
    const response = deferred<Response>()
    let network: AbortSignal | null | undefined
    const recovery = createAuthRecovery(undefined, async (_input, init) => {
      network = init?.signal
      return response.promise
    })
    const pending = recovery.check(caller.signal)
    assert.equal(network?.aborted, false)
    if (cancelled) caller.abort()
    else t.mock.timers.tick(8000)
    assert.equal(network?.aborted, true)
    response.resolve(Response.json({ authenticated: false }))
    await pending
    assert.equal(recovery.required(), false)
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

test("an unpaired Remote Control device recovers by pairing, not by password", async () => {
  let body: Record<string, unknown> = { authenticated: false, pairingRequired: true }
  const recovery = createAuthRecovery(undefined, async () => Response.json(body))
  await recovery.check()
  assert.equal(recovery.required(), true)
  assert.equal(recovery.pairingRequired(), true)
  // Pairing again in another tab shares the device cookie.
  body = { authenticated: true }
  await recovery.check()
  assert.equal(recovery.required(), false)

  const local = createAuthRecovery(undefined, async () => Response.json({ authenticated: false }))
  await local.check()
  assert.equal(local.pairingRequired(), false)
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
