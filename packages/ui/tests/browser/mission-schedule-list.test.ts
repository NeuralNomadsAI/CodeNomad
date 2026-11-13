import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdir } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { expandRow, missionMenuItemState } from "./mission-actions"
import { NativeMissionDocumentStore } from "../../../server/src/missions/mission-document-store"
import { missionDocumentChanges as changes } from "../../../server/src/missions/mission-document-state"
import { missionScheduleView } from "../../../server/src/missions/mission-schedule-view"
import { missionDocumentSummary } from "../../../server/src/missions/mission-document-one-time"
import type { MissionDocument } from "../../../server/src/missions/mission-document"
import type { MissionJsonValue } from "../../../server/src/missions/model"
import { missionLaunchModel, type MissionConfiguration } from "../../../server/src/missions/launch-policy"
import { legacyLaunch } from "../../../server/src/missions/legacy-launch-test-helper"
import { BUILT_IN_COLOR_SCHEMES } from "../../src/lib/theme-scheme"

let browser: Browser, url: string, events: Server, eventsURL: string
before(async () => {
  const fixture = await borrowFixture({ name: "mission-schedule-list", routes: [{ path: "/list",
    html: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-control.tsx"></script></body></html>' }] })
  url = fixture.url
  events = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": new URL(url).origin, "Access-Control-Allow-Credentials": "true" })
    response.write(": fixture transport; native events use the real dispatcher\n\n")
  })
  await new Promise<void>(resolve => events.listen(0, "127.0.0.1", resolve))
  eventsURL = `http://127.0.0.1:${(events.address() as { port: number }).port}/api/events`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => {
  try { await browser?.close() }
  finally { if (events) { events.closeAllConnections(); await new Promise<void>((resolve, reject) => events.close(error => error ? reject(error) : resolve())) } }
})
const profiles = { coordinator: { agent: "coordinator", model: { providerID: "p", id: "m" } },
  roles: { specialist: { agent: "specialist", model: { providerID: "p", id: "m" } } } }
async function setup(page: Page, options: { seed?: boolean; enabled?: boolean; available?: boolean; locale?: string; journalGate?: Promise<void>; outsidePage?: boolean } = {}) {
  page.setDefaultTimeout(15_000)
  const values = new Map<string, MissionJsonValue>(), posts: Record<string, any>[] = [], activations: Record<string, any>[] = [], reads: string[] = [], errors: string[] = []
  const store = new NativeMissionDocumentStore({ get: async key => values.get(key),
    compareAndSet: async (key, value) => { values.set(key, structuredClone(value)) } }, "project", "fixture")
  const config = { title: "Inspect local changes", objective: "Inspect local changes and report useful findings.", template: "custom" as const,
    profiles, taskMode: "native" as const, profileID: "profile", executionHost: "local", roots: [{ mode: "directory-only" as const, directory: "fixture" }],
    watchedConversationIDs: [], launch: { timing: { kind: "every" as const, intervalMs: 900_000 }, condition: null,
      ends: { maxLaunches: 3, at: null, afterMs: null } } }
  let doc: MissionDocument | undefined = options.seed ? await store.create("msn_schedule", config, Date.now(), () => true) : undefined
  const firstPage = options.outsidePage ? await Promise.all(Array.from({ length: 8 }, (_, i) =>
    store.create(`aaa_${i}`, { ...config, title: `Inventory Mission ${i}` }, Date.now(), () => true))) : []
  let outside = false
  const extras: MissionDocument[] = []
  let deleted = false, lost: string | undefined, partial: string | undefined, proof = true, enabled = options.enabled ?? true, activation: Record<string, any> | undefined
  const receipts = new Map<string, Record<string, any>>()
  function result(requestID?: string) {
    if (deleted) {
      const receipt = requestID ? receipts.get(requestID) : [...receipts.values()].at(-1)
      return { document: null, pending: !!requestID && !proof, deleted: proof,
        ...(proof && receipt?.action === "delete" ? { deletionReceipt: { id: doc!.id, requestID: receipt.requestID,
          expectedRevision: receipt.expectedRevision, deleteManagedSessions: false } } : {}) }
    }
    const view = missionScheduleView(doc)
    if (!doc) return view
    const control = requestID ? proof && receipts.get(requestID) : [...receipts.values()].at(-1)
    return { ...view, pending: requestID ? !control || !!control.pending : outside && !!control?.pending, document: { ...view.document,
      availableActions: [...view.document!.availableActions, ...([...receipts.values()].some(item => item.pending) ? ["check"] : [])],
      observation: { state: doc.firstPlayedAt === null ? "unarmed" : "known", nativeStatus: doc.firstPlayedAt === null ? null : doc.state === "running" ? "active" : "paused",
        nextDueAt: doc.state === "running" ? Date.now() + 900_000 : null, wakeCount: doc.launchedCount,
        kind: missionLaunchModel(doc.configuration.launch).events.length ? "check" : "launch", timeGeneration: doc.timeGeneration },
      control: control ? { requestID: control.requestID, expectedRevision: control.expectedRevision, action: control.action, pending: !!control.pending } : null } }
  }
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/events?*", route => route.continue({ url: eventsURL }))
  await page.route("**/api/storage/config/ui", route => route.fulfill({ json: { settings: { locale: options.locale ?? "en",
    missionProfileDefaults: [{ template: "custom", profiles }] } } }))
  await page.route("**/api/workspaces/fixture/missions**", async route => {
    const request = route.request(), link = new URL(request.url()), target = link.pathname
    if (request.method() === "GET") {
      reads.push(request.url())
      if (target.endsWith("/capabilities")) return route.fulfill({ json: { location: { directory: "fixture" },
        api: { available: options.available ?? true }, enabled, origin: null,
        activation: { available: options.available ?? true, targets: [{ scope: "global", path: "/private/config/opencode.jsonc" }] } } })
      if (target.endsWith("/schedule-settings")) return route.fulfill({ json: { document: missionDocumentSummary(doc!) } })
      if (target.endsWith("/scheduled")) return route.fulfill({ json: { version: 1, projectID: "project",
        schedules: outside && !link.searchParams.has("after") ? firstPage.map(doc => missionScheduleView(doc).document)
          : [...doc && !deleted ? [result().document] : [], ...extras.map(extra => missionScheduleView(extra).document)],
        ...(outside && !link.searchParams.has("after") ? { next: "aaa_7" } : {}) } })
      if (target.endsWith("/schedule")) {
        const value = result(link.searchParams.get("requestID") ?? undefined)
        return route.fulfill({ status: value.pending ? 503 : 200, json: { ...value, ...(value.pending ? { code: "schedule-pending" } : {}) } })
      }
      if (target.endsWith("/recurrence")) return route.fulfill({ json: { version: 1, projectID: "project", projectCanonical: "fixture",
        location: { directory: "fixture" }, schedules: [] } })
      if (target.endsWith("/missions")) await options.journalGate
      return route.fulfill({ json: { available: true, version: 1, projectID: "project", missions: [], summaries: [], generatedAt: 1, discardedEvents: 0 } })
    }
    const body = request.postDataJSON()
    if (target.endsWith("/schedule-settings")) {
      activations.push({ ...body, target })
      if (options.enabled === false) posts.push({ ...body, target })
      assert.equal(body.expectedDocumentRevision, doc!.revision, "activation uses the revision admitted by the UI")
      activation = body
      if (doc!.scheduleActivation?.state !== "ready") doc = await store.change(doc!.id, doc!.revision, () => true, value => { value.scheduleActivation = { requestID: body.requestID,
        expectedRevision: body.expectedDocumentRevision, authority: "a".repeat(64), state: "ready", targets: [], effectiveOrigin: "/private/config/opencode.jsonc" } })
      enabled = true
      if (lost === "activation") return route.abort("connectionreset")
      return route.fulfill({ json: { document: missionDocumentSummary(doc) } })
    }
    posts.push({ ...body, target })
    if (body.action === "create") doc = await store.create("msn_schedule", { ...config, ...body.configuration }, Date.now(), () => true)
    else if (body.action === "delete") deleted = true
    else doc = await store.change(doc!.id, body.expectedRevision, () => true, value => {
      if (body.action === "play") { changes.play(value, body.requestID, Date.now(), []); value.synchronization = null }
      if (body.action === "pause") value.state = "paused"
      if (body.action === "resume") value.state = "running"
      if (body.action === "stop") value.state = "stopped"
      if (body.action === "configure") changes.configure(value, { ...value.configuration, ...body.configuration }, Date.now())
      if (body.action === "run-now") {
        const state = value.state; value.state = "running"
        changes.reserve(value, { kind: "manual", requestID: body.requestID }, Date.now(), [])
        changes.admitted(value, value.pending!.id, Date.now()); changes.settle(value, value.pending!.id, "completed", Date.now()); value.state = state
      }
    })
    receipts.set(body.requestID, { ...body, pending: partial === body.action })
    if (lost === body.action) return route.abort("connectionreset")
    const value = result(body.requestID)
    return route.fulfill({ status: value.pending ? 503 : 200, json: { ...value, ...(value.pending ? { code: "schedule-pending" } : {}) } })
  })
   let streamObserved = false
   const observeStream = (response: import("playwright").Response) => { if (response.headers()["content-type"] === "text/event-stream") streamObserved = true }
   page.on("response", observeStream)
   await page.goto(url)
   await page.waitForFunction(() => (window as any).missionFixture, undefined, { timeout: 60_000 }).catch(error => { throw new Error(`${error}\n${errors.join("\n")}`) })
   await page.evaluate(() => (window as any).missionFixture.connectCatalog())
   if (!streamObserved) await page.waitForResponse(response => response.headers()["content-type"] === "text/event-stream")
   page.off("response", observeStream)
  return { posts, activations, reads, errors, store, get doc() { return doc! }, result,
    addSchedule: async (id: string, change: Partial<MissionConfiguration>) => {
      extras.push(await store.create(id, { ...config, ...change } as MissionConfiguration, Date.now(), () => true))
    },
    set outside(value: boolean) { outside = value }, resolve: () => { for (const receipt of receipts.values()) receipt.pending = false },
    set lost(value: string | undefined) { lost = value }, set partial(value: string | undefined) { partial = value },
    set proof(value: boolean) { proof = value }, get activation() { return activation },
    set enabled(value: boolean) { enabled = value },
    change: async (update: (value: MissionDocument) => void = value => { value.configuration.notes = "Concurrent change" }) => {
      doc = await store.change(doc!.id, doc!.revision, () => true, update)
    } }
}
const detail = (page: Page) => page.locator(".mission-unified-schedule")
const technicalCalendars = () => (["principal", "reconciliation"] as const).map((role, slot) => ({ role, slot: role === "principal" ? slot : 0,
  timeGeneration: 1, scheduleID: `sch_${role}_${"a".repeat(90)}`, sessionID: `ses_cn_schedule_${role}_${"b".repeat(90)}`,
  highWater: 2, pendingWake: null, wakePreparing: null }))
/** A selected schedule's toolbar and text actions sit in the persistent header's selection line. */
const button = (page: Page, name: string) => page.locator(".mission-picker-selection-actions").getByRole("button", { name, exact: true })
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

test("unified waiting and exact successful passages distinguish prepared, pause, unknown and finished", async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true })
  const entry = page.locator('[data-mission-key="scheduled:msn_schedule"] .mission-row-select')
  const waitMark = (expected: string) => page.waitForFunction(expected =>
    document.querySelector('[data-mission-key="scheduled:msn_schedule"] .mission-row-flag')?.getAttribute("data-mark") === expected, expected)
  const refresh = () => page.evaluate(() => (window as any).missionFixture.refresh())
  const success = async (requestID: string) => {
    await f.change(doc => {
      changes.reserve(doc, { kind: "manual", requestID }, Date.now(), [])
      changes.admitted(doc, doc.pending!.id, Date.now())
      changes.settle(doc, doc.pending!.id, "completed", Date.now())
    })
    await refresh(); await waitMark("done")
  }
  try {
    await entry.waitFor(); await waitMark("prepared")
    assert.equal(await entry.locator(".mission-row-mark").evaluate(element => getComputedStyle(element, "::after").content), "none")
    await select(page); await click(page, "Play"); await waitMark("waiting")
    assert.match(await entry.getAttribute("title") ?? "", /Waiting for scheduled run/)
    await click(page, "Pause"); await waitMark("paused")
    await click(page, "Resume"); await waitMark("waiting")
    await success("first-result")
    const first = f.doc.history.at(-1)!.id
    await entry.click(); await waitMark("waiting")
    await success("second-result")
    assert.notEqual(f.doc.history.at(-1)!.id, first)
    await page.locator('[data-mission-key="scheduled:msn_schedule"] .session-item-expander').click({ button: "right" })
    await page.getByRole("menuitem", { name: "Mark as read", exact: true }).click()
    await waitMark("waiting")
    await f.change(doc => { doc.state = "finished" }); await refresh(); await waitMark("idle")
    await f.change(doc => { doc.state = "running" })
    await page.route(url => url.pathname.endsWith("/missions/scheduled"), route => {
      const doc = f.result().document!
      return route.fulfill({ json: { version: 1, projectID: "project", schedules: [{ ...doc,
        observation: { ...doc.observation, state: "unknown", nativeStatus: null, nextDueAt: null } }] } })
    })
    await refresh(); await waitMark("unconfirmed")
    assert.match(await entry.getAttribute("title") ?? "", /State unconfirmed/)
    assert.equal(await entry.locator(".mission-row-mark").evaluate(element => getComputedStyle(element, "::after").content), "none")
    await f.change(doc => { doc.state = "stopped" }); await refresh(); await waitMark("idle")
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})
async function select(page: Page) {
  const entry = page.locator(".mission-rows button.mission-row-select").filter({ hasText: "Inspect local changes" })
  await entry.click()
  // A click only selects the row; its chevron shows the detail.
  await expandRow(entry)
  await detail(page).waitFor()
}
async function click(page: Page, name: string, confirm = false) {
  const label = name === "Play" ? "Start" : name === "Delete" ? "Delete selected mission…" : name === "Stop" ? "Stop…" : name
  await button(page, label).click()
  if (confirm) await page.getByRole("dialog").getByRole("button", { name: label, exact: true }).click()
}
async function capture(page: Page, name: string) {
  const dir = process.env.CODENOMAD_MISSION_CAPTURE_DIR
  if (dir) { await mkdir(dir, { recursive: true }); await page.screenshot({ path: path.join(dir, name), fullPage: true }) }
}

test("real panel Create → Play → Pause/Resume → Run now → Stop → Delete keeps launch counts and native control routes", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } }), f = await setup(page)
  try {
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor")
    await form.getByLabel("Objective", { exact: true }).fill("Inspect local changes")
    await form.getByLabel("Criterion 1 type", { exact: true }).selectOption("daily")
    await form.getByLabel("Criterion 1 type", { exact: true }).selectOption("hours")
    await form.getByLabel("Criterion 1 hours", { exact: true }).selectOption("1")
    await form.getByRole("button", { name: "Create", exact: true }).click()
    await form.waitFor({ state: "detached" })
    assert.deepEqual(f.posts.map(post => post.action), ["create"])
    await select(page); await capture(page, "schedule-paused-en.png")
    assert.match(await detail(page).locator("dd").first().innerText(), /^Every N hours · 1$/)
    assert.equal(await detail(page).getByText("Until", { exact: true }).count(), 0)
    assert.equal(await detail(page).getByText("Source verifications", { exact: true }).count(), 0)
    assert.equal(await detail(page).locator(".mission-schedule-notice").count(), 0)
    assert.equal(await detail(page).locator("dt").count(), 6)
    await click(page, "Play"); await button(page, "Pause").waitFor({ state: "visible" }).catch(async error => { throw new Error(`${error}\n${JSON.stringify(f.posts)}\n${await detail(page).innerText()}\n${f.errors.join("\n")}`) })
    assert.equal(f.doc.launchedCount, 0)
    await click(page, "Pause"); await button(page, "Resume").waitFor({ state: "visible" })
    await click(page, "Resume"); await button(page, "Pause").waitFor({ state: "visible" })
    await click(page, "Run now", true)
    await detail(page).getByText("Successful passages", { exact: true }).waitFor()
    await page.waitForFunction(() => document.querySelector(".mission-past-runs ol li"))
    assert.equal(f.doc.launchedCount, 1); assert.equal(f.doc.successfulCount, 1)
    await capture(page, "schedule-running-history-en.png")
    await click(page, "Stop", true)
    await page.waitForFunction(() => (document.querySelector('.mission-picker-selection-actions [aria-label="Start"]') as HTMLButtonElement)?.disabled)
    await click(page, "Delete", true); await detail(page).waitFor({ state: "detached" })
    assert.deepEqual(f.posts.map(post => post.action), ["create", "play", "pause", "resume", "run-now", "stop", "delete"])
    assert.equal(new Set(f.posts.map(post => post.requestID)).size, f.posts.length)
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

for (const lost of ["play", "pause", "run-now", "stop", "delete"]) test(`lost ${lost} ACK survives remount and read-only refresh without resending`, async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true })
  try {
    await select(page)
    if (lost !== "play") {
      await click(page, "Play")
      await button(page, "Pause").waitFor({ state: "visible" }).catch(async error => { throw new Error(`${error}\n${JSON.stringify(f.posts)}\n${await detail(page).innerText()}\n${f.errors.join("\n")}`) })
    }
    f.lost = lost; f.proof = false
    const name = { play: "Play", pause: "Pause", "run-now": "Run now", stop: "Stop", delete: "Delete" }[lost]!
    await click(page, name, ["run-now", "stop", "delete"].includes(lost))
    await page.locator(".mission-picker-selection-actions").getByRole("status").filter({ hasText: "This request is unconfirmed" }).waitFor().catch(async error => { throw new Error(`${error}\n${JSON.stringify(f.posts)}\n${await detail(page).innerText()}\n${f.errors.join("\n")}`) })
    const count = f.posts.length, original = f.posts.at(-1)!
    await page.evaluate(() => (window as any).missionFixture.mount(false))
    await page.evaluate(() => (window as any).missionFixture.mount(true))
    await expandRow(page.locator(".mission-rows button.mission-row-select[aria-current=true]"))
    await button(page, "Refresh saved request").click()
    assert.equal(f.posts.length, count)
    f.proof = true
    await button(page, "Refresh saved request").click()
    await button(page, "Refresh saved request").waitFor({ state: "detached" })
    assert.equal(f.posts.length, count)
    assert.ok(f.reads.some(url => url.includes(`requestID=${original.requestID}`)))
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("revision conflict is refused before dispatch and preserves the refreshed configuration", async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true })
  try {
    await select(page)
    let changed = false
    await page.route(url => url.pathname.endsWith(`/${f.doc.id}/schedule`), async route => {
      if (!changed) { changed = true; await f.change() }
      await route.fulfill({ json: f.result() })
    })
    await click(page, "Play")
    await page.locator(".mission-picker-selection-actions").getByRole("status").filter({ hasText: "The Mission changed" }).waitFor()
    assert.equal(f.posts.length, 0); assert.equal(f.doc.configuration.notes, "Concurrent change")
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("silent activation with a lost ACK never sends Play automatically", async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true, enabled: false })
  try {
    await select(page); f.lost = "activation"; await click(page, "Play")
    assert.equal(await page.getByRole("dialog").count(), 0)
    await button(page, "Refresh saved request").waitFor()
    // Receipt settlement releases the hold before its parent's list revalidation.
    // Wait for that exact activated revision to traverse the real response/render path.
    const refreshed = page.waitForResponse(async response => response.request().method() === "GET"
      && new URL(response.url()).pathname.endsWith("/missions/scheduled")
      && (await response.json()).schedules?.some((row: any) => row.id === f.doc.id && row.revision === f.doc.revision))
    await button(page, "Refresh saved request").click()
    await button(page, "Refresh saved request").waitFor({ state: "detached" })
    await (await refreshed).finished()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    assert.equal(f.posts.length, 1); assert.equal(f.posts[0].target.endsWith("/schedule-settings"), true)
    f.lost = undefined; await click(page, "Play"); await button(page, "Pause").waitFor().catch(async error => {
      throw new Error(`${error}\n${JSON.stringify({ posts: f.posts, reads: f.reads, document: f.doc })}\n${await detail(page).innerText()}\n${f.errors.join("\n")}`)
    })
    assert.deepEqual(f.posts.map(post => post.action), [undefined, "play"])
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("already ON without a receipt prepares on the server; only Start loads and double clicks send one Play", async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true })
  const gate = deferred(), submitted = deferred()
  try {
    await select(page)
    const start = button(page, "Start"), bounds = await start.boundingBox()
    await page.route("**/schedule-settings", async route => {
      if (route.request().method() === "POST") { submitted.resolve(); await gate.promise }
      return route.fallback()
    })
    await start.click(); await submitted.promise
    assert.equal(await start.getAttribute("aria-busy"), "true")
    assert.deepEqual(await start.boundingBox(), bounds)
    assert.equal(await button(page, "Stop…").getAttribute("aria-busy"), null)
    const status = page.locator(".mission-picker-selection-actions [role=status]")
    assert.equal(await status.count(), 1)
    assert.equal(await status.textContent(), "Starting…")
    assert.equal(await page.getByRole("dialog").count(), 0)
    await start.evaluate(element => element.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    for (const scheme of BUILT_IN_COLOR_SCHEMES) {
      await page.evaluate(async scheme => {
        const module = await import("/src/lib/theme-scheme.ts")
        module.applyColorScheme(module.normalizeColorScheme(scheme))
      }, scheme.id)
      const sample = await start.evaluate(element => {
        const style = getComputedStyle(element), svg = element.querySelector("svg")!
        const canvas = document.createElement("canvas").getContext("2d")!
        const probe = document.createElement("span"); probe.style.color = "var(--surface-canvas)"; element.append(probe)
        const [icon, surface] = [getComputedStyle(svg).color, getComputedStyle(probe).color].map(color => {
          canvas.fillStyle = color; canvas.fillRect(0, 0, 1, 1)
          return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3)
        })
        probe.remove()
        return { opacity: style.opacity, icon, surface, width: parseFloat(getComputedStyle(svg).width) }
      })
      const luminance = (rgb: number[]) => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
        .reduce((total, v, i) => total + v * [.2126, .7152, .0722][i], 0)
      const [a, b] = [luminance(sample.icon), luminance(sample.surface)].sort((a, b) => b - a)
      assert.ok((a + .05) / (b + .05) >= 3, `${scheme.id}: ${JSON.stringify(sample)}`)
      assert.equal(sample.opacity, "1"); assert.equal(sample.width, 14)
    }
    await page.emulateMedia({ reducedMotion: "reduce" })
    const motion = await start.locator("svg").evaluate(element => {
      const style = getComputedStyle(element)
      return { duration: style.animationDuration, iterations: style.animationIterationCount }
    })
    assert.equal(motion.iterations, "1"); assert.ok(parseFloat(motion.duration) <= .00001)
    gate.resolve()
    await button(page, "Pause").and(page.locator(":enabled")).waitFor()
    assert.equal(f.activations.length, 1); assert.deepEqual(f.posts.map(post => post.action), ["play"])
    assert.equal(await page.locator(".mission-action-bar [aria-busy=true]").count(), 0)
    assert.deepEqual(f.errors, [])
  } finally { gate.resolve(); await page.close() }
})

