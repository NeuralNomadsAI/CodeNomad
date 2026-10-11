import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import Fastify from "fastify"
import pino from "pino"
import { AuthManager } from "../../../server/src/auth/manager"
import { canonicalScope } from "../../../server/src/host-lifetime/protocol"
import type { MissionStorage } from "../../../server/src/missions/journal"
import type { MissionJsonValue } from "../../../server/src/missions/model"
import type { RecurrenceConfig } from "../../../server/src/missions/recurrence-contract"
import { NativeMissionRecurrenceStore, recurrenceRequestRefusal } from "../../../server/src/missions/recurrence-store"
import { canonicalWorktreeIdentity } from "../../../server/src/workspaces/manager"
import { WorktreeDeletionFence } from "../../../server/src/workspaces/worktree-session-evacuation"
import { registerMissionRecurrenceControl } from "../../../server/src/server/routes/mission-recurrence-control"
import { registerMissionRecurrenceControlStatus } from "../../../server/src/server/routes/mission-recurrence-control-status"
import { registerMissionRecurrenceManual } from "../../../server/src/server/routes/mission-recurrence-manual"
import { completedRecurrenceControl, recurrenceControlRefusalKey, rejectedRecurrenceControl, type RecurrenceControlIntent } from "../../src/lib/mission-recurrence-control"
import { HttpResponseError } from "../../src/lib/retryable-file-search"

// Real routes, AuthManager, deletion fence and recurrence store, classified by the
// renderer's own refusal/status helpers exactly as `HttpResponseError` carries them.
const current = () => true as const
const scheduleID = "daily_review"
const NOT_SENT = "missions.recurrence.refused.notSent"
const config = (directory: string): RecurrenceConfig => {
  const execution = { agent: "worker", model: { providerID: "provider", id: "model" } }
  return { title: "Review", template: "custom", consigne: "Review.", clock: { time: "07:00", zone: "UTC" }, profileID: "profile",
    executionHost: "local", profiles: { coordinator: execution, roles: { specialist: execution } }, taskMode: "native",
    roots: [{ mode: "directory-only", directory }], watchedConversationIDs: [] }
}
const uiKey = (response: { statusCode: number; json(): { error?: string; code?: string } }) =>
  recurrenceControlRefusalKey(new HttpResponseError(response.json().error ?? "", response.statusCode, null, response.json().code))

