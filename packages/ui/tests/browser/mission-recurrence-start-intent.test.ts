import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import Fastify from "fastify"
import pino from "pino"
import { chromium, type Browser, type Page, type Route } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import type {} from "./fixtures/mission-editor-lifetime"
import { missionDetail, missionRefresh, missionToolbarAction, selectMission } from "./mission-actions"
import { AuthManager } from "../../../server/src/auth/manager"
import { canonicalScope } from "../../../server/src/host-lifetime/protocol"
import type { MissionStorage } from "../../../server/src/missions/journal"
import type { MissionJsonValue } from "../../../server/src/missions/model"
import type { RecurrenceConfig, RecurrenceControlRecord, RecurrenceDocument } from "../../../server/src/missions/recurrence-contract"
import { recurrenceSnapshotSchema } from "../../../server/src/missions/recurrence-control-contract"
import { recurrenceManualResultSchema } from "../../../server/src/missions/recurrence-manual-rpc"
import { NativeMissionRecurrenceStore, recurrenceRequestRefusal } from "../../../server/src/missions/recurrence-store"
import { canonicalWorktreeIdentity } from "../../../server/src/workspaces/manager"
import { WorktreeDeletionFence } from "../../../server/src/workspaces/worktree-session-evacuation"
import { registerMissionRecurrenceControl } from "../../../server/src/server/routes/mission-recurrence-control"
import { registerMissionRecurrenceControlStatus } from "../../../server/src/server/routes/mission-recurrence-control-status"
import { registerMissionRecurrenceManual } from "../../../server/src/server/routes/mission-recurrence-manual"