for (const layer of ["project", "global", "inherited", "environment"] as const)
test(`explicit ${layer} OFF exposes only the supported repair action and hides details behind keyboard info`, async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true })
  try {
    await select(page)
    const openable = layer === "project" || layer === "global", path = layer === "environment" ? undefined : "/private/responsible/opencode.jsonc"
    const refusal = { reason: "explicit-off", provenance: layer === "environment" ? "environment" : "experimental-block",
      layer, path, openable, ...(openable ? { configFileID: "responsible-config" } : {}) }
    await page.evaluate(() => { (window as any).electronAPI.openPreferences = (section: string) => { (window as any).openedSection = section } })
    await page.route("**/missions/scheduled/capabilities*", route => route.fulfill({ json: { location: { directory: "fixture" },
      api: { available: true }, enabled: true, origin: path ?? null, activation: { available: false, targets: [],
        reason: "explicit-off", code: "schedule-activation-refused", refusal } } }))
    await click(page, "Play")
    const repair = button(page, "Open scheduling settings")
    await page.locator(".mission-picker-selection-actions [role=status]").filter({ hasText: "Scheduling is disabled" }).waitFor()
    assert.equal(await repair.count(), openable ? 1 : 0)
    assert.equal(f.posts.length, 0); assert.equal(f.activations.length, 0)
    const info = page.locator(".mission-action-feedback .settings-info-tip")
    await info.focus()
    await page.getByRole("tooltip").filter({ hasText: layer === "environment" ? "service environment" : path! }).waitFor()
    assert.doesNotMatch(await page.locator(".mission-picker-selection-actions").innerText(), /experimental\.schedules|\/private\/responsible/)
    if (openable) {
      await repair.click()
      await page.waitForFunction(() => (window as any).openedSection === "config-files")
      const hint = await page.evaluate(() => JSON.parse(localStorage.getItem("codenomad.settings.rowTarget")!))
      assert.equal(hint.row, "config-file:responsible-config")
    }
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

for (const action of ["Resume", "Run now"] as const)
test(`${action} loads only its requested button and keeps Run now confirmation separate`, async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true })
  const gate = deferred(), submitted = deferred()
  try {
    await f.change(doc => {
      doc.firstPlayedAt = Date.now(); doc.state = "paused"
      doc.scheduleActivation = { requestID: "ready_activation", expectedRevision: 0, authority: "a".repeat(64), state: "ready", targets: [], effectiveOrigin: null }
    })
    await page.evaluate(() => (window as any).missionFixture.refresh()); await select(page)
    await page.route("**/msn_schedule/schedule", async route => {
      if (route.request().method() === "POST") { submitted.resolve(); await gate.promise }
      return route.fallback()
    })
    await button(page, action).click()
    if (action === "Run now") {
      const dialog = page.getByRole("dialog")
      await dialog.waitFor()
      assert.equal(await page.locator('.mission-action-bar button[aria-label="Run now"]').getAttribute("aria-busy"), null)
      await dialog.getByRole("button", { name: action, exact: true }).click()
    }
    await submitted.promise
    assert.equal(await button(page, action).getAttribute("aria-busy"), "true")
    assert.equal(await page.locator(".mission-action-bar [aria-busy=true]").count(), 1)
    assert.equal(await page.locator(".mission-picker-selection-actions [role=status]").textContent(), action === "Resume" ? "Resuming…" : "Starting run…")
    gate.resolve()
    await page.waitForFunction(() => !document.querySelector(".mission-action-bar [aria-busy=true]"))
    assert.equal(f.posts.length, 1); assert.equal(f.activations.length, 0)
    assert.deepEqual(f.errors, [])
  } finally { gate.resolve(); await page.close() }
})

