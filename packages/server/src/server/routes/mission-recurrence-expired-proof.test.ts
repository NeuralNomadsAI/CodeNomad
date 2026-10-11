import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Context, Effect } from "effect"
import Fastify from "fastify"
import pino from "pino"
import { AuthManager } from "../../auth/manager"
import { canonicalScope } from "../../host-lifetime/protocol"
import type { MissionStorage } from "../../missions/journal"
import type { MissionJsonValue } from "../../missions/model"
import { assertRecurrenceProofFresh } from "../../missions/recurrence-control-proof"
import { NativeMissionRecurrenceStore } from "../../missions/recurrence-store"
import { readNativeRecurrenceControlStatus } from "../../opencode/missions/native-recurrence-control-status"
import { readNativeRecurrenceRunNow } from "../../opencode/missions/native-recurrence-manual"
import { canonicalWorktreeIdentity } from "../../workspaces/manager"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerMissionRecurrenceControl } from "./mission-recurrence-control"
import { registerMissionRecurrenceControlStatus } from "./mission-recurrence-control-status"
import { registerMissionRecurrenceManual } from "./mission-recurrence-manual"

const current = () => true as const
const scheduleID = "daily_review"
type Input = { requestID: string; action: "play" | "pause" | "stop"; expectedRevision: number; issuedAt: number
  profileSource: NonNullable<Parameters<NativeMissionRecurrenceStore["beginControl"]>[3]> }
const gate = () => { let open!: () => void; return { wait: new Promise<void>(resolve => { open = resolve }), open } }
const settle = async (predicate: () => boolean) => {
  // Only Date is mocked; this bounded real-timer wait never advances the proof clock.
  for (let turn = 0; turn < 2000 && !predicate(); turn++) await new Promise(resolve => setTimeout(resolve, 5))
  assert(predicate(), "the expected fixture stage was never reached")
}

/** Real routes, holds, fence and AuthManager. Native writes follow
 * controlNativeRecurrence/runNativeRecurrenceNow through the real store (proof
 * freshness checked inside the CAS); exact status reads are the REAL native
 * readers over the same plugin storage. Date is mocked: no 30 s sleeps. */