// A service crash after Play/Resume beginControl or Run now reserveManual leaves an
// unknown start intent. The real Solid panel drives the real routes, AuthManager,
// deletion fence, holds and recurrence store; only the native service is simulated,
// following native-recurrence-control/-snapshot/-control-status/-manual.
const current = () => true as const
const scheduleID = "rec_fixture", TITLE = "Daily source review"
const CHECK = `Check control outcome for ${TITLE}`, PLAY = `Play schedule ${TITLE}`, RESUME = `Resume schedule ${TITLE}`
const PAUSE = `Pause schedule ${TITLE}`, STOP = `Stop schedule ${TITLE}`, RUN_NOW = `Run ${TITLE} now`, PASSAGE = `Check the pending passage of ${TITLE}`
type Action = "play" | "pause" | "stop" | "resume" | "check"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "start-intent", configureServer(s) { s.middlewares.use("/recurrence", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/recurrence", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-editor-lifetime.tsx"></script><script type="module" src="/tests/browser/fixtures/mission-recurrence-alerts.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server); await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/recurrence`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function fixture() {
  await mkdir(path.join(tmpdir(), "opencode"), { recursive: true })
  const base = await mkdtemp(path.join(tmpdir(), "opencode", "recurrence-start-intent-"))
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
  const execution = { agent: "worker", model: { providerID: "provider", id: "model" } }
  const config: RecurrenceConfig = { title: TITLE, template: "custom", consigne: "Review.", clock: { time: "08:15", zone: "UTC" }, profileID: "profile",
    executionHost: "local", profiles: { coordinator: execution, roles: { specialist: execution } }, taskMode: "native",
    roots: [{ mode: "directory-only", directory }], watchedConversationIDs: [] }
  await store.create(scheduleID, config, Date.now(), current)
  const read = async () => (await store.read(scheduleID))!
  // The simulated service: its daily Job, settlement observer, crash points and native writes.
  const native = { writes: [] as string[], job: false, settle: false, crash: undefined as undefined | "before" | "start" | "job-started",
    partial: false, statusFails: false, gate: undefined as Promise<void> | undefined }
  const respond = (record: RecurrenceControlRecord) => ({ version: 1, scheduleID, ...record })
  const rpc = {
    recurrenceControl: async (input: { requestID: string; action: Action; expectedRevision: number; retry?: boolean }) => {
      native.writes.push(`${input.action}:${input.requestID}${input.retry ? ":retry" : ""}`)
      await native.gate
      if (native.crash === "before") { native.crash = undefined; throw new Error("service died before beginControl") }
      const before = await read(), previous = before.controls.find(item => item.requestID === input.requestID)
      if (!previous && input.action === "resume" && before.state === "running" && native.job) throw new Error("Recurrence is not interrupted")
      const begun = await store.beginControl(scheduleID, input, current)
      let record = begun.controls.find(item => item.requestID === input.requestID)!
      if (record.controlsComplete || previous && !(input.retry && (input.action === "pause" || input.action === "stop"))) return respond(record)
      if (input.action === "play" || input.action === "resume") {
        if (native.crash === "start") { native.crash = undefined; throw new Error("service died after beginControl") }
        native.settle = false; native.job = true
        if (native.crash === "job-started") { native.crash = undefined; throw new Error("service died after the Job started") }
        record = { ...record, controlsComplete: true, targetsKnown: true }
      } else if (input.action === "check") {
        native.settle = true
        record = { ...record, controlsComplete: true, targetsKnown: true }
      } else {
        // Stop keeps a settlement-only observer for a pending passage; Pause cancels it.
        native.settle = input.action === "stop" && Boolean(begun.pending); native.job = false
        record = { ...record, targetsKnown: true, targets: [], schedulerCancellation: "acknowledged", controlsComplete: !native.partial || Boolean(input.retry) }
      }
      return respond((await store.recordControl(scheduleID, record, current)).controls.find(item => item.requestID === input.requestID)!)
    },
    recurrenceControlStatus: async (input: { requestID: string; action: Action; expectedRevision: number }) => {
      if (native.statusFails) throw new Error("status unavailable")
      const doc = await read(), identity = { version: 1, scheduleID, requestID: input.requestID, expectedRevision: input.expectedRevision }
      let record = doc.controls.find(item => item.requestID === input.requestID)
      if (!record) {
        const reason = recurrenceRequestRefusal(doc, input)
        return reason ? { ...identity, outcome: "rejected", reason } : { ...identity, outcome: "unknown" }
      }
      // Only a positively observed live Job reconciles the latest unknown Play/Resume.
      const latest = doc.controls.filter(item => ["play", "resume", "pause", "stop"].includes(item.action)).at(-1)
      if (!record.controlsComplete && (record.action === "play" || record.action === "resume") && doc.state === "running"
        && latest?.requestID === record.requestID && native.job && !native.settle) {
        record = (await store.recordControl(scheduleID, { ...record, controlsComplete: true, targetsKnown: true }, current)).controls
          .find(item => item.requestID === input.requestID)!
      }
      const { targetsKnown: _known, ...status } = record
      return { ...identity, ...status, outcome: record.controlsComplete ? "committed" : "unknown" }
    },
    recurrenceRunNow: async (input: { requestID: string; expectedRevision: number }) => {
      native.writes.push(`run-now:${input.requestID}`)
      await store.reserveManual(scheduleID, input.requestID, input.expectedRevision, Date.now(),
        { profileID: "profile", executionHost: "local", configYamlPath: yaml }, current)
      throw new Error("service died before the passage was admitted")
    },
    recurrenceRunNowStatus: async (input: { requestID: string; expectedRevision: number }) => {
      if (native.statusFails) throw new Error("status unavailable")
      const doc = await read(), pending = doc.pending?.passage.due.kind === "manual" && doc.pending.passage.due.requestID === input.requestID ? doc.pending : null
      const reason = pending ? undefined : recurrenceRequestRefusal(doc, { ...input, action: "run-now" })
      return recurrenceManualResultSchema.parse({ version: 1, scheduleID, ...input, projectID: "project", projectCanonical: directory, location,
        outcome: pending?.admission ? "accepted" : reason ? "rejected" : "unknown", ...(reason ? { reason } : {}),
        passageID: pending?.passage.id ?? null, messageID: pending?.passage.messageID ?? null, admission: pending?.admission ?? null })
    },
  }
  let connection = { client: { location: { get: async () => ({ ...location, project: { id: "project", canonical: directory } }) }, rpc: () => rpc },
    assertCurrent: () => {} }
  const fence = new WorktreeDeletionFence()
  const manager = { get: () => workspace, getServiceLocation: () => location, getServiceDirectoryForPath: async () => directory,
    getSharedServiceConnection: async () => connection, ownsLocation: async () => true,
    getServiceWslDistro: () => undefined, getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
    getWorktreeIdentityForPath: async () => canonicalWorktreeIdentity(directory), getHostPathForServicePath: async () => directory }
  const deps = { auth, bridgeToken: "existing-bridge-token", fence, manager,
    settings: { configYamlPathForAuthority: () => yaml, getProfileScope: () => selected } }
  const app = Fastify({ logger: false })
  registerMissionRecurrenceControl(app, deps as never)
  registerMissionRecurrenceManual(app, deps as never)
  registerMissionRecurrenceControlStatus(app, deps as never)
  const headers = { cookie: `${auth.getCookieName()}=${human.id}` }
  const permitFree = () => Promise.race([fence.run(directory, [canonicalWorktreeIdentity(directory)], async () => true),
    new Promise<false>(resolve => setTimeout(() => resolve(false), 1_000))])
  /** What native-recurrence-snapshot.ts derives and offers for this document. */
  const snapshot = (doc: RecurrenceDocument) => {
    const state = doc.state === "running" && !native.job ? "interrupted" : doc.state
    const observed = doc.state === "running" && native.job || native.settle
    const actions: string[] = []
    const partial = doc.controls.some(item => !item.controlsComplete && (item.action === "pause" || item.action === "stop"))
    const retry = doc.controls.at(-1)
    if (partial && retry && !retry.controlsComplete && (retry.action === "pause" || retry.action === "stop")) actions.push(retry.action)
    const checkable = (state === "paused" || state === "stopped") && doc.pending && !observed
    const unknownIntent = doc.controls.some(item => !item.controlsComplete)
    if (!partial && state !== "stopped") {
      if (state === "paused" && !doc.pending && !unknownIntent) actions.push("play")
      if (state === "interrupted" || state === "paused" && doc.pending) actions.push("resume")
      if (checkable) actions.push("check")
      if (state === "running" || state === "interrupted") actions.push("pause")
      actions.push("stop")
      if (!doc.pending && !unknownIntent) actions.push("run-now")
    }
    if (!partial && state === "stopped" && checkable) actions.push("check")
    const pendingStatus = doc.pending?.admission ? "running" : observed ? "starting" : "uncertain"
    return recurrenceSnapshotSchema.parse({ version: 1, projectID: "project", projectCanonical: "/fixture", location: { directory: "/fixture" },
      schedules: [{ id: scheduleID, title: TITLE, revision: doc.revision, state, clock: doc.config.clock,
        nextDueAt: state === "running" ? Date.now() + 3_600_000 : null, ...(state === "interrupted" ? { interruptionReason: "service-restart" } : {}),
        pending: doc.pending ? { passageID: doc.pending.passage.id, status: pendingStatus, trigger: doc.pending.passage.due.kind,
          ...(pendingStatus === "uncertain" ? { reason: "not-observed" } : {}) } : null,
        latestResult: null, history: [], actions,
        controls: doc.controls.map(({ targetsKnown: _known, ...record }) => ({ ...record, version: 1, scheduleID,
          outcome: record.controlsComplete ? "committed" : "unknown" })) }] })
  }
  const posts: string[] = [], statusReads: string[] = []
  const handle = async (route: Route) => {
    const request = route.request(), target = new URL(request.url()), pathname = target.pathname
    if (pathname.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: [], generatedAt: 1, discardedEvents: 0 } })
    if (pathname.endsWith("/missions/recurrence")) return route.fulfill({ json: snapshot(await read()) })
    if (pathname.endsWith("/current")) return route.fulfill({ json: { version: 1, projectID: "project", scheduleID, passageID: null } })
    if (/\/(control|run-now)(\/status)?$/.test(pathname)) {
      ;(pathname.endsWith("/status") ? statusReads : posts).push(`${pathname.split("/").slice(-2).join("/")} ${request.postData() ?? target.search}`)
      const response = await app.inject({ method: request.method() as "GET" | "POST", url: `${pathname}${target.search}`,
        headers: { ...headers, ...(request.postData() ? { "content-type": "application/json" } : {}) }, payload: request.postData() ?? undefined })
      return route.fulfill({ status: response.statusCode, contentType: "application/json", body: response.body })
    }
    return route.fulfill({ json: {} })
  }
  return { app, store, native, read, posts, statusReads, permitFree, handle, headers, yaml,
    replaceConnection: () => { connection = { ...connection, assertCurrent: () => {} } },
    dispose: async () => { await app.close(); await rm(base, { recursive: true, force: true }) } }
}