test("a server activation conflict stops the spinner and releases the undispatched Play for review", async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true })
  try {
    await select(page)
    await page.route("**/schedule-settings", route => route.fulfill({ status: 409, json: { code: "schedule-activation-conflict" } }))
    await click(page, "Play")
    await page.locator(".mission-picker-selection-actions [role=status]").filter({ hasText: "The Mission changed" }).waitFor()
    assert.equal(await button(page, "Start").getAttribute("aria-busy"), null)
    assert.equal(await button(page, "Refresh saved request").count(), 0)
    assert.equal(f.posts.length, 0); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

for (const leave of ["selection", "remount", "connection"] as const)
test(`late activation after ${leave} preserves its proof but never continues the old Play`, async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true })
  const gate = deferred(), submitted = deferred(), responded = deferred()
  try {
    await f.addSchedule("msn_other", { title: "Other schedule" })
    await page.evaluate(() => (window as any).missionFixture.refresh())
    await select(page)
    await page.route("**/schedule-settings", async route => {
      if (route.request().method() === "POST") { submitted.resolve(); await gate.promise; await route.fallback(); responded.resolve(); return }
      return route.fallback()
    })
    await click(page, "Play"); await submitted.promise
    if (leave === "selection") await page.locator(".mission-row-select").filter({ hasText: "Other schedule" }).click()
    if (leave === "remount") {
      await page.evaluate(() => (window as any).missionFixture.mount(false))
      await page.evaluate(() => (window as any).missionFixture.mount(true))
    }
    if (leave === "connection") await page.evaluate(async () => {
      const path = "/src/stores/instances.ts"
      const module = await import(path), old = module.instances().get("fixture")
      module.updateInstance("fixture", { client: Object.create(old.client) })
    })
    gate.resolve(); await responded.promise
    await page.waitForFunction(() => !document.querySelector(".mission-action-bar [aria-busy=true]"))
    assert.equal(f.activations.length, 1)
    assert.equal(f.posts.filter(post => post.action === "play").length, 0)
    assert.deepEqual(f.errors, [])
  } finally { gate.resolve(); await page.close() }
})

