import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import test from "node:test"
import { Service } from "@opencode/client/service"
import { createNativeScheduleTransport, NATIVE_SCHEDULE_TRANSPORT_RESPONSE_BYTES, NATIVE_SCHEDULE_TRANSPORT_TIMEOUT_MS } from "./native-schedule-transport"
import { nativeScheduleIncarnationGuard, readNativeScheduleIncarnation } from "./native-schedule-transport-identity"
import { nativeScheduleWakeKey } from "./native-schedule-transport-contract"
import type { NativeScheduleWake } from "./native-schedule-transport-contract"

const scratch = process.env.CODENOMAD_SCHEDULE_TEST_SCRATCH ?? path.join(os.tmpdir(), "codenomad-schedule-transport")
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

function fixture(t: test.TestContext) {
  mkdirSync(scratch, { recursive: true })
  const directory = mkdtempSync(path.join(scratch, "transport-unit-")), registrationFile = path.join(directory, "registration.json")
  const identity = { id: "unit-incarnation", pid: process.pid, url: "http://127.0.0.1:1", version: "99.7.0-compatible" }
  const register = (changes: Record<string, unknown> = {}) => writeFileSync(registrationFile, JSON.stringify({ ...identity, password: "fixture-only-secret", ...changes }))
  register()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const wake: NativeScheduleWake = { missionID: path.basename(directory), generation: 2,
    scheduleID: "sch_owned", run: 1, sessionID: "ses_carrier", messageID: "msg_sch_owned_1" }
  const request = { registrationFile, directory, wake }
  const reply = () => new Response(JSON.stringify({ output: { key: nativeScheduleWakeKey(wake), state: "applied" } }),
    { headers: { "content-type": "application/json" } })
  return { directory, registrationFile, identity, register, request, reply,
    discover: async () => ({ url: identity.url, auth: undefined }) }
}

test("official exact discovery, headers and RPC stay read-only with respect to service lifetime", async t => {
  const f = fixture(t), calls: { method?: string; path: string }[] = []
  for (const method of ["ensure", "stop"] as const) t.mock.method(Service, method, () => { throw new Error("Forbidden service lifecycle") })
  for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const)
    t.mock.method(childProcess, method, () => { throw new Error("Forbidden child") })
  t.mock.method(process, "kill", () => { throw new Error("Forbidden signal") })
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, Service.headers({ url: f.identity.url,
      auth: { type: "basic", username: "opencode", password: "fixture-only-secret" } })?.authorization)
    calls.push({ method: req.method, path: req.url! })
    res.setHeader("content-type", "application/json")
    if (req.url === "/api/info") { res.end(JSON.stringify({ version: f.identity.version, pid: process.pid })); return }
    const url = new URL(req.url!, f.identity.url)
    assert.equal(url.pathname, "/api/rpc/codenomad.missions.schedule/wake")
    assert.equal(url.searchParams.get("location[directory]"), f.directory)
    let body = ""
    for await (const chunk of req) body += chunk
    const { input } = JSON.parse(body)
    assert.deepEqual(input.wake, f.request.wake)
    assert.deepEqual(input.incarnation, f.identity)
    assert.equal(input.registrationFile, f.registrationFile)
    assert.equal(JSON.stringify(input).includes("fixture-only-secret"), false)
    nativeScheduleIncarnationGuard(f.registrationFile, input.incarnation)()
    res.end(JSON.stringify({ output: { key: nativeScheduleWakeKey(input.wake), state: "applied" } }))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  assert(address && typeof address === "object")
  assert.notEqual(address.port, 28894)
  f.identity.url = `http://127.0.0.1:${address.port}`
  f.register()
  let claims = 0
  const hintedWake = { ...f.request.wake, dueAt: 42, late: true }
  const result = await createNativeScheduleTransport().wake({ ...f.request, wake: hintedWake, claim: async () => { claims++; return true } })
  assert.deepEqual(result, { state: "received", reply: { key: nativeScheduleWakeKey(f.request.wake), state: "applied" } })
  assert.equal(claims, 1)
  assert.deepEqual(calls.map(call => call.method), ["GET", "GET", "POST"])
  assert.deepEqual(readNativeScheduleIncarnation(f.registrationFile), f.identity)
  assert.equal("password" in readNativeScheduleIncarnation(f.registrationFile), false)
})