async function open(f: Awaited<ReturnType<typeof fixture>>) {
  const page = await browser.newPage({ locale: "en-US" }), errors: string[] = []
  page.setDefaultTimeout(10_000)
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", f.handle)
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })
  await selectMission(page, TITLE)
  return { page, errors }
}
/** The lifecycle buttons before the separator: [label, enabled]. */
const lifecycle = (page: Page) => missionDetail(page).locator(".mission-action-bar").evaluate(bar => {
  const result: Array<[string | null, boolean]> = []
  for (const node of bar.children) {
    if (node.classList.contains("mission-action-separator")) break
    if (node instanceof HTMLButtonElement) result.push([node.getAttribute("aria-label"), !node.disabled])
  }
  return result
})
const statusText = (page: Page) => missionDetail(page).locator(".mission-action-texts").getByRole("button", { name: CHECK, exact: true })
/** Reload the row from the snapshot (the panel's explicit refresh is read-only here). */
async function refresh(page: Page) {
  await page.evaluate(() => window.missionEditorLifetime.invalidateRecurrence())
  await page.waitForTimeout(250)
}
/** Row reads are asynchronous: wait for the expected lifecycle buttons, then assert them. */
async function expectLifecycle(page: Page, expected: Array<[string, boolean]>, message?: string) {
  for (let index = 0; index < 200 && JSON.stringify(await lifecycle(page)) !== JSON.stringify(expected); index++) await page.waitForTimeout(50)
  const actual = await lifecycle(page)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) console.error(await missionDetail(page).innerText())
  assert.deepEqual(actual, expected, message)
}
async function until(condition: () => Promise<boolean>) {
  for (let index = 0; index < 100 && !await condition(); index++) await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(await condition(), true, "condition timed out")
}
async function confirmStop(page: Page) {
  await missionToolbarAction(page, STOP).click()
  await page.getByRole("dialog").getByRole("button", { name: "Stop", exact: true }).click()
}

