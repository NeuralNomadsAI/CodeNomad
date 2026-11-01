import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdir } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { NativeMissionDocumentStore } from "../../../server/src/missions/mission-document-store"
import { missionDocumentChanges as changes } from "../../../server/src/missions/mission-document-state"
import { missionScheduleView } from "../../../server/src/missions/mission-schedule-view"
import { missionDocumentSummary } from "../../../server/src/missions/mission-document-one-time"
import type { MissionDocument } from "../../../server/src/missions/mission-document"
import type { MissionJsonValue } from "../../../server/src/missions/model"

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
  const values = new Map<string, MissionJsonValue>(), posts: Record<string, any>[] = [], reads: string[] = [], errors: string[] = []
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
        kind: doc.configuration.launch.condition ? "check" : "launch", timeGeneration: doc.timeGeneration },
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
        schedules: outside && !link.searchParams.has("after") ? firstPage.map(doc => missionScheduleView(doc).document) : doc && !deleted ? [result().document] : [],
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
    const body = request.postDataJSON(); posts.push({ ...body, target })
    if (target.endsWith("/schedule-settings")) {
      activation = body
      doc = await store.change(doc!.id, doc!.revision, () => true, value => { value.scheduleActivation = { requestID: body.requestID,
        expectedRevision: body.expectedDocumentRevision, authority: "a".repeat(64), state: "ready", targets: [], effectiveOrigin: "/private/config/opencode.jsonc" } })
      enabled = true
      if (lost === "activation") return route.abort("connectionreset")
      return route.fulfill({ json: { document: missionDocumentSummary(doc) } })
    }
    if (body.action === "create") doc = await store.create("msn_schedule", { ...config, ...body.configuration }, Date.now(), () => true)
    else if (body.action === "delete") deleted = true
    else doc = await store.change(doc!.id, doc!.revision, () => true, value => {
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
    if (body.action === "check") for (const receipt of receipts.values()) receipt.pending = false
    receipts.set(body.requestID, { ...body, pending: partial === body.action })
    if (lost === body.action) return route.abort("connectionreset")
    const value = result(body.requestID)
    return route.fulfill({ status: value.pending ? 503 : 200, json: { ...value, ...(value.pending ? { code: "schedule-pending" } : {}) } })
  })
  const stream = page.waitForResponse(response => response.headers()["content-type"] === "text/event-stream")
  await page.goto(url)
  await stream.catch(error => { throw new Error(`${error}\n${errors.join("\n")}`) })
  await page.waitForFunction(() => (window as any).missionFixture).catch(error => { throw new Error(`${error}\n${errors.join("\n")}`) })
  await page.evaluate(() => (window as any).missionFixture.connectCatalog())
  return { posts, reads, errors, store, get doc() { return doc! }, result,
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
const button = (page: Page, name: string) => detail(page).getByRole("button", { name, exact: true })
async function select(page: Page) {
  await page.getByRole("combobox").click()
  await page.getByRole("option").filter({ hasText: "Inspect local changes" }).click()
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

test("real panel Create → Play → Pause/Resume → Run now → Stop → Delete preserves quota and native control routes", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } }), f = await setup(page)
  try {
    await page.getByRole("button", { name: "Create mission", exact: true }).click()
    const form = page.locator("form.mission-editor")
    await form.getByLabel("What should the mission do?", { exact: true }).fill("Inspect local changes")
    await form.locator(".mission-scheduling > summary").click()
    await form.getByLabel("Frequency", { exact: true }).selectOption("every")
    await form.getByLabel("Maximum launched passages", { exact: true }).fill("3")
    await form.getByRole("button", { name: "Create", exact: true }).click()
    await form.waitFor({ state: "detached" })
    assert.deepEqual(f.posts.map(post => post.action), ["create"])
    await select(page); await capture(page, "schedule-paused-en.png")
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
    await page.waitForFunction(() => (document.querySelector('.mission-unified-schedule [aria-label="Start"]') as HTMLButtonElement)?.disabled)
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
    await detail(page).getByRole("status").filter({ hasText: "This request is unconfirmed" }).waitFor().catch(async error => { throw new Error(`${error}\n${JSON.stringify(f.posts)}\n${await detail(page).innerText()}\n${f.errors.join("\n")}`) })
    const count = f.posts.length, original = f.posts.at(-1)!
    await page.evaluate(() => (window as any).missionFixture.mount(false))
    await page.evaluate(() => (window as any).missionFixture.mount(true))
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
    await detail(page).getByRole("status").filter({ hasText: "The Mission changed" }).waitFor()
    assert.equal(f.posts.length, 0); assert.equal(f.doc.configuration.notes, "Concurrent change")
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("informed activation lists exact paths and its lost ACK never sends Play automatically", async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true, enabled: false })
  try {
    await select(page); f.lost = "activation"; await click(page, "Play")
    const dialog = page.getByRole("dialog")
    assert.match(await dialog.innerText(), /experimental.schedules.*\/private\/config\/opencode.jsonc/s)
    await dialog.getByRole("button", { name: "Start", exact: true }).click()
    await button(page, "Refresh saved request").waitFor()
    await button(page, "Refresh saved request").click()
    await button(page, "Refresh saved request").waitFor({ state: "detached" })
    assert.equal(f.posts.length, 1); assert.equal(f.posts[0].target.endsWith("/schedule-settings"), true)
    f.lost = undefined; await click(page, "Play"); await button(page, "Pause").waitFor()
    assert.deepEqual(f.posts.map(post => post.action), [undefined, "play"])
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("missing calendar capability keeps Play grey and explains the limit", async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true, available: false })
  try {
    await select(page)
    await detail(page).getByRole("status").filter({ hasText: "Scheduling is unavailable" }).waitFor()
    assert.equal(await button(page, "Start").isDisabled(), true)
    assert.equal(f.posts.length, 0); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("inactive but activatable scheduling disables Run now with a reason and refuses a synthetic click without activation or reservation", async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true, enabled: false })
  try {
    await f.change(doc => { doc.firstPlayedAt = Date.now(); doc.state = "paused" })
    await page.evaluate(() => (window as any).missionFixture.refresh()); await select(page)
    await detail(page).getByRole("status").filter({ hasText: /Run now requires native scheduling/ }).waitFor()
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
    await detail(page).getByRole("status").filter({ hasText: /Run now requires native scheduling/ }).first().waitFor()
    assert.equal(f.posts.length, before); assert.equal(f.doc.pending, null); assert.equal(f.doc.launchedCount, 0)
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("event-only details distinguish checks from launches and explain an unknown admission barrier", async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true })
  try {
    await f.change(doc => {
      changes.configure(doc, { ...doc.configuration, launch: { timing: { kind: "immediate" },
        condition: { kind: "files-changed", paths: ["src/main.ts", "package.json"] }, ends: doc.configuration.launch.ends } }, Date.now())
      doc.blocked = "unknown"
    })
    await page.evaluate(() => (window as any).missionFixture.refresh()); await select(page)
    await detail(page).getByText("Next check", { exact: true }).waitFor()
    assert.match(await detail(page).innerText(), /Explicit files change · package.json, src\/main.ts/)
    assert.match(await detail(page).innerText(), /A control or admission is unconfirmed/)
    assert.equal(await button(page, "Start").isDisabled(), true)
    assert.match(await detail(page).innerText(), /0 \/ 1/)
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
    assert.match(await diagnostics.innerText(), /without provider HTTP requests[\s\S]*30 retained Mission results/)
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
  const page = await browser.newPage(), f = await setup(page, { seed: true }), calls: URL[] = []
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
    await page.getByRole("button", { name: "Load more Missions", exact: true }).waitFor()
    assert.ok(calls.length > 0); assert.ok(calls.every(call => call.searchParams.get("after") === null), "display hints may revalidate the first page, never speculate another page")
    await page.getByRole("button", { name: "Load more Missions", exact: true }).click()
    await page.getByRole("button", { name: "Load more Missions", exact: true }).waitFor({ state: "detached" })
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

test("Check reconciles a positively recorded partial request and retains both identities when its own ACK is lost", async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true })
  try {
    await select(page); f.partial = "play"; await click(page, "Play")
    await button(page, "Refresh saved request").waitFor()
    const original = f.posts[0]
    // The server's exact partial receipt, rather than the row alone, enables Check.
    f.lost = "check"
    await click(page, "Check passage")
    await button(page, "Refresh saved request").click()
    await button(page, "Refresh saved request").waitFor({ state: "detached" })
    assert.deepEqual(f.posts.map(item => item.action), ["play", "check"])
    assert.notEqual(f.posts[1].requestID, original.requestID)
    assert.ok(f.reads.some(value => value.includes(`requestID=${f.posts[1].requestID}`)))
    assert.ok(f.reads.some(value => value.includes(`requestID=${original.requestID}`)))
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

test("cold reopen keeps the first page, cursor and original held request when selected detail is partial 503", async () => {
  const page = await browser.newPage(), f = await setup(page, { seed: true, outsidePage: true })
  try {
    await select(page); f.partial = "play"; await click(page, "Play")
    await button(page, "Refresh saved request").waitFor()
    const original = f.posts[0]
    await page.evaluate(() => (window as any).missionFixture.mount(false))
    f.outside = true
    const pointRead = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/msn_schedule/schedule")
      && !new URL(response.url()).searchParams.has("requestID") && response.status() === 503)
    await page.evaluate(() => (window as any).missionFixture.mount(true))
    await pointRead
    await page.getByRole("button", { name: "Load more Missions", exact: true }).and(page.locator(":enabled")).waitFor()
    await button(page, "Refresh saved request").waitFor()
    await page.getByRole("combobox").click()
    assert.equal(await page.getByRole("option").filter({ hasText: "Inventory Mission" }).count(), 8)
    await page.keyboard.press("Escape")
    assert.equal(await button(page, "Check passage").isDisabled(), true, "retained partial metadata grants no new control")
    assert.equal(await button(page, "Stop…").isDisabled(), true)
    await button(page, "Refresh saved request").click()
    assert.ok(f.reads.some(url => url.includes(`requestID=${original.requestID}`)))
    assert.deepEqual(f.posts, [original], "reopen and explicit reconciliation never replay the control")
    f.resolve()
    await button(page, "Refresh saved request").click()
    await button(page, "Refresh saved request").waitFor({ state: "detached" })
    await button(page, "Pause").and(page.locator(":enabled")).waitFor()
    assert.equal(await page.getByRole("button", { name: "Load more Missions", exact: true }).count(), 1)
    assert.deepEqual(f.posts, [original]); assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})

for (const locale of ["en", "fr", "de", "es", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) {
  test(`native schedule details stay translated and bounded at 390px (${locale})`, async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 1000 } }), f = await setup(page, { seed: true, locale })
    try {
      await f.change(doc => { doc.firstPlayedAt = Date.now(); doc.calendars = technicalCalendars() })
      await page.evaluate(() => (window as any).missionFixture.refresh())
      await page.evaluate(() => (window as any).missionFixture.panelWidth("100vw"))
      await select(page)
      await page.waitForFunction(locale => document.documentElement.lang === locale, locale)
      const diagnostics = detail(page).locator(".mission-schedule-diagnostics")
      await diagnostics.getByRole("button").focus(); await page.keyboard.press("Enter")
      assert.equal(await diagnostics.getByRole("button").getAttribute("aria-expanded"), "true")
      assert.equal(await diagnostics.locator("code").count(), 4)
      assert.equal(await detail(page).locator("dt").count(), 9)
      assert.equal((await detail(page).innerText()).includes("missions."), false)
      const width = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
      assert.ok(width.scroll <= width.width, JSON.stringify(width))
      await capture(page, `schedule-${locale}-narrow.png`)
      assert.deepEqual(f.errors, [])
    } finally { await page.close() }
  })
}
