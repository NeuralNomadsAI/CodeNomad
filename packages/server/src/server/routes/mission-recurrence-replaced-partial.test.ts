import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import Fastify from "fastify"
import pino from "pino"
import { AuthManager } from "../../auth/manager"
import { canonicalScope } from "../../host-lifetime/protocol"
import type { MissionStorage } from "../../missions/journal"
import type { MissionJsonValue } from "../../missions/model"
import { NativeMissionRecurrenceStore, recurrenceRequestRefusal } from "../../missions/recurrence-store"
import { canonicalWorktreeIdentity } from "../../workspaces/manager"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerMissionRecurrenceControl } from "./mission-recurrence-control"
import { registerMissionRecurrenceControlStatus } from "./mission-recurrence-control-status"

const current = () => true as const
const scheduleID = "daily_review"
type Input = { requestID: string; action: "pause" | "stop"; expectedRevision: number; retry?: boolean
  profileSource?: Parameters<NativeMissionRecurrenceStore["beginControl"]>[3] }
const gate = () => { let open!: () => void; return { wait: new Promise<void>(resolve => { open = resolve }), open } }
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 30_000
  while (!predicate()) {
    assert(Date.now() < deadline, "the expected fixture stage was never reached")
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
const memoryStorage = (): MissionStorage => {
  const values = new Map<string, MissionJsonValue>()
  return { get: async key => structuredClone(values.get(key)),
    set: async (key, value, fence) => { fence?.(); values.set(key, structuredClone(value)) }, scan: async () => ({ entries: [] }) }
}

/** One CodeNomad backend whose owned ServiceConnection is replaced in place (event
 * stream EOF, failed request, new daemon PID), with real routes, AuthManager,
 * fence, holds and recurrence store behind a native stand-in. */
async function fixture(drainTimeoutMs = 300) {
  await mkdir(path.join(tmpdir(), "opencode"), { recursive: true })
  const base = await mkdtemp(path.join(tmpdir(), "opencode", "recurrence-replaced-"))
  const other = path.join(base, "other")
  execFileSync("git", ["init", "-q", base]); execFileSync("git", ["init", "-q", other])
  const directory = realpathSync(base), otherDirectory = realpathSync(other), checkout = canonicalWorktreeIdentity(directory)
  const yaml = path.join(base, "selected.yml")
  await writeFile(yaml, "server: {}\n"); await writeFile(path.join(base, "other.yml"), "server: {}\n")
  const auth = new AuthManager({ configPath: yaml, username: "human", password: "offline", generateToken: false }, pino({ level: "silent" }) as never)
  const human = auth.createSession("human")
  const store = new NativeMissionRecurrenceStore(memoryStorage(), "project", directory)
  const execution = { agent: "worker", model: { providerID: "provider", id: "model" } }
  let doc = await store.create(scheduleID, { title: "Review", template: "custom", consigne: "Review.", clock: { time: "07:00", zone: "UTC" },
    profileID: canonicalScope("stable", yaml, base, base).key, executionHost: "local", profiles: { coordinator: execution, roles: { specialist: execution } },
    taskMode: "native", roots: [{ mode: "directory-only", directory }], watchedConversationIDs: [] }, Date.now(), current)
  doc = await store.setState(scheduleID, doc.revision, "running", current)
  const native = { controls: 0, statuses: 0, controlGate: undefined as Promise<void> | undefined, onStatus: () => {}, statusFails: false }
  /** Native plugin stand-in over one native database. Only an exact retry of an
   * existing record completes it, mirroring controlNativeRecurrence. */
  const nativeRpc = (db: NativeMissionRecurrenceStore) => ({
    recurrenceControl: async (input: Input) => {
      native.controls++
      await native.controlGate
      const previous = (await db.read(scheduleID))?.controls.find(item => item.requestID === input.requestID)
      const begun = await db.beginControl(scheduleID, input, current, input.profileSource)
      const record = begun.controls.find(item => item.requestID === input.requestID)!
      if (record.controlsComplete || !previous || !input.retry) return { version: 1, scheduleID, ...record }
      const complete = { ...record, schedulerCancellation: "acknowledged" as const, targetsKnown: true, controlsComplete: true }
      await db.recordControl(scheduleID, complete, current)
      return { version: 1, scheduleID, ...complete }
    },
    recurrenceControlStatus: async (input: Input) => {
      native.statuses++
      native.onStatus()
      if (native.statusFails) throw new Error("Native storage identity unavailable")
      const saved = await db.read(scheduleID)
      const identity = { version: 1, scheduleID, requestID: input.requestID, expectedRevision: input.expectedRevision }
      const record = saved?.controls.find(item => item.requestID === input.requestID)
      if (record) { const { targetsKnown: _k, ...status } = record; return { ...identity, ...status, outcome: record.controlsComplete ? "committed" : "unknown" } }
      const reason = saved && recurrenceRequestRefusal(saved, input)
      return reason ? { ...identity, outcome: "rejected", reason } : { ...identity, outcome: "unknown" }
    },
  })
  const env = { principal: human.id as string, yaml, workspace: {} as object, project: "project", db: store }
  const fence = new WorktreeDeletionFence(drainTimeoutMs)
  const makeConnection = () => {
    const rpc = nativeRpc(env.db)
    const connection = { current: true, client: { location: { get: async (input: { location: { directory: string } }) =>
      ({ directory: input.location.directory, project: { id: env.project, canonical: directory } }) }, rpc: () => rpc },
    assertCurrent() { if (!connection.current) throw new Error("OpenCode connection changed; refresh before retrying") } }
    return connection
  }
  const state = { connection: makeConnection() }
  const manager = { get: () => env.workspace, getServiceLocation: () => ({ directory }),
    getServiceDirectoryForPath: async (_id: string, requested: string) => realpathSync(requested),
    getSharedServiceConnection: async () => state.connection, ownsLocation: async () => true,
    getServiceWslDistro: () => undefined, getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
    getWorktreeIdentityForPath: async (_id: string, requested: string) => canonicalWorktreeIdentity(requested),
    getHostPathForServicePath: async (_id: string, requested: string) => requested }
  const app = Fastify({ logger: false })
  const deps = { auth: { isAuthEnabled: () => auth.isAuthEnabled(), getSessionFromRequest: (request: Parameters<AuthManager["getSessionFromRequest"]>[0]) => {
    const verified = auth.getSessionFromRequest(request)
    // Fault injection only: simulate the principal changing during preparation.
    return verified && { ...verified, sessionId: env.principal }
  } }, bridgeToken: "token", fence, manager,
  settings: { configYamlPathForAuthority: () => env.yaml, getProfileScope: () => canonicalScope("stable", env.yaml, base, base) } }
  registerMissionRecurrenceControl(app, deps as never)
  registerMissionRecurrenceControlStatus(app, deps as never)
  const headers = { cookie: `${auth.getCookieName()}=${human.id}` }
  const send = (payload: Record<string, unknown>) => app.inject({ method: "POST",
    url: `/api/workspaces/owned/missions/recurrence/${scheduleID}/control`, headers, payload })
  const status = (payload: Record<string, unknown>) => app.inject({ method: "POST",
    url: `/api/workspaces/owned/missions/recurrence/${scheduleID}/control/status`, headers, payload })
  /** The same backend replaces its owned connection; native and its record survive. */
  const replace = () => { state.connection.current = false; state.connection = makeConnection() }
  // An exclusive deletion drains every admitted permit; a held one makes it time out
  // (and unblock) quickly, so a probe never leaves a queued deletion behind.
  const deletionRuns = () => fence.run(directory, [checkout], async () => true).catch(() => false)
  const record = async (requestID: string) => (await store.read(scheduleID))!.controls.find(item => item.requestID === requestID)
  const revision = async () => (await store.read(scheduleID))!.revision
  return { base, directory, otherDirectory, checkout, store, native, env, fence, state, app, send, status, replace, deletionRuns, record, revision,
    reset: () => Object.assign(native, { onStatus: () => {}, statusFails: false, controlGate: undefined }) }
}

for (const action of ["pause", "stop"] as const) test(`an exact partial ${action} survives same-backend connection replacement and an explicit retry settles it`, async () => {
  const f = await fixture()
  try {
    const expectedRevision = await f.revision(), request = { action, expectedRevision, requestID: `${action}_partial` }
    assert.equal((await f.send(request)).json().controlsComplete, false, "native recorded a partial control")
    f.replace()
    for (let round = 0; round < 3; round++) {
      const read = await f.status(request)
      assert.deepEqual([read.statusCode, read.json().outcome, read.json().controlsComplete], [200, "unknown", false], read.body)
      if (round < 2) f.replace() // repeated ordinary replacements never transfer the original permit
    }
    const fresh = await f.send({ action: "stop", expectedRevision: await f.revision(), requestID: "stop_fresh" })
    assert.deepEqual([fresh.statusCode, fresh.json().code], [409, "recurrence-not-dispatched"], "another identity remains blocked")
    assert.equal(await f.deletionRuns(), false, "the original permit still fences deletion")
    const retried = await f.send({ ...request, retry: true })
    assert.equal(retried.statusCode, 200, retried.body)
    assert.deepEqual([retried.json().requestID, retried.json().revision, retried.json().state, retried.json().controlsComplete],
      [request.requestID, expectedRevision + 1, action === "pause" ? "paused" : "stopped", true], "original identity, revision and state")
    assert.equal(f.native.controls, 2, "exactly one explicit resend of the exact partial identity")
    assert.equal((await f.store.read(scheduleID))!.state, action === "pause" ? "paused" : "stopped")
    assert.equal(await f.deletionRuns(), true, "both permits are released: exclusive deletion proceeds")
    const resume = await f.send({ action: "resume", expectedRevision: await f.revision(), requestID: "resume_after" })
    assert.equal(resume.statusCode, action === "pause" ? 200 : 409, action === "pause" ? resume.body : "Stop remains terminal")
  } finally { await f.app.close(); await rm(f.base, { recursive: true, force: true }) }
})

test("a replacement retry fails closed without effects on foreign storage, owner, Location, profile, principal or connection changes", async () => {
  const f = await fixture()
  try {
    const expectedRevision = await f.revision(), request = { action: "pause", expectedRevision, requestID: "pause_partial" }
    // An in-flight original on the retired connection is never stolen.
    const inflight = gate(); f.native.controlGate = inflight.wait
    const original = f.send(request)
    await until(() => f.native.controls > 0)
    f.replace()
    const stolen = await f.send({ ...request, retry: true })
    assert.deepEqual([stolen.statusCode, stolen.json().code, f.native.controls], [503, undefined, 1], stolen.body)
    inflight.open(); f.native.controlGate = undefined
    assert.equal((await original).json().controlsComplete, false)
    f.replace()

    const refused = async (label: string, payload: Record<string, unknown>, arrange: () => (() => void) | void) => {
      const controls = f.native.controls, restore = arrange()
      const reply = await f.send(payload)
      assert.notEqual(reply.statusCode, 200, `${label}: ${reply.body}`)
      assert.equal(reply.json().code, undefined, `${label}: a retry is never coded as no effect`)
      assert.equal(f.native.controls, controls, `${label}: nothing dispatched`)
      restore?.(); f.reset()
      assert.equal(await f.deletionRuns(), false, `${label}: the original permit is retained`)
      assert.equal((await f.record(request.requestID))?.controlsComplete, false, `${label}: the partial record is untouched`)
    }
    const retry = { ...request, retry: true }
    await refused("different native database", retry, () => {
      f.env.db = new NativeMissionRecurrenceStore(memoryStorage(), "project", f.directory); f.replace()
      return () => { f.env.db = f.store; f.replace() }
    })
    await refused("native storage identity unknown", retry, () => { f.native.statusFails = true })
    await refused("different native project", retry, () => { f.env.project = "other"; return () => { f.env.project = "project" } })
    await refused("different workspace", retry, () => { const saved = f.env.workspace; f.env.workspace = {}; return () => { f.env.workspace = saved } })
    await refused("different directory", { ...retry, directory: f.otherDirectory }, () => {})
    await refused("different action", { ...retry, action: "stop" }, () => {})
    await refused("different revision", { ...retry, expectedRevision: expectedRevision + 1 }, () => {})
    await refused("changed Settings profile", retry, () => {
      const saved = f.env.yaml; f.env.yaml = path.join(f.base, "other.yml"); return () => { f.env.yaml = saved }
    })
    await refused("changed principal", retry, () => { f.native.onStatus = () => { f.env.principal += "_other" }
      return () => { f.env.principal = f.env.principal.replace(/_other$/, "") } })
    await refused("connection retired again", retry, () => { f.native.onStatus = () => { f.replace() } })
    assert.equal(f.native.statuses > 0, true)

    const settled = await f.send(retry)
    assert.deepEqual([settled.statusCode, settled.json().controlsComplete, f.native.controls], [200, true, 2], settled.body)
    assert.equal(await f.deletionRuns(), true)
  } finally { await f.app.close(); await rm(f.base, { recursive: true, force: true }) }
})

test("a deletion already queued behind the retired permit blocks new admission; only a read can settle it", async () => {
  const f = await fixture(30_000)
  try {
    const expectedRevision = await f.revision(), request = { action: "stop", expectedRevision, requestID: "stop_partial" }
    assert.equal((await f.send(request)).json().controlsComplete, false)
    f.replace()
    let deleted = false
    const deletion = f.fence.run(f.directory, [f.checkout], async () => { deleted = true; return true })
    const retry = await f.send({ ...request, retry: true })
    assert.deepEqual([retry.statusCode, retry.json().code, f.native.controls], [503, undefined, 1], "no mutation while deletion is entering")
    const partial = await f.status(request)
    assert.deepEqual([partial.statusCode, partial.json().controlsComplete, deleted], [200, false, false], "a partial read never releases")
    // Native completes the exact record elsewhere; this backend's targeted read re-proves the
    // owner through the current connection and settles the retained permit read-only.
    const saved = (await f.record(request.requestID))!
    await f.store.recordControl(scheduleID, { ...saved, schedulerCancellation: "acknowledged", targetsKnown: true, controlsComplete: true }, current)
    const committed = await f.status(request)
    assert.deepEqual([committed.statusCode, committed.json().outcome], [200, "committed"], committed.body)
    assert.equal(await deletion, true, "the queued exclusive deletion entered")
    assert.equal(f.native.controls, 1, "the status read never resent")
  } finally { await f.app.close(); await rm(f.base, { recursive: true, force: true }) }
})