for (const superseding of ["resume", "stop"] as const) test(`an unknown Play cut by a service crash is superseded only by an explicit native-offered ${superseding}`, async () => {
  const f = await fixture(), { page, errors } = await open(f)
  try {
    f.native.crash = "start"
    await missionToolbarAction(page, PLAY).click()
    // The lost reply holds the Play; its first exact read stays unknown and rereads the row.
    await missionToolbarAction(page, CHECK).click()
    // Interrupted (no Job) with an incomplete Play: native offers Resume/Pause/Stop, never Run now or Play.
    await statusText(page).waitFor()
    await expectLifecycle(page, [[RESUME, true], [STOP, true], [RUN_NOW, false]])
    const play = (await f.read()).controls[0]!
    assert.equal(play.action, "play"); assert.equal(play.controlsComplete, false)
    for (let index = 0; index < 3; index++) {
      await statusText(page).click()
      await page.waitForTimeout(200)
    }
    assert.equal(f.statusReads.filter(item => item.includes(play.requestID)).length >= 3, true, "repeated reads stay read-only")
    assert.deepEqual(f.native.writes, [`play:${play.requestID}`], "unknown reads never resend Play")
    await statusText(page).waitFor()
    if (superseding === "resume") await missionToolbarAction(page, RESUME).click()
    else await confirmStop(page)
    await until(async () => (await f.read()).controls[1]?.controlsComplete === true)
    await missionToolbarAction(page, CHECK).waitFor({ state: "hidden" })
    await statusText(page).waitFor({ state: "hidden" })
    const doc = await f.read(), next = doc.controls[1]!
    assert.equal(f.native.writes.length, 2, "one new explicit request, no Play replay")
    assert.equal(f.native.writes[1], `${superseding}:${next.requestID}`)
    assert.notEqual(next.requestID, play.requestID)
    assert.equal(next.controlsComplete, true)
    assert.equal(doc.controls[0]!.controlsComplete, true, "native settled the Play only by the completed superseding control")
    assert.equal(doc.state, superseding === "resume" ? "running" : "stopped")
    assert.equal(await f.permitFree(), true, "both physical permits were released")
    await refresh(page)
    if (superseding === "resume") await expectLifecycle(page, [[PAUSE, true], [STOP, true], [RUN_NOW, true]])
    else {
      await until(async () => !(await lifecycle(page)).some(([, enabled]) => enabled))
      assert.equal((await lifecycle(page)).some(([label]) => label === CHECK), false, "terminal and settled: nothing held")
    }
    assert.deepEqual(errors, [])
  } finally { await page.close(); await f.dispose() }
})