test("structured server OFF after dispatch retains its exact activation and a failed read never starts Play", async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true })
  let request: any
  try {
    await select(page)
    await page.route("**/schedule-settings", async route => {
      if (route.request().method() === "GET") return route.fallback()
      request = route.request().postDataJSON()
      await f.change(doc => { doc.scheduleActivation = { requestID: request.requestID, expectedRevision: request.expectedDocumentRevision,
        authority: "a".repeat(64), state: "failed", targets: [], effectiveOrigin: null, errorCode: "configuration-conflict" } })
      return route.fulfill({ status: 409, json: { code: "schedule-activation-refused",
        refusal: { reason: "explicit-off", provenance: "environment", layer: "environment", openable: false } } })
    })
    await click(page, "Play")
    await button(page, "Refresh saved request").waitFor()
    assert.equal(await button(page, "Start").getAttribute("aria-busy"), null)
    assert.equal(await button(page, "Open scheduling settings").count(), 0)
    assert.equal(f.posts.length, 0)
    await button(page, "Refresh saved request").click()
    await button(page, "Refresh saved request").and(page.locator(":enabled")).waitFor()
    assert.ok(f.reads.some(url => url.includes(`requestID=${request.requestID}`)))
    assert.equal(await button(page, "Start").isDisabled(), true)
    assert.equal(f.posts.length, 0, "failed recovery never replays activation or Play")
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

for (const scenario of ["control ACK", "recovered control", "activation ACK", "recovered activation"] as const)
test(`confirmed publication barrier retains ${scenario} across stale inventory and remount`, async () => {
  const page = await browser.newPage(), activation = scenario.includes("activation")
  const f = await setup(page, { seed: true, enabled: !activation })
  const old = deferred(), fresh = deferred(), started = deferred(), following = deferred()
  let inventories = 0
  try {
    await select(page)
    const stale = structuredClone(f.result().document)
    await page.route("**/missions/scheduled?*", async route => {
      const first = ++inventories === 1
      if (first) { started.resolve(); await old.promise }
      else { following.resolve(); await fresh.promise }
      await route.fulfill({ json: { version: 1, projectID: "project", schedules: [first ? stale : f.result().document] } })
    })
    await page.evaluate(() => (window as any).missionFixture.refresh()); await started.promise
    if (scenario.startsWith("recovered")) f.lost = activation ? "activation" : "play"
    await click(page, "Play")
    if (scenario.startsWith("recovered")) {
      await page.locator(".mission-picker-selection-actions").getByRole("status").filter({ hasText: "This request is unconfirmed" }).waitFor()
      await button(page, "Refresh saved request").click()
      await page.locator(".mission-picker-selection-actions").getByRole("status").filter({ hasText: "This request is unconfirmed" }).waitFor({ state: "detached" })
      assert.equal(await button(page, "Start").isDisabled(), true, "a recovered effect cannot admit a new Start before its revision is published")
    }
    await page.locator(".mission-picker-selection-actions").getByRole("status").filter({ hasText: "Action confirmed" }).waitFor()
    const count = f.posts.length, confirmedRevision = f.doc.revision
    assert.ok(confirmedRevision > stale!.revision!, JSON.stringify({ confirmedRevision, staleRevision: stale!.revision, posts: f.posts }))
    assert.equal(await button(page, "Start").isDisabled(), true)
    assert.equal((await missionMenuItemState(page, "edit")).enabled, false)
    assert.doesNotMatch(await page.locator(".mission-picker-selection-actions").innerText(), /This request is unconfirmed/)
    old.resolve(); await following.promise
    assert.equal(await button(page, "Start").isDisabled(), true, "an older in-flight publication cannot clear the confirmed minimum")
    await button(page, "Start").evaluate(element => element.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    assert.equal(await page.locator("form.mission-editor").count(), 0)
    assert.equal(f.posts.length, count)
    await page.evaluate(() => (window as any).missionFixture.mount(false))
    await page.evaluate(() => (window as any).missionFixture.mount(true))
    await expandRow(page.locator(".mission-rows button.mission-row-select[aria-current=true]"))
    await page.locator(".mission-picker-selection-actions").getByRole("status").filter({ hasText: "Action confirmed" }).waitFor()
    assert.equal(await button(page, "Start").isDisabled(), true)
    assert.equal(f.posts.length, count, "remount retains the obligation and never resubmits")
    fresh.resolve()
    await button(page, "Refresh saved request").waitFor({ state: "detached" })
    if (scenario === "recovered activation") {
      assert.equal(f.posts.length, 1, "recovered activation keeps Play explicit")
      f.lost = undefined
      await click(page, "Play")
      await button(page, "Pause").and(page.locator(":enabled")).waitFor()
      assert.equal(f.posts.at(-1)!.expectedRevision, confirmedRevision)
    } else await button(page, "Pause").and(page.locator(":enabled")).waitFor()
    assert.deepEqual(f.posts.map(item => item.action), activation ? [undefined, "play"] : ["play"])
    assert.equal(f.posts.filter(item => item.action === "play").length, 1)
    assert.deepEqual(f.errors, [])
  } finally { old.resolve(); fresh.resolve(); await page.close() }
})

test("missing calendar capability keeps Play grey and explains the limit", async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true, available: false })
  try {
    await select(page)
    await page.locator(".mission-picker-selection-actions").getByRole("status").filter({ hasText: "Scheduling is unavailable" }).waitFor()
    assert.equal(await button(page, "Start").isDisabled(), true)
    assert.equal(f.posts.length, 0); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("a confirmed activation stays known through read failure and stale recovery until explicit fresh publication", async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true, enabled: false })
  try {
    await select(page)
    const stale = structuredClone(f.result().document)
    f.lost = "activation"
    await click(page, "Play")
    await page.locator(".mission-picker-selection-actions").getByRole("status").filter({ hasText: "This request is unconfirmed" }).waitFor()
    let mode: "failed" | "stale" | "current" = "failed"
    await page.route("**/missions/scheduled?*", route => route.fulfill(mode === "failed" ? { status: 503, json: {} }
      : { json: { version: 1, projectID: "project", schedules: [mode === "stale" ? stale : f.result().document] } }))
    await button(page, "Refresh saved request").click()
    await page.getByRole("status").filter({ hasText: "Mission schedules could not be refreshed" }).waitFor()
    await page.locator(".mission-picker-selection-actions").getByRole("status").filter({ hasText: "Action confirmed" }).waitFor()
    assert.doesNotMatch(await page.locator(".mission-picker-selection-actions").innerText(), /This request is unconfirmed/)
    assert.equal(await button(page, "Start").isDisabled(), true)
    const receiptReads = f.reads.filter(url => url.includes("/schedule-settings")).length
    mode = "stale"
    const oldResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/scheduled") && response.status() === 200)
    await button(page, "Refresh saved request").click(); await oldResponse
    await page.evaluate(() => (window as any).missionFixture.mount(false))
    await page.evaluate(() => (window as any).missionFixture.mount(true))
    await expandRow(page.locator(".mission-rows button.mission-row-select[aria-current=true]"))
    await page.locator(".mission-picker-selection-actions").getByRole("status").filter({ hasText: "Action confirmed" }).waitFor()
    assert.equal(await button(page, "Start").isDisabled(), true)
    assert.equal(f.posts.length, 1)
    mode = "current"
    await button(page, "Refresh saved request").click()
    await button(page, "Refresh saved request").waitFor({ state: "detached" })
    assert.equal(f.reads.filter(url => url.includes("/schedule-settings")).length, receiptReads, "known effects recover with display reads only")
    f.lost = undefined
    await click(page, "Play"); await button(page, "Pause").and(page.locator(":enabled")).waitFor()
    assert.deepEqual(f.posts.map(item => item.action), [undefined, "play"])
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("inactive but activatable scheduling disables Run now with a reason and refuses a synthetic click without activation or reservation", async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true, enabled: false })
  try {
    await f.change(doc => { doc.firstPlayedAt = Date.now(); doc.state = "paused" })
    await page.evaluate(() => (window as any).missionFixture.refresh()); await select(page)
    await page.locator(".mission-picker-selection-actions").getByRole("status").filter({ hasText: /Run now requires native scheduling/ }).waitFor()
    assert.equal(await button(page, "Run now").isDisabled(), true)
    await button(page, "Run now").evaluate(element => element.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.equal(f.posts.length, 0); assert.equal(f.doc.pending, null); assert.equal(f.doc.launchedCount, 0)
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("Run now rechecks a capability lost after display and sends neither activation nor reservation", async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true })
  try {
    await select(page)
    await click(page, "Play"); await button(page, "Pause").waitFor()
    const before = f.posts.length
    f.enabled = false
    await click(page, "Run now", true)
    await page.locator(".mission-picker-selection-actions").getByRole("status").filter({ hasText: /Run now requires native scheduling/ }).first().waitFor()
    assert.equal(f.posts.length, before); assert.equal(f.doc.pending, null); assert.equal(f.doc.launchedCount, 0)
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("event-only details distinguish checks from launches and explain an unknown admission barrier", async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true })
  try {
    await f.change(doc => {
      changes.configure(doc, { ...doc.configuration, launch: { when: [{ kind: "files-changed", paths: ["src/main.ts", "package.json"] }] } }, Date.now())
      doc.blocked = "unknown"
    })
    await page.evaluate(() => (window as any).missionFixture.refresh()); await select(page)
    await detail(page).getByText("Next check", { exact: true }).waitFor()
    assert.match(await detail(page).innerText(), /Explicit files change · package.json, src\/main.ts/)
    assert.match(await detail(page).innerText(), /A control or admission is unconfirmed/)
    assert.equal(await button(page, "Start").isDisabled(), true)
    assert.doesNotMatch(await detail(page).innerText(), /0 \/ /, "criteria have no passage limit")
    assert.equal(await detail(page).locator("dt").count(), 7, "event criteria retain their verification history")
    assert.equal(await detail(page).locator(".mission-schedule-notice").count(), 0)
    await detail(page).locator(".mission-schedule-facts .settings-info-tip").first().focus()
    await page.getByRole("tooltip").filter({ hasText: /arrive late/i }).waitFor()
    assert.equal(f.posts.length, 0); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("technical diagnostics expose carrier roles and pending cleanup read-only, folded and keyboard accessible", async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true })
  try {
    await f.change(doc => {
      doc.firstPlayedAt = Date.now(); doc.state = "stopped"; doc.calendars = technicalCalendars()
      doc.deletion = { requestID: "delete_cleanup", expectedRevision: doc.revision, requestedAt: Date.now(), deleteManagedSessions: false }
    })
    await page.evaluate(() => (window as any).missionFixture.refresh()); await select(page)
    const diagnostics = detail(page).locator(".mission-schedule-diagnostics"), toggle = diagnostics.getByRole("button")
    assert.equal(await toggle.getAttribute("aria-expanded"), "false")
    await toggle.focus(); await page.keyboard.press("Enter")
    assert.equal(await toggle.getAttribute("aria-expanded"), "true")
    assert.match(await diagnostics.innerText(), /Principal carrier 1[\s\S]*Reconciliation carrier/)
    assert.match(await diagnostics.innerText(), /Cleanup awaiting reconciliation/)
    assert.doesNotMatch(await diagnostics.innerText(), /without provider HTTP requests|30 retained Mission results/)
    const help = diagnostics.locator(".settings-info-tip")
    assert.equal(await toggle.locator(".settings-info-tip").count(), 0, "help is an independent disclosure action")
    await page.keyboard.press("Tab")
    assert.equal(await help.evaluate(element => element === document.activeElement), true)
    await page.getByRole("tooltip").filter({ hasText: /without provider HTTP requests[\s\S]*30 retained Mission results/ }).waitFor()
    assert.equal(await toggle.getAttribute("aria-expanded"), "true", "help focus preserves the disclosure")
    assert.equal(await diagnostics.getByRole("button").count(), 1, "no composer or native-session mutation action")
    assert.equal(await diagnostics.locator("code").count(), 4)
    assert.equal(f.posts.length, 0); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

for (const alreadyReading of [false, true]) test(`a passive list refresh between pointer-down and pointer-up preserves the exact Start click (${alreadyReading ? "read already in flight" : "fresh read"})`, { timeout: 60_000 }, async () => {
  let releaseJournal!: () => void
  const journalGate = new Promise<void>(resolve => { releaseJournal = resolve })
  const page = await browser.newPage(), f = await setup(page, { seed: true, journalGate })
  const requests: string[] = []
  page.on("request", request => { if (request.url().includes("/api/")) requests.push(request.url()) })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    // The schedule and journal inventories load independently. A native click on
    // the global Refresh button is admitted only after its journal read finishes.
    await page.waitForFunction(() => (window as any).missionFixture.snapshot().status === "loading")
    assert.equal(await page.getByRole("button", { name: "Refresh mission map", exact: true }).isDisabled(), true)
    releaseJournal()
    await page.getByRole("button", { name: "Refresh mission map", exact: true }).and(page.locator(":enabled")).waitFor()
    await select(page)
    await page.getByRole("button", { name: "Refresh mission map", exact: true }).and(page.locator(":enabled")).waitFor()
    await button(page, "Start").click({ trial: true })
    // Observe at interception: a passive invalidation may start either read
    // before the pointer or the Refresh click, and that click coalesces with it.
    let listStarted!: () => void, capabilityStarted!: () => void
    const started = new Promise<void>(resolve => { listStarted = resolve })
    const capability = new Promise<void>(resolve => { capabilityStarted = resolve })
    await page.route("**/missions/scheduled?*", async route => {
      listStarted()
      await gate
      await route.fulfill({ json: { version: 1, projectID: "project", schedules: [f.result().document] } })
    })
    await page.route("**/missions/scheduled/capabilities*", async route => {
      capabilityStarted()
      await gate
      await route.fulfill({ json: { location: { directory: "fixture" }, api: { available: true }, enabled: true,
        origin: null, activation: { available: true, targets: [] } } })
    })
    if (alreadyReading) {
      await page.evaluate(() => (window as any).missionFixture.refresh())
      await started
    }
    const box = (await button(page, "Start").boundingBox())!
    const heldButton = await button(page, "Start").elementHandle()
    const heldIcon = await button(page, "Start").locator("svg").elementHandle()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down()
    await page.getByRole("button", { name: "Refresh mission map", exact: true }).evaluate(element => (element as HTMLButtonElement).click())
    await Promise.all([started, capability]).catch(async error => { throw new Error(`${error}\n${JSON.stringify({ requests: requests.slice(-20),
      state: await page.evaluate(() => ({ status: (window as any).missionFixture.snapshot().status,
        refreshDisabled: (document.querySelector('[aria-label="Refresh mission map"]') as HTMLButtonElement)?.disabled })) })}`) })
    assert.equal(await button(page, "Start").isDisabled(), false, "display revalidation keeps controls stable; admission reads authority")
    assert.equal(await button(page, "Start").evaluate((element, held) => element === held, heldButton), true, "display revalidation preserves the pointer target")
    assert.equal(await button(page, "Start").locator("svg").evaluate((element, held) => element === held, heldIcon), true, "same-kind primary glyph retains its pointer target")
    assert.deepEqual(await button(page, "Start").boundingBox(), box, "display revalidation preserves pointer geometry")
    await page.mouse.up(); release()
    await button(page, "Pause").waitFor()
    assert.deepEqual(f.posts.map(item => item.action), ["play"])
    assert.deepEqual(f.errors, [])
  } finally { releaseJournal(); release(); await page.close() }
})

test("document inventory pages only on demand and revalidates the loaded frontier without changing selection or focus", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 240 } }), f = await setup(page, { seed: true }), calls: URL[] = []
  try {
    await select(page)
    const documents: MissionDocument[] = [f.doc]
    for (let i = 1; i < 9; i++) documents.push(await f.store.create(`msn_schedule_${i}`, { ...f.doc.configuration, title: `Extra Mission ${i}` }, Date.now(), () => true))
    documents.sort((a, b) => a.id.localeCompare(b.id, "en"))
    await page.route("**/missions/scheduled?*", route => {
      const query = new URL(route.request().url()); calls.push(query)
      const after = query.searchParams.get("after"), start = after ? documents.findIndex(doc => doc.id === after) + 1 : 0
      const slice = documents.slice(start, start + 8), next = start + 8 < documents.length ? slice.at(-1)!.id : undefined
      return route.fulfill({ json: { version: 1, projectID: "project", schedules: slice.map(doc => missionScheduleView(doc).document), ...(next ? { next } : {}) } })
    })
    await page.evaluate(() => (window as any).missionFixture.refresh())
    await page.locator(".mission-list-paging").waitFor()
    assert.ok(calls.length > 0); assert.ok(calls.every(call => call.searchParams.get("after") === null), "display hints may revalidate the first page, never speculate another page")
    await page.locator(".mission-control").hover(); await page.mouse.wheel(0, 10000)
    await page.locator(".mission-list-paging").waitFor({ state: "detached" })
    assert.equal(calls.filter(call => call.searchParams.get("after") === documents[7].id).length, 1)
    await button(page, "Start").focus()
    const refreshed = page.waitForResponse(response => new URL(response.url()).searchParams.has("after"))
    await page.evaluate(() => (window as any).missionFixture.refresh())
    await refreshed
    assert.equal(await button(page, "Start").evaluate(element => element === document.activeElement), true)
    assert.equal(await detail(page).getAttribute("aria-label"), "Inspect local changes")
    assert.equal(calls.filter(call => call.searchParams.get("after") === documents[7].id).length, 2)
    assert.ok(calls.every(call => !call.searchParams.has("after") || call.searchParams.get("after") === documents[7].id))
    assert.equal(f.posts.length, 0); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("a positively recorded partial request offers no Check passage; its exact receipt alone settles it", async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true })
  try {
    await select(page); f.partial = "play"; await click(page, "Play")
    await button(page, "Refresh saved request").and(page.locator(":enabled")).waitFor()
    const original = f.posts[0]
    assert.equal(await button(page, "Check passage").count(), 0)
    f.resolve()
    await button(page, "Refresh saved request").click()
    await button(page, "Refresh saved request").waitFor({ state: "detached" })
    assert.deepEqual(f.posts, [original], "settled by its exact receipt, never by another control")
    assert.ok(f.reads.some(value => value.includes(`requestID=${original.requestID}`)))
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

for (const negativeFirst of [true, false]) test(`cold reopen keeps the first page, cursor and original held request when selected detail is partial 503 (${negativeFirst ? "negative then positive" : "FIRST positive receipt"})`, async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 240 } }), f = await setup(page, { seed: true, outsidePage: true })
  let originalRevision = f.doc.revision
  let release!: () => void
  const continuation = new Promise<void>(resolve => { release = resolve })
  try {
    await select(page); f.partial = "play"; await click(page, "Play")
    await button(page, "Refresh saved request").and(page.locator(":enabled")).waitFor()
    const original = f.posts[0]
    originalRevision = f.doc.scheduleActivation!.expectedRevision + 1
    await page.evaluate(() => (window as any).missionFixture.mount(false))
    f.outside = true
    // Keep the selected object outside the freshly read inventory while asserting
    // the partial point-read state. End-of-list continuation is now automatic.
    await page.route("**/missions/scheduled?*", async route => {
      if (new URL(route.request().url()).searchParams.has("after")) await continuation
      return route.fallback()
    })
    const pointRead = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/msn_schedule/schedule")
      && !new URL(response.url()).searchParams.has("requestID") && response.status() === 503)
    await page.evaluate(() => (window as any).missionFixture.mount(true))
    await pointRead
    await page.locator(".mission-list-paging").waitFor()
    // The remounted panel restores the selection; its chevron shows the detail again.
    await expandRow(page.locator(".mission-rows button.mission-row-select[aria-current=true]"))
    await button(page, "Refresh saved request").waitFor()
    assert.equal(await page.locator(".mission-rows button.mission-row-select").filter({ hasText: "Inventory Mission" }).count(), 8)
    // Inventory paging belongs to the list, not to the selection: folding keeps it.
    const selectedChevron = page.locator(".mission-row:has(.mission-row-select[aria-current=true]) .session-item-expander")
    await selectedChevron.click()
    assert.equal(await page.locator(".mission-list-paging").isVisible(), true, "folding the selection keeps directory continuation")
    await selectedChevron.click()
    assert.equal(await button(page, "Check passage").count(), 0, "retained partial metadata grants no new control")
    assert.equal(await button(page, "Stop…").isDisabled(), true)
    if (negativeFirst) {
      await button(page, "Refresh saved request").click()
      assert.ok(f.reads.some(url => url.includes(`requestID=${original.requestID}`)))
      assert.deepEqual(f.posts, [original], "reopen and explicit reconciliation never replay the control")
    }
    const before = f.reads.length
    f.resolve()
    await button(page, "Refresh saved request").click()
    release()
    await button(page, "Refresh saved request").waitFor({ state: "detached" })
    await button(page, "Pause").and(page.locator(":enabled")).waitFor()
    const confirmedReads = f.reads.slice(before).map(value => new URL(value))
    assert.equal(confirmedReads.filter(value => value.searchParams.get("requestID") === original.requestID).length, 1)
    assert.ok(confirmedReads.some(value => value.pathname.endsWith("/msn_schedule/schedule") && !value.searchParams.has("requestID")
      || value.pathname.endsWith("/scheduled") && value.searchParams.get("after") === "aaa_7"),
      "controls are restored by a fresh point or inventory document read, never by retained partial display or receipt metadata")
    assert.equal(original.expectedRevision, originalRevision); assert.equal(typeof original.requestID, "string")
    assert.equal(await page.locator(".mission-list-paging").count(), 0, "the automatic continuation disappears once the remaining page is read")
    assert.deepEqual(f.posts, [original]); assert.deepEqual(f.errors, [])
  } finally { release(); await page.close() }
})

