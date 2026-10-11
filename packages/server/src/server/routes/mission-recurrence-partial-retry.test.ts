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
import type { RecurrenceConfig } from "../../missions/recurrence-contract"
import { NativeMissionRecurrenceStore, recurrenceRequestRefusal } from "../../missions/recurrence-store"
import { canonicalWorktreeIdentity } from "../../workspaces/manager"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerMissionRecurrenceControl } from "./mission-recurrence-control"
import { registerMissionRecurrenceManual } from "./mission-recurrence-manual"

const current = () => true as const
const scheduleID = "daily_review"
const config = (directory: string, profileID: string): RecurrenceConfig => {
  const execution = { agent: "worker", model: { providerID: "provider", id: "model" } }
  return { title: "Review", template: "custom", consigne: "Review.", clock: { time: "07:00", zone: "UTC" }, profileID,
    executionHost: "local", profiles: { coordinator: execution, roles: { specialist: execution } }, taskMode: "native",
    roots: [{ mode: "directory-only", directory }], watchedConversationIDs: [] }
}
type Input = { requestID: string; action: "pause" | "stop"; expectedRevision: number; retry?: boolean;
  profileSource?: Parameters<NativeMissionRecurrenceStore["beginControl"]>[3] }
const gate = () => { let open!: () => void; return { wait: new Promise<void>(resolve => { open = resolve }), open } }
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 30_000
  while (!predicate()) {
    assert(Date.now() < deadline, "the expected fixture stage was never reached")
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Native stand-in over the real recurrence store. The first attempt records a
 * partial Pause/Stop (cancellation unacknowledged); only an exact `retry` of an
 * existing record completes it, mirroring controlNativeRecurrence. */
async function fixture() {
  await mkdir(path.join(tmpdir(), "opencode"), { recursive: true })
  const base = await mkdtemp(path.join(tmpdir(), "opencode", "recurrence-partial-"))
  execFileSync("git", ["init", "-q", base])
  const directory = realpathSync(base), yaml = path.join(base, "selected.yml"), checkout = canonicalWorktreeIdentity(directory)
  await writeFile(yaml, "server: {}\n")
  const auth = new AuthManager({ configPath: yaml, username: "human", password: "offline", generateToken: false }, pino({ level: "silent" }) as never)
  const human = auth.createSession("human"), location = { directory }
  const values = new Map<string, MissionJsonValue>()
  const storage: MissionStorage = { get: async key => structuredClone(values.get(key)),
    set: async (key, value, fence) => { fence?.(); values.set(key, structuredClone(value)) }, scan: async () => ({ entries: [] }) }
  const store = new NativeMissionRecurrenceStore(storage, "project", directory)
  let doc = await store.create(scheduleID, config(directory, canonicalScope("stable", yaml, base, base).key), Date.now(), current)
  doc = await store.setState(scheduleID, doc.revision, "running", current)
  const native = { controls: 0, statuses: 0, controlGate: undefined as Promise<void> | undefined,
    statusGate: undefined as Promise<void> | undefined, onStatus: () => {}, foreign: false, statusFails: false }
  const rpc = {
    recurrenceControl: async (input: Input) => {
      native.controls++
      await native.controlGate
      const before = (await store.read(scheduleID))!, previous = before.controls.find(item => item.requestID === input.requestID)
      const begun = await store.beginControl(scheduleID, input, current, input.profileSource)
      const record = begun.controls.find(item => item.requestID === input.requestID)!
      if (record.controlsComplete || previous && !input.retry) return { version: 1, scheduleID, ...record }
      if (!previous) return { version: 1, scheduleID, ...record }
      const complete = { ...record, schedulerCancellation: "acknowledged" as const, targetsKnown: true, controlsComplete: true }
      await store.recordControl(scheduleID, complete, current)
      return { version: 1, scheduleID, ...complete }
    },
    recurrenceControlStatus: async (input: Input) => {
      native.statuses++
      await native.statusGate
      native.onStatus()
      if (native.statusFails) throw new Error("Status unavailable")
      const saved = (await store.read(scheduleID))!, record = saved.controls.find(item => item.requestID === input.requestID)
      const identity = { version: 1, scheduleID, requestID: input.requestID, expectedRevision: input.expectedRevision }
      if (record) {
        const { targetsKnown: _k, ...status } = record
        return { ...identity, ...status, outcome: record.controlsComplete ? "committed" : "unknown", ...(native.foreign ? { requestID: "pause_other" } : {}) }
      }
      const reason = recurrenceRequestRefusal(saved, input)
      return reason ? { ...identity, outcome: "rejected", reason } : { ...identity, outcome: "unknown" }
    },
    recurrenceRunNow: async () => { native.controls++; throw new Error("Unexpected Run now") },
  }
  const env = { principal: human.id as string, owns: true, available: true, yaml, retireAfterPreparation: false }
  /** One CodeNomad backend incarnation: its own fence (in-memory permits) and connection. */
  const backend = () => {
    const fence = new WorktreeDeletionFence(), connection = { current: true, client: { location: {
      get: async () => ({ ...location, project: { id: "project", canonical: directory } }) }, rpc: () => rpc },
    assertCurrent() { if (!connection.current) throw new Error("Connection replaced") } }
    const manager = { get: () => location, getServiceLocation: () => location, getServiceDirectoryForPath: async () => directory,
      getSharedServiceConnection: async () => env.available ? connection : undefined, ownsLocation: async () => env.owns,
      getServiceWslDistro: () => undefined, getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
      getWorktreeIdentityForPath: async () => checkout, getHostPathForServicePath: async () => directory }
    const app = Fastify({ logger: false })
    const deps = { auth: { isAuthEnabled: () => auth.isAuthEnabled(), getSessionFromRequest: (request: Parameters<AuthManager["getSessionFromRequest"]>[0]) => {
      const verified = auth.getSessionFromRequest(request)
      // Fault injection only: simulate the principal changing after the native read.
      return verified && { ...verified, sessionId: env.principal }
    } },
      get bridgeToken() {
        // Signing is the last step in preparation; retire before the route resumes.
        if (env.retireAfterPreparation) queueMicrotask(() => { connection.current = false })
        return "token"
      }, fence, manager, settings: { configYamlPathForAuthority: () => env.yaml,
        getProfileScope: () => canonicalScope("stable", env.yaml, base, base) } }
    registerMissionRecurrenceControl(app, deps as never)
    registerMissionRecurrenceManual(app, deps as never)
    const send = (payload: Record<string, unknown>) => app.inject({ method: "POST",
      url: `/api/workspaces/owned/missions/recurrence/${scheduleID}/control`,
      headers: { cookie: `${auth.getCookieName()}=${human.id}` }, payload })
    const runNow = (payload: Record<string, unknown>) => app.inject({ method: "POST",
      url: `/api/workspaces/owned/missions/recurrence/${scheduleID}/run-now`,
      headers: { cookie: `${auth.getCookieName()}=${human.id}` }, payload })
    // An exclusive deletion drains every admitted permit; bounded so a held one fails fast.
    const deletionRuns = () => Promise.race([fence.run(directory, [checkout], async () => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 500))])
    return { app, fence, connection, send, runNow, deletionRuns }
  }
  const record = async (requestID: string) => (await store.read(scheduleID))!.controls.find(item => item.requestID === requestID)
  return { base, store, native, env, backend, record, revision: async () => (await store.read(scheduleID))!.revision }
}