for (const superseding of ["check", "stop"] as const) test(`an unadmitted Run now on a paused schedule admits an explicit ${superseding} and stays truthfully unknown`, async () => {
  const f = await fixture(), { page, errors } = await open(f)
  try {
    await missionToolbarAction(page, RUN_NOW).click()
    await missionToolbarAction(page, CHECK).click()
    await statusText(page).waitFor()
    await expectLifecycle(page, [[PASSAGE, true], [STOP, true], [RUN_NOW, false]])
    const manual = (await f.read()).controls[0]!
    for (let index = 0; index < 3; index++) {
      await statusText(page).click()
      await page.waitForTimeout(200)
    }
    assert.deepEqual(f.native.writes, [`run-now:${manual.requestID}`], "unknown reads never resend Run now")
    await statusText(page).waitFor()
    if (superseding === "check") await missionToolbarAction(page, PASSAGE).click()
    else await confirmStop(page)
    await until(async () => (await f.read()).controls[1]?.controlsComplete === true)
    const doc = await f.read()
    assert.equal(f.native.writes.length, 2)
    assert.equal(f.native.writes[1], `${superseding}:${doc.controls[1]!.requestID}`)
    assert.equal(doc.controls[1]!.controlsComplete, true)
    // Run now completes only on its passage's admission or archive, never on Check/Stop.
    assert.equal(doc.controls[0]!.controlsComplete, false)
    assert.equal(await f.permitFree(), true, "the completed superseding control retired the crashed call's permit")
    await refresh(page)
    // Its exact status still reads unknown: the UI keeps it held and resends nothing. After
    // Check, the live observer leaves Resume/Stop; a terminal Stop leaves only the status read.
    if (superseding === "check") await expectLifecycle(page, [[RESUME, true], [STOP, true], [RUN_NOW, false]])
    else await expectLifecycle(page, [[CHECK, true], [STOP, false], [RUN_NOW, false]])
    const held = superseding === "check" ? statusText(page) : missionToolbarAction(page, CHECK)
    const reads = f.statusReads.length
    await held.click()
    await until(async () => f.statusReads.length > reads)
    await held.waitFor()
    assert.equal(f.native.writes.length, 2, "no automatic replay of Run now")
    assert.deepEqual(errors, [])
  } finally { await page.close(); await f.dispose() }
})