test("registration parser and RPC guard require the exact own nonsecret incarnation", t => {
  const f = fixture(t)
  const guard = nativeScheduleIncarnationGuard(f.registrationFile, f.identity)
  assert.equal(guard(), true)
  for (const changes of [{ id: undefined }, { id: "" }, { pid: 0 }, { pid: 1.5 }, { url: "https://example.com" },
    { url: "http://user:secret@127.0.0.1:1" }, { version: 221 }]) {
    f.register(changes)
    assert.throws(() => readNativeScheduleIncarnation(f.registrationFile))
  }
  for (const changes of [{ id: "replacement" }, { pid: process.pid + 1 }, { version: "different" }, { url: "http://127.0.0.1:2" }]) {
    f.register(changes)
    assert.throws(guard, /incarnation-changed/)
  }
  f.register({ password: "x".repeat(32 * 1024) })
  assert.throws(() => readNativeScheduleIncarnation(f.registrationFile), /registration-size/)
  assert.throws(() => readNativeScheduleIncarnation("registration.json"), /registration-path/)
})

test("missing, wrong process and changing same-URL incarnations refuse before dispatch", async t => {
  const f = fixture(t)
  let sends = 0, claims = 0, probes = 0
  const fetcher: typeof fetch = async () => { sends++; return f.reply() }
  const claim = async () => { claims++; return true }
  assert.deepEqual(await createNativeScheduleTransport({ discover: async () => undefined, fetch: fetcher }).wake({ ...f.request, claim }),
    { state: "not-dispatched", reason: "unavailable" })
  assert.deepEqual(await createNativeScheduleTransport({ discover: async options => {
    assert.deepEqual(options, { file: f.registrationFile })
    if (++probes === 2) f.register({ id: "replacement" })
    return f.discover()
  }, fetch: fetcher }).wake({ ...f.request, claim }), { state: "not-dispatched", reason: "unavailable" })
  f.register({ pid: process.pid + 1 })
  assert.equal((await createNativeScheduleTransport({ discover: f.discover, fetch: fetcher }).wake({ ...f.request, claim })).state, "not-dispatched")
  assert.equal(claims, 0)
  assert.equal(sends, 0)
})

test("a late discovery expires at the eight-second deadline, retains its lane, and never POSTs", async t => {
  const f = fixture(t), pending = deferred<Awaited<ReturnType<typeof Service.discover>>>()
  let probes = 0, sends = 0
  const overrides = { discover: async () => { probes++; return pending.promise }, fetch: (async () => { sends++; return f.reply() }) as typeof fetch }
  const transport = createNativeScheduleTransport(overrides)
  assert.equal(NATIVE_SCHEDULE_TRANSPORT_TIMEOUT_MS, 8000)
  assert.deepEqual(await transport.wake({ ...f.request, claim: async () => true }), { state: "not-dispatched", reason: "deadline" })
  // A second bundle/adapter and a moved-directory hint cannot create another lane.
  assert.deepEqual(await createNativeScheduleTransport(overrides).status({ ...f.request, directory: path.dirname(f.directory) }),
    { state: "not-dispatched", reason: "busy" })
  assert.equal(probes, 1)
  pending.resolve(await f.discover())
  await tick()
  assert.equal(sends, 0)
})

test("lost mutation reply remains held across adapters and unknown status never authorizes resend", async t => {
  const f = fixture(t)
  let held = false, effects = 0, statusReads = 0
  const claim = async () => { if (held) return false; held = true; return true }
  const fetcher: typeof fetch = async input => {
    if (String(input).includes("/status")) {
      statusReads++
      return new Response(JSON.stringify({ output: { key: nativeScheduleWakeKey(f.request.wake), state: "unknown" } }),
        { headers: { "content-type": "application/json" } })
    }
    effects++
    throw new Error("ACK lost after remote effect")
  }
  const transport = () => createNativeScheduleTransport({ discover: f.discover, fetch: fetcher })
  assert.deepEqual(await transport().wake({ ...f.request, claim }), { state: "uncertain", reason: "unavailable" })
  assert.deepEqual(await transport().wake({ ...f.request, claim }), { state: "not-dispatched", reason: "held" })
  assert.deepEqual(await transport().wake({ ...f.request,
    wake: { ...f.request.wake, run: 2, messageID: "msg_sch_owned_2" }, claim }), { state: "not-dispatched", reason: "held" })
  assert.deepEqual(await transport().status(f.request), { state: "received", reply: { key: nativeScheduleWakeKey(f.request.wake), state: "unknown" } })
  assert.deepEqual(await transport().wake({ ...f.request, claim }), { state: "not-dispatched", reason: "held" })
  assert.equal(effects, 1)
  assert.equal(statusReads, 1)
})