async function fixture() {
  await mkdir(path.join(tmpdir(), "opencode"), { recursive: true })
  const base = await mkdtemp(path.join(tmpdir(), "opencode", "recurrence-predispatch-"))
  execFileSync("git", ["init", "-q", base])
  const directory = realpathSync(base), yaml = path.join(base, "selected.yml")
  await writeFile(yaml, "server: {}\n")
  const selected = canonicalScope("stable", yaml, base, base)
  const auth = new AuthManager({ configPath: base, username: "human", password: "offline", generateToken: false }, pino({ level: "silent" }) as never)
  const human = auth.createSession("human"), workspace = {}, location = { directory }
  const values = new Map<string, MissionJsonValue>()
  const storage: MissionStorage = { get: async key => structuredClone(values.get(key)),
    set: async (key, value, fence) => { fence?.(); values.set(key, structuredClone(value)) }, scan: async () => ({ entries: [] }) }
  const store = new NativeMissionRecurrenceStore(storage, "project", directory)
  await store.create(scheduleID, config(directory), Date.now(), current)
  const native = { writes: 0, gate: undefined as Promise<void> | undefined, started: undefined as (() => void) | undefined }
  const rpc = {
    recurrenceControl: async (input: { requestID: string; action: "play" | "pause" | "stop"; expectedRevision: number; retry?: boolean }) => {
      native.writes++
      native.started?.()
      await native.gate
      const begun = input.retry ? (await store.read(scheduleID))! : await store.beginControl(scheduleID, input, current)
      // A first denial leaves one target unconfirmed (partial); its exact retry completes it.
      const complete = input.action === "play" || Boolean(input.retry)
      const record = { ...begun.controls.find(item => item.requestID === input.requestID)!, controlsComplete: complete, targetsKnown: true,
        ...(input.action === "play" ? {} : { targets: [{ sessionID: "ses_running", outcome: complete ? "acknowledged" as const : "unknown" as const }],
          schedulerCancellation: "acknowledged" as const }) }
      await store.recordControl(scheduleID, record, current)
      return { version: 1, scheduleID, ...record }
    },
    recurrenceControlStatus: async (input: { requestID: string; action: "play" | "pause" | "stop"; expectedRevision: number }) => {
      const saved = (await store.read(scheduleID))!, record = saved.controls.find(item => item.requestID === input.requestID)
      const identity = { version: 1, scheduleID, requestID: input.requestID, expectedRevision: input.expectedRevision }
      if (record) {
        const { targetsKnown: _known, ...status } = record
        return { ...identity, ...status, outcome: record.controlsComplete ? "committed" : "unknown" }
      }
      const reason = recurrenceRequestRefusal(saved, input)
      return reason ? { ...identity, outcome: "rejected", reason } : { ...identity, outcome: "unknown" }
    },
    recurrenceRunNow: async () => { native.writes++; throw new Error("Unexpected manual admission") },
    recurrenceRunNowStatus: async () => { throw new Error("Unexpected manual status") },
  }
  const client = { location: { get: async () => ({ ...location, project: { id: "project", canonical: directory } }) }, rpc: () => rpc }
  const connection = { client, assertCurrent: () => {} }
  const health = { available: true, owned: true, ownedCalls: Infinity }
  const fence = new WorktreeDeletionFence()
  const manager = { get: () => workspace, getServiceLocation: () => location, getServiceDirectoryForPath: async () => directory,
    getSharedServiceConnection: async () => health.available ? connection : undefined,
    ownsLocation: async () => health.owned && health.ownedCalls-- > 0,
    getServiceWslDistro: () => undefined, getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
    getWorktreeIdentityForPath: async () => canonicalWorktreeIdentity(directory), getHostPathForServicePath: async () => directory }
  const deps = { auth, bridgeToken: "existing-bridge-token", fence, manager,
    settings: { configYamlPathForAuthority: () => yaml, getProfileScope: () => selected } }
  const app = Fastify({ logger: false })
  registerMissionRecurrenceControl(app, deps as never)
  registerMissionRecurrenceManual(app, deps as never)
  registerMissionRecurrenceControlStatus(app, deps as never)
  const headers = { cookie: `${auth.getCookieName()}=${human.id}` }
  const url = `/api/workspaces/owned/missions/recurrence/${scheduleID}`
  const control = (action: "play" | "pause" | "stop" | "resume", requestID: string, expectedRevision: number, retry = false) =>
    app.inject({ method: "POST", url: `${url}/control`, headers, payload: { action, expectedRevision, requestID, ...(retry ? { retry } : {}) } })
  const status = (action: "play" | "pause" | "stop", requestID: string, expectedRevision: number) =>
    app.inject({ method: "POST", url: `${url}/control/status`, headers, payload: { action, expectedRevision, requestID } })
  const runNow = (requestID: string, expectedRevision: number) =>
    app.inject({ method: "POST", url: `${url}/run-now`, headers, payload: { requestID, expectedRevision } })
  // A deletion drains admitted mutation permits: it runs promptly only when none is held.
  // Only called where the permit should be free, so a held one cannot strand the fence.
  const permitFree = () => Promise.race([fence.run(directory, [canonicalWorktreeIdentity(directory)], async () => true),
    new Promise<false>(resolve => setTimeout(() => resolve(false), 1_000))])
  const read = async () => (await store.read(scheduleID))!
  return { app, base, directory, store, native, health, fence, control, status, runNow, permitFree, read,
    dispose: async () => { await app.close(); await rm(base, { recursive: true, force: true }) } }
}