for (const [minutes, duration] of [[1, "1 minute"], [2, "2 minutes"]] as const) {
  test(`French delay summary uses running-text units (${minutes})`, async () => {
    const page = await browser.newPage(), f = await setup(page, { seed: true, locale: "fr" })
    try {
      await f.change(doc => { legacyLaunch(doc.configuration).timing = { kind: "in", delayMs: minutes * 60_000 } })
      await page.evaluate(() => (window as any).missionFixture.refresh()); await select(page)
      await detail(page).locator("dd").first().getByText(`Une fois, dans un délai · ${duration}`, { exact: true }).waitFor()
      assert.deepEqual(f.errors, [])
    } finally { await page.close() }
  })
}

for (const locale of ["en", "fr", "de", "es", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) {
  test(`native schedule details stay translated and bounded at 390px (${locale})`, async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 1000 } }), f = await setup(page, { seed: true, locale })
    try {
      await f.change(doc => { doc.firstPlayedAt = Date.now(); doc.calendars = technicalCalendars() })
      await page.evaluate(() => (window as any).missionFixture.refresh())
      await page.evaluate(() => (window as any).missionFixture.panelWidth("100vw"))
      await select(page)
      await page.waitForFunction(locale => document.documentElement.lang === locale, locale)
      const duration = new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "long" }).format(15)
      const summary = await detail(page).locator("dd").first().innerText()
      if (locale === "ne") assert.match(summary, / · (?:15|१५) मिनेट$/)
      else assert.ok(summary.endsWith(` · ${duration}`), JSON.stringify({ summary, duration }))
      if (locale === "fr") assert.equal(await detail(page).locator("dd").first().innerText(), "À intervalles réguliers · 15 minutes")
      const diagnostics = detail(page).locator(".mission-schedule-diagnostics")
      await diagnostics.getByRole("button").focus(); await page.keyboard.press("Enter")
      assert.equal(await diagnostics.getByRole("button").getAttribute("aria-expanded"), "true")
      assert.equal(await diagnostics.locator("code").count(), 4)
      assert.equal(await detail(page).locator("dt").count(), 6, "unconditional schedules omit condition, absent end and source-check count")
      assert.equal((await detail(page).innerText()).includes("missions."), false)
      const width = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
      assert.ok(width.scroll <= width.width, JSON.stringify(width))
      await capture(page, `schedule-${locale}-narrow.png`)
      assert.deepEqual(f.errors, [])
    } finally { await page.close() }
  })
}