test("the absolute deadline also fences dispatch when the timer has not run", async t => {
  const f = fixture(t)
  let clock = 0, sends = 0
  t.mock.method(performance, "now", () => clock)
  const transport = createNativeScheduleTransport({ discover: async () => {
    clock += NATIVE_SCHEDULE_TRANSPORT_TIMEOUT_MS + 1
    return f.discover()
  }, fetch: async () => { sends++; return f.reply() } })
  assert.deepEqual(await transport.wake({ ...f.request, claim: async () => true }), { state: "not-dispatched", reason: "deadline" })
  assert.equal(sends, 0)
})

test("incarnation replacement after dispatch refuses stale response publication", async t => {
  const f = fixture(t)
  const transport = createNativeScheduleTransport({ discover: f.discover, fetch: async () => {
    f.register({ id: "after-dispatch" })
    return f.reply()
  } })
  assert.deepEqual(await transport.wake({ ...f.request, claim: async () => true }), { state: "uncertain", reason: "unavailable" })
})

test("replacement after durable intent refuses dispatch without clearing the intent", async t => {
  const f = fixture(t)
  let held = false, sends = 0
  const transport = createNativeScheduleTransport({ discover: f.discover, fetch: async () => { sends++; return f.reply() } })
  assert.equal((await transport.wake({ ...f.request, claim: async () => {
    held = true; f.register({ id: "after-intent" }); return true
  } })).state, "not-dispatched")
  assert.equal(sends, 0)
  assert.equal(held, true)
})

test("timeout after dispatch preserves uncertainty and keeps one physical call in flight", async t => {
  const f = fixture(t), dispatched = deferred<void>(), response = deferred<Response>(), cancel = new AbortController()
  let signal: AbortSignal | null | undefined, sends = 0
  const transport = createNativeScheduleTransport({ discover: f.discover, fetch: async (_input, init) => {
    signal = init?.signal; sends++; dispatched.resolve(); return response.promise
  } })
  const first = transport.wake({ ...f.request, signal: cancel.signal, claim: async () => true })
  await dispatched.promise
  cancel.abort()
  assert.deepEqual(await first, { state: "uncertain", reason: "deadline" })
  assert.equal(signal?.aborted, true)
  assert.deepEqual(await transport.status(f.request), { state: "not-dispatched", reason: "busy" })
  response.resolve(f.reply())
  await tick()
  assert.equal(sends, 1)
})

test("declared and streamed responses above one MiB cancel and stay uncertain", async t => {
  const f = fixture(t)
  assert.equal(NATIVE_SCHEDULE_TRANSPORT_RESPONSE_BYTES, 1024 * 1024)
  for (const declared of [true, false]) {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(NATIVE_SCHEDULE_TRANSPORT_RESPONSE_BYTES + 1)) },
      cancel() { cancelled = true },
    })
    const transport = createNativeScheduleTransport({ discover: f.discover, fetch: async () => new Response(body,
      { headers: declared ? { "content-length": String(NATIVE_SCHEDULE_TRANSPORT_RESPONSE_BYTES + 1) } : {} }) })
    assert.deepEqual(await transport.wake({ ...f.request, claim: async () => true }), { state: "uncertain", reason: "unavailable" })
    assert.equal(cancelled, true)
  }
})

test("input and exact response identity are fenced; foreign output never settles a wake", async t => {
  const f = fixture(t)
  let sends = 0
  const transport = createNativeScheduleTransport({ discover: f.discover, fetch: async () => {
    sends++
    return new Response(JSON.stringify({ output: { key: "foreign", state: "applied" } }), { headers: { "content-type": "application/json" } })
  } })
  assert.equal((await transport.wake({ ...f.request, wake: { ...f.request.wake, messageID: "msg_forged" }, claim: async () => true })).state, "not-dispatched")
  assert.equal(sends, 0)
  assert.deepEqual(await transport.wake({ ...f.request, claim: async () => true }), { state: "uncertain", reason: "unavailable" })
})

test("exact-message status evidence is a typed read hint and never overrides a held mutation", async t => {
  const f = fixture(t)
  let writes = 0, invalid = false
  const transport = createNativeScheduleTransport({ discover: f.discover, fetch: async (input) => {
    if (!String(input).includes("/status")) writes++
    return new Response(JSON.stringify({ output: { key: nativeScheduleWakeKey(f.request.wake), state: "unknown",
      messagePresent: invalid ? "true" : true } }), { headers: { "content-type": "application/json" } })
  } })
  assert.deepEqual(await transport.status(f.request), { state: "received", reply: {
    key: nativeScheduleWakeKey(f.request.wake), state: "unknown", messagePresent: true,
  } })
  assert.deepEqual(await transport.wake({ ...f.request, claim: async () => false }), { state: "not-dispatched", reason: "held" })
  assert.equal(writes, 0)
  invalid = true
  assert.deepEqual(await transport.status(f.request), { state: "uncertain", reason: "unavailable" })
})