test("a completed Check on a stopped pending passage releases its UI request without reopening the schedule", async () => {
  const f = await fixture()
  const revision = (await f.read()).revision
  await f.store.reserveManual(scheduleID, "manual_admitted", revision, Date.now(),
    { profileID: "profile", executionHost: "local", configYamlPath: f.yaml }, current)
  // Isolate a completed manual record with a pending passage, then terminal Stop.
  const manual = (await f.read()).controls.at(-1)!
  await f.store.recordControl(scheduleID, { ...manual, controlsComplete: true, targetsKnown: true }, current)
  const begun = await f.store.beginControl(scheduleID, { requestID: "stop_seed", action: "stop", expectedRevision: (await f.read()).revision }, current)
  await f.store.recordControl(scheduleID, { ...begun.controls.at(-1)!, controlsComplete: true, targetsKnown: true }, current)
  const { page, errors } = await open(f)
  try {
    await expectLifecycle(page, [[PASSAGE, true], [STOP, false], [RUN_NOW, false]])
    await missionToolbarAction(page, PASSAGE).click()
    await until(async () => (await f.read()).controls.at(-1)?.action === "check" && (await f.read()).controls.at(-1)?.controlsComplete === true)
    await until(async () => !await missionDetail(page).getByText("Control outcome unconfirmed; check status before another action.", { exact: true }).count())
    assert.equal((await f.read()).state, "stopped")
    assert.equal(f.native.writes.length, 1)
    // The observer is lost again: the same page can explicitly Check passage anew.
    f.native.settle = false
    await refresh(page)
    await expectLifecycle(page, [[PASSAGE, true], [STOP, false], [RUN_NOW, false]])
    await missionToolbarAction(page, PASSAGE).click()
    await until(async () => f.native.writes.length === 2)
    assert.notEqual(f.native.writes[0], f.native.writes[1], "only a new explicit action creates a fresh Check request")
    assert.deepEqual(errors, [])
  } finally { await page.close(); await f.dispose() }
})

for (const action of ["pause", "stop"] as const) test(`a local unknown Play sees another client's later partial ${action} and retries only that recorded tuple`, async () => {
  const f = await fixture(), { page, errors } = await open(f)
  try {
    f.native.crash = "start"
    await missionToolbarAction(page, PLAY).click()
    await missionToolbarAction(page, CHECK).click()
    await statusText(page).waitFor()
    const started = (await f.read()).controls[0]!
    f.native.partial = true
    const request = { action, requestID: `other_client_${action}`, expectedRevision: (await f.read()).revision }
    const response = await f.app.inject({ method: "POST", url: `/api/workspaces/fixture/missions/recurrence/${scheduleID}/control`,
      headers: f.headers, payload: request })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().controlsComplete, false)
    await refresh(page)
    await expectLifecycle(page, [[CHECK, true], [STOP, false], [RUN_NOW, false]])
    assert.equal(await statusText(page).count(), 0)
    assert.equal(f.native.writes.length, 2, "a refreshed snapshot does not resend anything")
    await missionRefresh(page).click()
    await until(async () => f.native.writes.length === 3)
    assert.equal(f.native.writes[2], `${action}:${request.requestID}:retry`)
    assert.equal((await f.read()).controls.find(item => item.requestID === started.requestID)?.controlsComplete, true)
    assert.equal(await f.permitFree(), true)
    assert.deepEqual(errors, [])
  } finally { await page.close(); await f.dispose() }
})

test("a partial Pause, a failed status read and a live Job keep every hold without new or automatic sends", async () => {
  const f = await fixture()
  let opened = await open(f)
  try {
    const { page } = opened
    // Live Job after a cut Play (its route's own status read also failed): Resume is never
    // offered, and the original's exact read reconciles it without a duplicate start.
    f.native.crash = "job-started"; f.native.statusFails = true
    await missionToolbarAction(page, PLAY).click()
    // A failed read retains the request without rereading; the row's own invalidation does.
    await missionToolbarAction(page, CHECK).click()
    await page.waitForTimeout(200)
    await missionToolbarAction(page, CHECK).waitFor()
    await refresh(page)
    await statusText(page).waitFor()
    await expectLifecycle(page, [[PAUSE, true], [STOP, true], [RUN_NOW, false]], "a running native Job never offers Resume")
    f.native.statusFails = false
    await statusText(page).click()
    await statusText(page).waitFor({ state: "hidden" })
    await refresh(page)
    await expectLifecycle(page, [[PAUSE, true], [STOP, true], [RUN_NOW, true]])
    assert.equal((await f.read()).controls[0]!.controlsComplete, true)
    assert.equal(f.native.writes.length, 1, "no duplicate start")

    // A partial Pause keeps only its exact retry; a new Stop stays disabled and unsent.
    f.native.partial = true
    await missionToolbarAction(page, PAUSE).click()
    await missionToolbarAction(page, CHECK).waitFor()
    await refresh(page)
    await expectLifecycle(page, [[CHECK, true], [STOP, false], [RUN_NOW, false]])
    assert.equal(await statusText(page).count(), 0)
    // Failed status reads keep it held.
    f.native.statusFails = true
    for (let index = 0; index < 2; index++) { await missionToolbarAction(page, CHECK).click(); await page.waitForTimeout(200) }
    await missionToolbarAction(page, CHECK).waitFor()
    assert.equal(f.native.writes.length, 2)
    // A fresh request from another window is refused by the held permit before native.
    const refused = await f.app.inject({ method: "POST", url: `/api/workspaces/fixture/missions/recurrence/${scheduleID}/control`,
      headers: f.headers, payload: { action: "stop", requestID: "stop_foreign", expectedRevision: (await f.read()).revision } })
    assert.equal(refused.statusCode, 409, refused.body)
    assert.equal(f.native.writes.length, 2, "nothing reached native")
    // Remounting never resends; only the explicit refresh retries the exact partial Pause.
    await page.evaluate(() => window.missionEditorLifetime.mount(false))
    await page.evaluate(() => window.missionEditorLifetime.mount(true))
    await selectMission(page, TITLE)
    await missionToolbarAction(page, CHECK).waitFor()
    assert.equal(f.native.writes.length, 2)
    f.native.statusFails = false
    await missionRefresh(page).click()
    await missionToolbarAction(page, CHECK).waitFor({ state: "hidden" })
    assert.match(f.native.writes[2]!, /^pause:.*:retry$/)
    assert.equal(await f.permitFree(), true)
    assert.deepEqual(opened.errors, [])
  } finally { await opened.page.close(); await f.dispose() }
})