test("the schedule list summarizes each launch criterion and its role; a stored legacy end date stays shown", async () => {
  const page = await browser.newPage({ viewport: { width: 760, height: 900 }, timezoneId: "Europe/Paris" }), f = await setup(page, { seed: true })
  try {
    const daily = { kind: "cron" as const, expression: "0 9 * * *", zone: "Europe/Paris" }
    await f.change(doc => changes.configure(doc, { ...doc.configuration, title: "Daily review",
      launch: { when: [daily] } }, Date.now()))
    // A schedule written before launch criteria keeps its condition and end date until it is edited.
    await f.addSchedule("msn_commits", { title: "Review new commits", launch: { timing: { ...daily, expression: "0 9 * * 1,2,3,4,5" },
      condition: { kind: "branch-commits", directory: "fixture", ref: "refs/heads/main" }, ends: { maxLaunches: null, afterMs: null, at: Date.parse("2026-12-31T17:00:00Z") } } })
    await f.addSchedule("msn_files", { title: "Follow package changes", launch: { when: [{ kind: "files-changed", paths: ["package.json"] }] } })
    await page.evaluate(() => (window as any).missionFixture.refresh())
    const option = (title: string) => page.locator(".mission-rows button.mission-row-select").filter({ hasText: title })
    assert.match(await option("Daily review").innerText(), /Every day · 09:00 · Europe\/Paris/)
    assert.match(await option("Review new commits").innerText(), /Selected weekdays · .* · 09:00 · Europe\/Paris; if · New commits on a local branch · main/)
    assert.match(await option("Follow package changes").innerText(), /Explicit files change · package\.json/)
    await capture(page, "schedule-list-criteria-en.png")
    await option("Review new commits").click()
    await expandRow(option("Review new commits"))
    await detail(page).waitFor()
    assert.match(await detail(page).innerText(), /Until\s+Dec 31, 2026, 6:00 PM/)
    await capture(page, "schedule-detail-criteria-en.png")
    assert.equal(f.posts.length, 0); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})
