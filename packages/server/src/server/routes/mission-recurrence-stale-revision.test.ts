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
import { registerMissionRecurrenceControlStatus } from "./mission-recurrence-control-status"
import { registerMissionRecurrenceManual } from "./mission-recurrence-manual"

const current = () => true as const
const scheduleID = "daily_review"
const config = (directory: string): RecurrenceConfig => {
  const execution = { agent: "worker", model: { providerID: "provider", id: "model" } }
  return { title: "Review", template: "custom", consigne: "Review.", clock: { time: "07:00", zone: "UTC" }, profileID: "profile",
    executionHost: "local", profiles: { coordinator: execution, roles: { specialist: execution } }, taskMode: "native",
    roots: [{ mode: "directory-only", directory }], watchedConversationIDs: [] }
}

test("a control or Run now refused for a stale revision is a definitive conflict that releases the schedule's permit", async () => {
  await mkdir(path.join(tmpdir(), "opencode"), { recursive: true })
  const base = await mkdtemp(path.join(tmpdir(), "opencode", "recurrence-stale-"))
  const app = Fastify({ logger: false })
  try {
    execFileSync("git", ["init", "-q", base])
    const directory = realpathSync(base), yaml = path.join(base, "selected.yml")
    await writeFile(yaml, "server: {}\n")
    const selected = canonicalScope("stable", yaml, base, base)
    const auth = new AuthManager({ configPath: base, username: "human", password: "offline", generateToken: false }, pino({ level: "silent" }) as never)
    const human = auth.createSession("human"), workspace = {}, location = { directory }
    // Native stand-in over the real recurrence store: its CAS refuses stale writes
    // before any record, and its status mirrors the native exact-request read.
    const values = new Map<string, MissionJsonValue>()
    const storage: MissionStorage = { get: async key => structuredClone(values.get(key)),
      set: async (key, value, fence) => { fence?.(); values.set(key, structuredClone(value)) },
      scan: async () => ({ entries: [] }) }
    const store = new NativeMissionRecurrenceStore(storage, "project", directory)
    let doc = await store.create(scheduleID, config(directory), Date.now(), current)
    doc = await store.setState(scheduleID, doc.revision, "running", current)
    let controls = 0, statusFailures = 0
    const source = { profileID: "profile", executionHost: "local", configYamlPath: yaml }
    const rpc = {
      recurrenceControl: async (input: { requestID: string; action: "pause"; expectedRevision: number }) => {
        controls++
        const begun = await store.beginControl(scheduleID, input, current)
        const record = { ...begun.controls.find(item => item.requestID === input.requestID)!, controlsComplete: true, targetsKnown: true }
        await store.recordControl(scheduleID, record, current)
        return { version: 1, scheduleID, ...record }
      },
      recurrenceControlStatus: async (input: { requestID: string; action: "pause"; expectedRevision: number }) => {
        if (statusFailures > 0 && statusFailures--) throw new Error("Lost status reply")
        const saved = (await store.read(scheduleID))!, record = saved.controls.find(item => item.requestID === input.requestID)
        const identity = { version: 1, scheduleID, requestID: input.requestID, expectedRevision: input.expectedRevision }
        if (record) {
          const { targetsKnown: _known, ...status } = record
          return { ...identity, ...status, outcome: record.controlsComplete ? "committed" : "unknown" }
        }
        const reason = recurrenceRequestRefusal(saved, input)
        return reason ? { ...identity, outcome: "rejected", reason } : { ...identity, outcome: "unknown" }
      },
      recurrenceRunNow: async (input: { requestID: string; expectedRevision: number }) => {
        controls++
        await store.reserveManual(scheduleID, input.requestID, input.expectedRevision, Date.now(), source, current)
        throw new Error("Unexpected manual admission")
      },
      recurrenceRunNowStatus: async (input: { requestID: string; expectedRevision: number }) => {
        const reason = recurrenceRequestRefusal((await store.read(scheduleID))!, { ...input, action: "run-now" })
        return { ...input, scheduleID, version: 1, projectID: "project", projectCanonical: directory, location,
          outcome: reason ? "rejected" : "unknown", ...(reason ? { reason } : {}), passageID: null, messageID: null, admission: null }
      },
    }
    const client = { location: { get: async () => ({ ...location, project: { id: "project", canonical: directory } }) }, rpc: () => rpc }
    const fence = new WorktreeDeletionFence(), connection = { client, assertCurrent: () => {} }
    const manager = { get: () => workspace, getServiceLocation: () => location, getServiceDirectoryForPath: async () => directory,
      getSharedServiceConnection: async () => connection, ownsLocation: async () => true,
      getServiceWslDistro: () => undefined, getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
      getWorktreeIdentityForPath: async () => canonicalWorktreeIdentity(directory), getHostPathForServicePath: async () => directory }
    const deps = { auth, bridgeToken: "existing-bridge-token", fence, manager,
      settings: { configYamlPathForAuthority: () => yaml, getProfileScope: () => selected } }
    registerMissionRecurrenceControl(app, deps as never)
    registerMissionRecurrenceManual(app, deps as never)
    registerMissionRecurrenceControlStatus(app, deps as never)
    const headers = { cookie: `${auth.getCookieName()}=${human.id}` }
    const url = `/api/workspaces/owned/missions/recurrence/${scheduleID}`
    const pause = (requestID: string, expectedRevision: number) => app.inject({ method: "POST", url: `${url}/control`, headers,
      payload: { action: "pause", expectedRevision, requestID } })
    const revision = async () => (await store.read(scheduleID))!.revision
    // An exclusive deletion drains every admitted mutation permit (`enter` alone is a
    // shared counter). Bounded: a held permit fails the check without hanging it, and
    // is only probed where every permit should already be released.
    const deletionRuns = () => Promise.race([fence.run(directory, [canonicalWorktreeIdentity(directory)], async () => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 1_000))])

    // Run now posted to the generic control endpoint is refused before any permit
    // or native call; it would otherwise strand a hold native status cannot prove.
    const misrouted = await app.inject({ method: "POST", url: `${url}/control`, headers,
      payload: { action: "run-now", expectedRevision: await revision(), requestID: "runnow_on_control" } })
    assert.deepEqual([misrouted.statusCode, misrouted.json().code], [400, undefined], misrouted.body)
    assert.equal(controls, 0, "nothing reached native")
    assert.equal(await deletionRuns(), true, "no permit was taken")

    // The scheduler advanced the revision after the UI rendered.
    const stale = await pause("pause_stale", (await revision()) - 1)
    assert.equal(stale.statusCode, 409, stale.body)
    assert.equal(stale.json().code, "recurrence-revision-conflict")
    const manual = await app.inject({ method: "POST", url: `${url}/run-now`, headers,
      payload: { requestID: "manual_stale", expectedRevision: (await revision()) - 1 } })
    assert.equal(manual.statusCode, 409, manual.body)
    assert.equal(manual.json().code, "recurrence-revision-conflict")
    assert.equal(controls, 2, "each refused request was sent exactly once")

    // A fresh control under a new identity is admitted: no permit was stranded.
    const fresh = await pause("pause_fresh", await revision())
    assert.equal(fresh.statusCode, 200, fresh.body)
    assert.equal(fresh.json().state, "paused")
    // Inadmissible at the current revision is the same definitive refusal.
    const check = await app.inject({ method: "POST", url: `${url}/control`, headers,
      payload: { action: "check", expectedRevision: await revision(), requestID: "check_nothing" } })
    assert.equal(check.statusCode, 409, check.body)
    assert.equal(check.json().code, "recurrence-control-conflict")

    // When the refusal's own status reply is lost, the permit stays held (uncertain)
    // until an explicit exact status read proves the refusal and releases it.
    statusFailures = 1
    const lost = await pause("pause_lost", (await revision()) - 1)
    assert.equal(lost.statusCode, 503)
    // Another request is refused before dispatch: coded, and nothing reaches native.
    const blocked = await pause("pause_blocked", await revision())
    assert.deepEqual([blocked.statusCode, blocked.json().code], [409, "recurrence-not-dispatched"], "held while genuinely uncertain")
    assert.equal(controls, 5, "the blocked request never reached native")
    // The held identity's own repeat may follow its dispatch: never coded.
    const repeat = await pause("pause_lost", (await revision()) - 1)
    assert.deepEqual([repeat.statusCode, repeat.json().code], [503, undefined])
    const read = await app.inject({ method: "POST", url: `${url}/control/status`, headers,
      payload: { action: "pause", expectedRevision: (await revision()) - 1, requestID: "pause_lost" } })
    assert.equal(read.statusCode, 200, read.body)
    assert.deepEqual([read.json().outcome, read.json().reason], ["rejected", "revision-conflict"])
    const play = await app.inject({ method: "POST", url: `${url}/control`, headers,
      payload: { action: "play", expectedRevision: await revision(), requestID: "play_after" } })
    assert.equal(play.statusCode, 200, `the explicit read released the permit: ${play.body}`)

    assert.equal(await deletionRuns(), true, "no admitted permit remains")
  } finally { await app.close(); await rm(base, { recursive: true, force: true }) }
})