for (const action of ["pause", "stop"] as const) test(`after a backend restart an exact partial ${action} retry reacquires a fresh permit from native's record and settles`, async () => {
  const f = await fixture(), old = f.backend()
  try {
    const expectedRevision = await f.revision(), pause = { action, expectedRevision, requestID: `${action}_partial` }
    // Same backend, original still in flight: an explicit retry never steals it.
    const inflight = gate(); f.native.controlGate = inflight.wait
    const original = old.send(pause)
    await until(() => f.native.controls > 0)
    const stolen = await old.send({ ...pause, retry: true })
    assert.deepEqual([stolen.statusCode, stolen.json().code], [503, undefined], stolen.body)
    assert.equal(f.native.controls, 1, "the in-flight original was not resent")
    inflight.open(); f.native.controlGate = undefined
    assert.equal((await original).json().controlsComplete, false, "native recorded the Pause partial")
    assert.equal((await f.record(pause.requestID))?.state, action === "pause" ? "paused" : "stopped")

    // The backend restarts; native (and its partial record) survives.
    await old.app.close()
    const restarted = f.backend()
    for (const action of ["stop", "resume", "play"]) {
      const fresh = await restarted.send({ action, expectedRevision: await f.revision(), requestID: `fresh_${action}` })
      assert.deepEqual([fresh.statusCode, fresh.json().code], [409, "recurrence-control-conflict"], "the partial record still holds the schedule")
    }
    const calls = f.native.controls
    // A concurrent duplicate retry is refused while the first reacquisition is unproven.
    const proving = gate(), statuses = f.native.statuses; f.native.statusGate = proving.wait
    const firstRetry = restarted.send({ ...pause, retry: true })
    await until(() => f.native.statuses > statuses)
    const duplicate = await restarted.send({ ...pause, retry: true })
    assert.deepEqual([duplicate.statusCode, duplicate.json().code], [503, undefined], duplicate.body)
    // Once dispatched, deletion cannot enter the checkout while the fresh permit is held.
    const dispatching = gate(); f.native.controlGate = dispatching.wait
    proving.open(); f.native.statusGate = undefined
    await until(() => f.native.controls > calls)
    assert.equal(await restarted.deletionRuns(), false, "the reacquired permit fences deletion")
    dispatching.open(); f.native.controlGate = undefined
    const retried = await firstRetry
    assert.equal(retried.statusCode, 200, retried.body)
    assert.deepEqual([retried.json().requestID, retried.json().revision, retried.json().state, retried.json().controlsComplete],
      [pause.requestID, expectedRevision + 1, action === "pause" ? "paused" : "stopped", true], "same identity and revision, original state")
    assert.equal(f.native.controls, calls + 1, "exactly one resend of the exact partial identity")
    assert.equal((await f.store.read(scheduleID))!.state, action === "pause" ? "paused" : "stopped", "no Job or Play was started")
    assert.equal(await restarted.deletionRuns(), true, "the settled permit released: exclusive deletion proceeds")
    const resume = await restarted.send({ action: "resume", expectedRevision: await f.revision(), requestID: "fresh_resume_after" })
    assert.equal(resume.statusCode, action === "pause" ? 200 : 409,
      action === "pause" ? `the liveness lock is gone: ${resume.body}` : "Stop remains terminal after its partial control settles")
    await restarted.app.close()
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test("a reacquiring retry fails closed on missing, foreign or unknown records and changed principal, Location, connection or profile", async () => {
  const f = await fixture(), old = f.backend()
  try {
    const expectedRevision = await f.revision(), pause = { action: "stop", expectedRevision, requestID: "stop_partial", retry: true }
    const { retry: _retry, ...first } = pause
    assert.equal((await old.send(first)).json().controlsComplete, false)
    await old.app.close()
    const refusedBeforeDispatch = async (label: string, payload: Record<string, unknown>, arrange: (b: ReturnType<typeof f.backend>) => void) => {
      const b = f.backend(), calls = f.native.controls
      arrange(b)
      const reply = await b.send(payload)
      assert.notEqual(reply.statusCode, 200, `${label}: ${reply.body}`)
      assert.equal(reply.json().code, undefined, `${label}: a retry is never coded as no effect`)
      assert.equal(f.native.controls, calls, `${label}: nothing dispatched`)
      Object.assign(f.native, { foreign: false, statusFails: false, onStatus: () => {} })
      Object.assign(f.env, { principal: f.env.principal.replace(/_other$/, ""), owns: true })
      assert.equal(await b.deletionRuns(), true, `${label}: no permit retained`)
      await b.app.close()
    }
    await refusedBeforeDispatch("never-sent identity", { ...pause, requestID: "stop_missing" }, () => {})
    await refusedBeforeDispatch("unknown status", pause, () => { f.native.statusFails = true })
    await refusedBeforeDispatch("foreign record", pause, () => { f.native.foreign = true })
    await refusedBeforeDispatch("different action", { ...pause, action: "pause" }, () => {})
    await refusedBeforeDispatch("different revision", { ...pause, expectedRevision: expectedRevision + 1 }, () => {})
    await refusedBeforeDispatch("foreign Location", pause, () => { f.env.owns = false })
    await refusedBeforeDispatch("changed principal", pause, () => { f.native.onStatus = () => { f.env.principal += "_other" } })
    await refusedBeforeDispatch("replaced connection", pause, b => { f.native.onStatus = () => { b.connection.current = false } })
    assert.equal((await f.record("stop_partial"))?.controlsComplete, false, "the partial record is untouched")

    // A changed Settings profile reaches native, which refuses the exact identity under
    // another profile before any effect; the record stays partial and uncertain.
    const otherYaml = path.join(f.base, "other.yml")
    await writeFile(otherYaml, "server: {}\n")
    f.env.yaml = otherYaml
    const changed = f.backend(), reply = await changed.send(pause)
    assert.deepEqual([reply.statusCode, reply.json().code, reply.json().controlsComplete], [503, undefined, false], reply.body)
    assert.equal((await f.record("stop_partial"))?.controlsComplete, false)
    await changed.app.close()
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test("not-dispatched is coded only for a first attempt, never for a retry or a held identity's repeat", async () => {
  const f = await fixture(), b = f.backend()
  try {
    const expectedRevision = await f.revision(), pause = { action: "pause", expectedRevision, requestID: "pause_partial" }
    assert.equal((await b.send(pause)).json().controlsComplete, false)
    f.env.available = false
    for (const [label, payload] of [["exact retry", { ...pause, retry: true }], ["same-identity repeat", pause]] as const) {
      const reply = await b.send(payload)
      assert.deepEqual([reply.statusCode, reply.json().code], [503, undefined], `${label} stays held: ${reply.body}`)
    }
    const unrelated = await b.send({ action: "stop", expectedRevision: expectedRevision + 1, requestID: "stop_new" })
    assert.deepEqual([unrelated.statusCode, unrelated.json().code], [503, "recurrence-not-dispatched"], "a new identity keeps its code")
    const manual = await b.runNow({ expectedRevision: expectedRevision + 1, requestID: "manual_new" })
    assert.deepEqual([manual.statusCode, manual.json().code], [503, "recurrence-not-dispatched"], "Run now shares the classifier")
    const manualRepeat = await b.runNow({ expectedRevision, requestID: "pause_partial" })
    assert.deepEqual([manualRepeat.statusCode, manualRepeat.json().code], [503, undefined], "a held identity is never coded")
    // After a restart, an exact retry failing early stays uncoded too.
    await b.app.close()
    const restarted = f.backend(), retry = await restarted.send({ ...pause, retry: true })
    assert.deepEqual([retry.statusCode, retry.json().code], [503, undefined], retry.body)
    assert.equal(f.native.controls, 1)
    await restarted.app.close()
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test("a first attempt retired after preparation stays coded as unsent on both mutation routes", async () => {
  const f = await fixture()
  try {
    f.env.retireAfterPreparation = true
    for (const manual of [false, true]) {
      const b = f.backend(), expectedRevision = await f.revision()
      try {
        const response = manual ? await b.runNow({ expectedRevision, requestID: "manual_retired" })
          : await b.send({ action: "play", expectedRevision, requestID: "play_retired" })
        assert.deepEqual([response.statusCode, response.json().code], [503, "recurrence-not-dispatched"], response.body)
        assert.equal(f.native.controls, 0, "no native mutation was sent")
        assert.equal(await f.revision(), expectedRevision, "no control record or passage was written")
        assert.equal(await b.deletionRuns(), true, "the preparing admission is released")
      } finally { await b.app.close() }
    }
  } finally { await rm(f.base, { recursive: true, force: true }) }
})