test("controls and Run now refused before dispatch are coded no-effect refusals the UI releases; status stays unknown", async () => {
  const f = await fixture()
  try {
    const paused = await f.read()
    assert.equal(paused.state, "paused")
    const refused = async (response: Awaited<ReturnType<typeof f.control>>, status: number, label: string) => {
      assert.equal(response.statusCode, status, `${label}: ${response.body}`)
      assert.equal(response.json().code, "recurrence-not-dispatched", label)
      assert.equal(uiKey(response), NOT_SENT, `${label}: the UI releases its new intent`)
    }

    // The native connection is unavailable during a reconnect.
    f.health.available = false
    await refused(await f.control("play", "play_offline", paused.revision), 503, "Play offline")
    await refused(await f.control("stop", "stop_offline", paused.revision), 503, "Stop offline")
    await refused(await f.runNow("manual_offline", paused.revision), 503, "Run now offline")
    f.health.available = true
    // Location ownership blips before the hold, and again after preparation holds the checkout.
    f.health.owned = false
    await refused(await f.control("resume", "resume_foreign", paused.revision), 503, "Resume foreign Location")
    f.health.owned = true; f.health.ownedCalls = 2
    await refused(await f.control("play", "play_root_changed", paused.revision), 503, "Play root changed after hold")
    f.health.ownedCalls = Infinity
    // A worktree deletion is entering the checkout.
    let finish!: () => void
    const deletion = f.fence.run(f.directory, [canonicalWorktreeIdentity(f.directory)], () => new Promise<void>(resolve => { finish = resolve }))
    await refused(await f.control("play", "play_deleting", paused.revision), 503, "Play during deletion")
    finish(); await deletion

    assert.equal(f.native.writes, 0, "nothing ever reached native")
    assert.deepEqual(await f.read(), paused, "paused schedule: the document and revision are unchanged")
    assert.equal(await f.permitFree(), true, "no permit was retained")
    // Native status still cannot settle it: only the received code could release the UI.
    const intent: RecurrenceControlIntent = { scheduleID, requestID: "play_offline", action: "play", expectedRevision: paused.revision }
    for (let index = 0; index < 2; index++) {
      const unknown = await f.status("play", "play_offline", paused.revision)
      assert.equal(unknown.statusCode, 200, unknown.body)
      assert.equal(unknown.json().outcome, "unknown")
      assert.equal(rejectedRecurrenceControl(unknown.json(), intent), undefined)
      assert.equal(completedRecurrenceControl(unknown.json(), intent), false)
    }
    // A fresh request at the same revision is then admitted once.
    const play = await f.control("play", "play_fresh", paused.revision)
    assert.equal(play.statusCode, 200, play.body)
    assert.equal(f.native.writes, 1)
  } finally { await f.dispose() }
})

test("another window's request refused by a held permit is released there without affecting the first; a held identity's repeat stays uncertain", async () => {
  const f = await fixture()
  try {
    const paused = await f.read()
    let open!: () => void
    f.native.gate = new Promise<void>(resolve => { open = resolve })
    const started = new Promise<void>(resolve => { f.native.started = resolve })
    const first = f.control("play", "play_first", paused.revision)
    await started
    f.native.started = undefined

    const second = await f.control("play", "play_second", paused.revision)
    assert.equal(second.statusCode, 409, second.body)
    assert.equal(second.json().code, "recurrence-not-dispatched")
    assert.equal(uiKey(second), NOT_SENT, "the second window releases its own new intent")
    const manual = await f.runNow("manual_second", paused.revision)
    assert.deepEqual([manual.statusCode, manual.json().code], [409, "recurrence-not-dispatched"])
    // The first identity itself may already be dispatched: its repeat is never coded.
    const repeat = await f.control("play", "play_first", paused.revision)
    assert.equal(repeat.statusCode, 503, repeat.body)
    assert.equal(repeat.json().code, undefined)
    assert.equal(uiKey(repeat), undefined, "an outstanding identity stays held")
    assert.equal(f.native.writes, 1, "only the first request reached native")

    open()
    const settled = await first
    assert.equal(settled.statusCode, 200, settled.body)
    assert.equal(settled.json().requestID, "play_first")
    assert.equal(await f.permitFree(), true)
  } finally { await f.dispose() }
})

test("a partial Pause/Stop retry refused during preparation keeps the original partial permit and identity", async () => {
  for (const action of ["pause", "stop"] as const) {
    const f = await fixture()
    try {
      const playing = await f.control("play", "play_start", (await f.read()).revision)
      assert.equal(playing.statusCode, 200, playing.body)
      const revision = (await f.read()).revision
      const partial = await f.control(action, `${action}_partial`, revision)
      assert.equal(partial.statusCode, 200, partial.body)
      assert.equal(partial.json().controlsComplete, false)

      // Refused before the hold (connection) and after preparation re-entered it (root changed).
      f.health.available = false
      const offline = await f.control(action, `${action}_partial`, revision, true)
      assert.deepEqual([offline.statusCode, offline.json().code], [503, "recurrence-not-dispatched"])
      f.health.available = true; f.health.ownedCalls = 2
      const changed = await f.control(action, `${action}_partial`, revision, true)
      assert.deepEqual([changed.statusCode, changed.json().code], [503, "recurrence-not-dispatched"])
      f.health.ownedCalls = Infinity
      assert.equal(f.native.writes, 2, "neither refused retry reached native")
      const other = await f.control("play", "play_other", revision + 1)
      assert.deepEqual([other.statusCode, other.json().code], [409, "recurrence-not-dispatched"], "the original partial permit was not released")

      // The explicit exact retry remains admissible under the original identity and completes.
      const retried = await f.control(action, `${action}_partial`, revision, true)
      assert.equal(retried.statusCode, 200, retried.body)
      assert.equal(retried.json().controlsComplete, true)
      assert.equal(f.native.writes, 3)
      assert.equal(await f.permitFree(), true)
    } finally { await f.dispose() }
  }
})