async function fixture() {
  await mkdir(path.join(tmpdir(), "opencode"), { recursive: true })
  const base = await mkdtemp(path.join(tmpdir(), "opencode", "recurrence-expired-"))
  execFileSync("git", ["init", "-q", base])
  const directory = realpathSync(base), checkout = canonicalWorktreeIdentity(directory), yaml = path.join(base, "selected.yml")
  await writeFile(yaml, "server: {}\n")
  const auth = new AuthManager({ configPath: yaml, username: "human", password: "offline", generateToken: false }, pino({ level: "silent" }) as never)
  const human = auth.createSession("human")
  const values = new Map<string, MissionJsonValue>()
  const storage: MissionStorage = { get: async key => structuredClone(values.get(key)),
    set: async (key, value, fence) => { fence?.(); values.set(key, structuredClone(value)) }, scan: async () => ({ entries: [] }) }
  const store = new NativeMissionRecurrenceStore(storage, "project", directory)
  const execution = { agent: "worker", model: { providerID: "provider", id: "model" } }
  await store.create(scheduleID, { title: "Review", template: "custom", consigne: "Review.", clock: { time: "07:00", zone: "UTC" },
    profileID: canonicalScope("stable", yaml, base, base).key, executionHost: "local", profiles: { coordinator: execution, roles: { specialist: execution } },
    taskMode: "native", roots: [{ mode: "directory-only", directory }], watchedConversationIDs: [] }, Date.now(), current)
  // Real native readers: same plugin kv keys, read-only database graph.
  const graph = Context.make(Context.Service<never, unknown>("@opencode/storage/Database"), { db: {
    $client: Object.assign(() => {}, { unsafe: () => ({ withoutTransform: Effect.die("no SQL") }) }),
    transaction: () => Effect.die("status must not write") } })
  const ctx = { location: { directory, project: { id: "project", canonical: directory } }, storage: {
    get: (key: string) => Effect.sync(() => structuredClone(values.get(key))), set: () => Effect.die("No writes"), scan: () => Effect.die("No scans") } } as never
  const native = { controls: 0, failBeforeRecord: false, beforeRecord: undefined as Promise<void> | undefined,
    statusInputs: [] as Record<string, unknown>[], controlErrors: [] as string[] }
  const rpc = {
    recurrenceControl: async (input: Input) => {
      native.controls++
      if (native.failBeforeRecord) throw new Error("Recurrence transport authentication failed")
      try {
        await native.beforeRecord
        const begun = await store.beginControl(scheduleID, input, () => { assertRecurrenceProofFresh(input.issuedAt); return true }, input.profileSource)
        const record = begun.controls.find(item => item.requestID === input.requestID)!
        const complete = { ...record, schedulerCancellation: "acknowledged" as const, targetsKnown: true, controlsComplete: true }
        await store.recordControl(scheduleID, complete, current)
        return { version: 1, scheduleID, ...complete }
      } catch (error) { native.controlErrors.push((error as Error).message); throw error }
    },
    recurrenceControlStatus: (input: Record<string, unknown>) => {
      native.statusInputs.push(input)
      return Effect.runPromiseWith(graph)(readNativeRecurrenceControlStatus(ctx, input))
    },
    recurrenceRunNow: async (input: Input) => {
      native.controls++
      if (native.failBeforeRecord) throw new Error("Recurrence transport authentication failed")
      throw new Error("Run now admission is outside this fixture")
    },
    recurrenceRunNowStatus: (input: Record<string, unknown>) => {
      native.statusInputs.push(input)
      return Effect.runPromiseWith(graph)(readNativeRecurrenceRunNow(ctx, input))
    },
  }
  const makeConnection = () => {
    const connection = { current: true, client: { location: { get: async (input: { location: { directory: string } }) =>
      ({ directory: input.location.directory, project: { id: "project", canonical: directory } }) }, rpc: () => rpc },
    assertCurrent() { if (!connection.current) throw new Error("OpenCode connection changed") } }
    return connection
  }
  const state = { connection: makeConnection(), checkout }
  const workspace = {}
  const manager = { get: () => workspace, getServiceLocation: () => ({ directory }),
    getServiceDirectoryForPath: async (_id: string, requested: string) => realpathSync(requested),
    getSharedServiceConnection: async () => state.connection, ownsLocation: async () => true,
    getServiceWslDistro: () => undefined, getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
    getWorktreeIdentityForPath: async () => state.checkout, getHostPathForServicePath: async (_id: string, requested: string) => requested }
  const fence = new WorktreeDeletionFence(200)
  const app = Fastify({ logger: false })
  const deps = { auth: { isAuthEnabled: () => auth.isAuthEnabled(), getSessionFromRequest: (r: never) => auth.getSessionFromRequest(r) },
    bridgeToken: "token", fence, manager,
    settings: { configYamlPathForAuthority: () => yaml, getProfileScope: () => canonicalScope("stable", yaml, base, base) } }
  registerMissionRecurrenceControl(app, deps as never)
  registerMissionRecurrenceControlStatus(app, deps as never)
  registerMissionRecurrenceManual(app, deps as never)
  const headers = { cookie: `${auth.getCookieName()}=${human.id}` }
  const url = `/api/workspaces/owned/missions/recurrence/${scheduleID}`
  return { base, store, native, state, makeConnection, app,
    send: (payload: Record<string, unknown>) => app.inject({ method: "POST", url: `${url}/control`, headers, payload }),
    runNow: (payload: Record<string, unknown>) => app.inject({ method: "POST", url: `${url}/run-now`, headers, payload }),
    status: (payload: Record<string, unknown>) => app.inject({ method: "POST", url: `${url}/control/status`, headers, payload }),
    runNowStatus: (query: Record<string, string>) => app.inject({ method: "GET", url: `${url}/run-now/status?${new URLSearchParams(query)}`, headers }),
    // The real exclusive deletion: it drains admitted permits or times out (200 ms).
    deletionRuns: () => fence.run(directory, [checkout], async () => true).catch(() => false),
    revision: async () => (await store.read(scheduleID))!.revision, close: async () => { await app.close(); await rm(base, { recursive: true, force: true }) } }
}