test("backend supersession needs the exact recorded intent, never steals an in-flight permit and survives a replaced connection", async () => {
  const f = await fixture()
  const control = (action: Action, requestID: string, expectedRevision: number) => f.app.inject({ method: "POST",
    url: `/api/workspaces/fixture/missions/recurrence/${scheduleID}/control`, headers: f.headers, payload: { action, requestID, expectedRevision } })
  try {
    // An in-flight Play keeps its exclusive permit: a new Pause is refused before native.
    let open!: () => void
    f.native.gate = new Promise(resolve => { open = resolve })
    const inflight = control("play", "play_inflight", 0)
    await new Promise(resolve => setTimeout(resolve, 100))
    const stolen = await control("pause", "pause_steal", 0)
    assert.equal(stolen.statusCode, 409, stolen.body)
    assert.equal(stolen.json().code, "recurrence-not-dispatched")
    f.native.crash = "start"; open(); f.native.gate = undefined
    assert.equal((await inflight).statusCode, 503)
    assert.deepEqual(f.native.writes, ["play:play_inflight"])
    // The service restarted: the backend's connection is replaced. A fresh explicit
    // Stop re-proves owner and the exact incomplete Play through the new connection.
    f.replaceConnection()
    const revision = (await f.read()).revision
    const stop = await control("stop", "stop_after_crash", revision)
    assert.equal(stop.statusCode, 200, stop.body)
    assert.deepEqual(f.native.writes, ["play:play_inflight", "stop:stop_after_crash"])
    assert.equal((await f.read()).controls[0]!.controlsComplete, true)
    assert.equal(await f.permitFree(), true)

    // A start intent with no native record (cut before beginControl) cannot be superseded.
    const g = await fixture()
    try {
      g.native.crash = "before"
      const lost = await g.app.inject({ method: "POST", url: `/api/workspaces/fixture/missions/recurrence/${scheduleID}/control`,
        headers: g.headers, payload: { action: "play", requestID: "play_unrecorded", expectedRevision: 0 } })
      assert.equal(lost.statusCode, 503)
      g.native.statusFails = true
      const refused = await g.app.inject({ method: "POST", url: `/api/workspaces/fixture/missions/recurrence/${scheduleID}/control`,
        headers: g.headers, payload: { action: "pause", requestID: "pause_guess", expectedRevision: 0 } })
      assert.equal(refused.json().code, "recurrence-not-dispatched", refused.body)
      assert.deepEqual(g.native.writes, ["play:play_unrecorded"], "no guessed supersession reached native")
      assert.equal(await g.permitFree(), false, "the original uncertain permit is retained")
    } finally { await g.dispose() }
  } finally { await f.dispose() }
})