test("a native refusal before any record releases its permit once native proves the exact held proof expired", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
  const f = await fixture()
  try {
    const expectedRevision = await f.revision(), play = { action: "play", expectedRevision, requestID: "play_lost" }
    f.native.failBeforeRecord = true
    const first = await f.send(play)
    assert.deepEqual([first.statusCode, first.json().code], [503, undefined], "dispatched: genuinely uncertain")
    f.native.failBeforeRecord = false
    // Still-valid proof: unknown, no hint sent, permit and deletion fence retained.
    const early = await f.status(play)
    assert.deepEqual([early.statusCode, early.json().outcome], [200, "unknown"])
    assert.equal(f.native.statusInputs.every(input => input.issuedAt === undefined), true, "an unexpired proof is never offered")
    assert.equal(await f.deletionRuns(), false)
    assert.equal((await f.send({ action: "stop", expectedRevision, requestID: "stop_blocked" })).json().code, "recurrence-not-dispatched")
    // A browser can never supply the proof time.
    assert.equal((await f.status({ ...play, issuedAt: 0 })).statusCode, 400)
    // Advance past the original proof's lifetime: native's own clock proves expiry.
    t.mock.timers.setTime(Date.now() + 30_000)
    const late = await f.status(play)
    assert.deepEqual([late.statusCode, late.json().outcome, late.json().reason], [200, "rejected", "control-conflict"])
    assert.equal(typeof f.native.statusInputs.at(-1)!.issuedAt, "number", "the backend's exact held issue time")
    assert.equal(await f.deletionRuns(), true, "the exclusive deletion fence is released")
    // Even a fresh, otherwise admissible attempt of the retired identity never records in this host.
    await assert.rejects(f.store.beginControl(scheduleID, { requestID: "play_lost", action: "play", expectedRevision }, current))
    assert.equal(await f.revision(), expectedRevision)
    const stop = await f.send({ action: "stop", expectedRevision, requestID: "stop_after" })
    assert.equal(stop.statusCode, 200)
    assert.equal((await f.store.read(scheduleID))!.controls.some(item => item.requestID === "play_lost"), false)
    assert.equal(f.native.controls, 2)
  } finally { await f.close() }
})

test("an in-flight original delayed past its proof expiry never records after native settles it", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
  const f = await fixture()
  try {
    const expectedRevision = await f.revision(), play = { action: "play", expectedRevision, requestID: "play_slow" }
    const delayed = gate(); f.native.beforeRecord = delayed.wait
    const original = f.send(play)
    await settle(() => f.native.controls === 1)
    // Dispatched and in flight: an exact read before expiry is unknown and retains it.
    assert.equal((await f.status(play)).json().outcome, "unknown")
    t.mock.timers.setTime(Date.now() + 30_000)
    assert.equal((await f.status(play)).json().outcome, "rejected")
    // Even a wall clock moved back (proof fresh again) cannot let the in-flight call record.
    t.mock.timers.setTime(Date.now() - 30_000)
    delayed.open()
    const reply = await original
    assert.deepEqual([reply.statusCode, reply.json().code], [409, "recurrence-control-conflict"])
    assert.equal(f.native.controlErrors.length, 1, "refused at the CAS although its proof looks fresh again")
    const doc = (await f.store.read(scheduleID))!
    assert.equal(doc.revision, expectedRevision, "no record and no effect")
    assert.equal(doc.controls.length, 0)
    assert.equal(await f.deletionRuns(), true)
  } finally { await f.close() }
})

test("expiry proof fails closed for an unheld identity, a mismatched owner after reconnect and a still-valid proof", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
  const f = await fixture()
  try {
    const expectedRevision = await f.revision(), play = { action: "play", expectedRevision, requestID: "play_owner" }
    f.native.failBeforeRecord = true
    assert.equal((await f.send(play)).statusCode, 503)
    f.native.failBeforeRecord = false
    // An identity this backend holds no permit for never carries a proof time.
    t.mock.timers.setTime(Date.now() + 30_000)
    const foreign = await f.status({ ...play, requestID: "play_unheld" })
    assert.equal(foreign.json().outcome, "unknown")
    assert.equal(f.native.statusInputs.at(-1)!.issuedAt, undefined)
    // Reconnect to a different checkout: the owner re-proof fails, the permit stays.
    f.state.connection.current = false; f.state.connection = f.makeConnection(); f.state.checkout = `${f.state.checkout}-moved`
    assert.equal((await f.status(play)).json().outcome, "rejected", "native may prove it ...")
    assert.equal(await f.deletionRuns(), false, "... but a mismatched owner never releases the permit")
  } finally { await f.close() }
})

test("an unrecorded Run now releases its permit once native proves its held proof expired", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
  const f = await fixture()
  try {
    const expectedRevision = await f.revision(), run = { expectedRevision, requestID: "run_lost" }
    f.native.failBeforeRecord = true
    const first = await f.runNow(run)
    assert.equal(first.statusCode, 503)
    const query = { requestID: run.requestID, expectedRevision: String(expectedRevision) }
    assert.equal((await f.runNowStatus(query)).json().outcome, "unknown")
    assert.equal(await f.deletionRuns(), false)
    t.mock.timers.setTime(Date.now() + 30_000)
    const late = await f.runNowStatus(query)
    assert.deepEqual([late.json().outcome, late.json().reason, late.json().passageID], ["rejected", "control-conflict", null])
    assert.equal(await f.deletionRuns(), true)
  } finally { await f.close() }
})
