import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import type { MissionRecurrenceSnapshot, MissionRecurrenceReadPage } from "../../../server/src/api-types"
import { missionMarkdownPage } from "../../src/lib/mission-markdown-pages"
import type {} from "./fixtures/mission-passage-history"
import { captureMissionView } from "./mission-view-capture"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "passage-history", configureServer(s) { s.middlewares.use("/passages", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/passages", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-passage-history.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server); await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/passages`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

test("all ten locales define recurrence reference reader and pending status keys", async () => {
  const locales = ["en", "fr", "es", "de", "he", "ja", "zh-Hans", "ru", "tr", "ne"]
  const required = ["read", "reader", "latest", "history", "historyEmpty", "referencesOnly", "passage", "due", "settledAt",
    "missionRef", "conversationRef", "messageRef", "artifactRefs", "pending.unknown", "pending.admitted", "readResult", "section", "resultUnavailable",
    "result.completed", "result.failed", "result.stopped", "result.rejected-before-effect", "retry", "pendingTargets"]
  for (const locale of locales) {
    const source = await readFile(new URL(`../../src/lib/i18n/messages/${locale}/missions.ts`, import.meta.url), "utf8")
    for (const key of required) assert.equal(source.split(`"missions.recurrence.${key}":`).length - 1, 1, `${locale}: ${key}`)
  }
})

const schedule = (id: string): MissionRecurrenceSnapshot["schedules"][number] => {
  const history = Array.from({ length: 30 }, (_, n) => ({ passageID: `rcp_${id}_${n}`, messageID: `msg_passage_${id}_${n}`, dueAt: 1_000 + n * 10,
    settledAt: 1_001 + n * 10, status: "completed" as const, missionID: `msn_${n}`, conversationID: `ses_${n}`,
    artifactMessageIDs: [`msg_artifact_${id}_${n}`] }))
  return { id, revision: 62, scheduleRevision: 0, state: "paused", clock: { time: "07:00", zone: "UTC" },
    pendingPassageID: "rcp_pending", pendingStatus: "unknown", pendingAdmission: null, settledCount: 31, latestResult: history.at(-1)!, history }
}

test("native reference history uses the shared reader, exact eyes, visible cache demand and no mutation/transcript reads", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 390, height: 800 } })
  let snapshot: MissionRecurrenceSnapshot = { version: 1, projectID: "project", schedules: [schedule("rec_first"), { ...schedule("rec_second"), pendingPassageID: null, pendingStatus: null }] }
  let reads = 0, fail = false
  const errors: string[] = [], unexpected: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => {
    if (route.request().method() !== "GET") unexpected.push(route.request().url())
    return route.fulfill({ json: {} })
  })
  await page.route("**/api/workspaces/fixture/missions/recurrence", route => {
    if (route.request().method() !== "GET") unexpected.push(route.request().url())
    reads++
    return fail ? route.fulfill({ status: 503, json: { error: "unavailable" } }) : route.fulfill({ json: snapshot })
  })
  await page.route("**/workspaces/**/instance/api/**", route => { unexpected.push(route.request().url()); return route.fulfill({ json: {} }) })
  try {
    await page.goto(url)
    const firstEye = page.getByRole("button", { name: "Read passage history for rec_first" })
    const secondEye = page.getByRole("button", { name: "Read passage history for rec_second" })
    await firstEye.waitFor()
    assert.equal(await page.getByText("Latest result: Completed (archived)", { exact: true }).count(), 2)
    await firstEye.click()
    const reader = page.locator(".mission-reader")
    await reader.getByText("msg_artifact_rec_first_29", { exact: true }).waitFor()
    assert.equal(await reader.locator("li").count(), 30)
    await reader.getByRole("alert").getByText(/No substitute result was loaded/).waitFor()
    assert.equal(await firstEye.getAttribute("aria-pressed"), "true")
    assert.equal(await secondEye.getAttribute("aria-pressed"), "false")
    assert.equal(await reader.getByText("rcp_rec_first_29", { exact: true }).count(), 1)
    await secondEye.click()
    await reader.getByText("msg_artifact_rec_second_29", { exact: true }).waitFor()
    assert.equal(await firstEye.getAttribute("aria-pressed"), "false")
    assert.equal(await secondEye.getAttribute("aria-pressed"), "true")
    await secondEye.click()
    assert.equal(await reader.count(), 0)
    await firstEye.click()
    await reader.getByRole("button", { name: "Back to chat" }).click()
    assert.equal(await firstEye.getAttribute("aria-pressed"), "false")
    const beforeEye = reads
    await firstEye.click()
    assert.equal(reads, beforeEye, "opening the reader uses the bounded cached snapshot")
    snapshot = { ...snapshot, schedules: [{ ...snapshot.schedules[0], pendingStatus: "admitted",
      pendingAdmission: { missionID: "msn_pending", conversationID: "ses_pending" } }, snapshot.schedules[1]] }
    await page.evaluate(() => window.passageHistory.invalidate())
    await reader.getByText("Passage admitted; terminal result not yet verified.").waitFor()
    assert.equal(await reader.locator("li").count(), 30, "admission does not create another final result")
    assert.equal(await firstEye.getAttribute("aria-pressed"), "true", "refresh preserves exact reader identity")
    await page.evaluate(async () => {
      const { addFormToQueue } = await import("/src/stores/forms.ts")
      for (const [id, sessionID, title] of [["frm_pending", "ses_pending", "Publish review?"],
        ["frm_archived", "ses_29", "Archived request"], ["frm_global", "global", "Global request"]]) {
        addFormToQueue("fixture", { id, sessionID, title, fields: [], location: { directory: "/fixture" } } as never)
      }
    })
    const decision = page.getByRole("button", { name: "Question: Publish review?" })
    await decision.waitFor()
    assert.equal(await page.getByRole("button", { name: /Archived request|Global request/ }).count(), 0)
    await page.evaluate(() => window.passageHistory.status(true))
    assert.equal(await page.locator(".interruption-dock").count(), 0, "Status does not host the dock")
    await decision.click()
    await page.locator(".interruption-dock:not(.is-collapsed)").waitFor()
    await page.locator(".interruption-dock .window-title").getByText("ses_pending", { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(async () => {
      const { interruptionFocus } = await import("/src/stores/interruption-navigation.ts")
      return interruptionFocus()
    }), { instanceId: "fixture", sessionId: "ses_pending", requestId: "frm_pending", kind: "form" })
    await page.evaluate(async () => {
      const { removeFormFromQueue } = await import("/src/stores/forms.ts")
      removeFormFromQueue("fixture", "frm_pending")
    })
    assert.equal(await decision.count(), 0, "settled native request disappears without inferring no decisions")
    fail = true
    await page.evaluate(() => window.passageHistory.refresh())
    await page.locator("aside").getByText(/Showing the last confirmed snapshot/).waitFor()
    assert.equal(await reader.locator("li").count(), 30)
    await page.evaluate(() => { window.passageHistory.readerVisible(false); window.passageHistory.activate(false) })
    const hiddenReads = reads
    await page.evaluate(() => window.passageHistory.invalidate())
    await page.waitForTimeout(120)
    assert.equal(reads, hiddenReads)
    fail = false
    await page.evaluate(() => { window.passageHistory.activate(true); window.passageHistory.readerVisible(true) })
    await page.waitForResponse(response => response.url().endsWith("/missions/recurrence"))
    await page.evaluate(() => { document.documentElement.dir = "rtl" })
    await captureMissionView(page, "archive-reader-390-rtl")
    const geometry = await firstEye.evaluate(node => {
      const row = node.closest("article")!.getBoundingClientRect(), eye = node.getBoundingClientRect()
      return { rowLeft: row.left, rowRight: row.right, eyeLeft: eye.left, eyeRight: eye.right, radius: getComputedStyle(node).borderRadius }
    })
    assert.ok(geometry.eyeLeft >= geometry.rowLeft && geometry.eyeRight <= geometry.rowRight)
    assert.equal(geometry.radius, "0px")
    await page.evaluate(() => window.passageHistory.project("foreign"))
    await reader.getByText("This mission content is no longer available.").waitFor()
    assert.equal(await reader.getByText("msg_artifact_rec_first_29", { exact: true }).count(), 0)
    assert.equal(await firstEye.count(), 0, "foreign project response cannot populate the original list")
    await page.evaluate(() => window.passageHistory.project("project"))
    await firstEye.waitFor()
    await reader.getByText("msg_artifact_rec_first_29", { exact: true }).waitFor()
    const beforeStop = reads
    await page.evaluate(async () => {
      const { serverEvents } = await import("/src/lib/server-events.ts")
      ;(serverEvents as unknown as { dispatchBatch(events: unknown[]): void }).dispatchBatch([{ type: "workspace.stopped", workspaceId: "fixture" }])
    })
    await reader.getByText("This mission content is no longer available.").waitFor()
    assert.equal(await firstEye.count(), 0, "workspace teardown revokes the previous cache")
    assert.equal(reads, beforeStop, "teardown does not start a read or rearm a passage")
    assert.deepEqual(unexpected, [])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("central reader fetches exact archived long Markdown/evidence/brief pages and retains references on missing source", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 960, height: 800 } })
  const data = schedule("rec_long"), latest = data.latestResult!
  const requests: Array<{ section: number; page: number; revision?: number }> = [], unexpected: string[] = []
  const texts = ["# Archived summary\n\n" + "Verified passage result. ".repeat(420) + "\n\n```ts\n" + "const exact = 1;\n".repeat(450) + "```\n\nFINAL END",
    "## Exact evidence\n\n" + "Verified line of evidence.\n".repeat(400) + "EVIDENCE END",
    "## Original brief\n\n" + "Bounded requested objective.\n".repeat(370) + "BRIEF END"]
  const sections: MissionRecurrenceReadPage["sections"] = [
    { index: 0, label: "summary", title: "", raw: false }, { index: 1, label: "evidence", title: "Exact review", raw: false },
    { index: 2, label: "brief", title: "Exact review", raw: false },
  ]
  let missing = false, heldRelease: (() => void) | undefined, holdOld = false
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => {
    if (route.request().method() !== "GET" || route.request().url().includes("/missions")) unexpected.push(route.request().url())
    return route.fulfill({ json: {} })
  })
  await page.route("**/api/workspaces/fixture/missions/recurrence", route => route.fulfill({ json: { version: 1, projectID: "project", schedules: [data] } }))
  await page.route("**/api/workspaces/fixture/missions/recurrence/*/passages/*?*", async route => {
    assert.equal(route.request().method(), "GET")
    const target = new URL(route.request().url()), passageID = target.pathname.split("/").at(-1)!
    const section = Number(target.searchParams.get("section")), selectedPage = Number(target.searchParams.get("page"))
    const revision = target.searchParams.get("revision")
    assert.deepEqual([...target.searchParams.keys()].sort(), revision ? ["page", "revision", "section"] : ["page", "section"])
    requests.push({ section, page: selectedPage, ...(revision ? { revision: Number(revision) } : {}) })
    if (holdOld && passageID !== latest.passageID) await new Promise<void>(resolve => { heldRelease = resolve })
    if (missing) return route.fulfill({ status: 503, json: { error: "Exact archived journal missing" } }).catch(() => {})
    const receipt = data.history.find(receipt => receipt.passageID === passageID)!
    const result: MissionRecurrenceReadPage = { version: 1, projectID: "project", scheduleID: "rec_long", passageID,
      missionID: receipt.missionID!, conversationID: receipt.conversationID!, revision: 7, section, sectionCount: sections.length, sections,
      page: selectedPage, pageCount: Math.ceil(texts[section].length / 9000), ...missionMarkdownPage(texts[section], selectedPage) }
    return route.fulfill({ json: result }).catch(() => {})
  })
  await page.route("**/workspaces/**/instance/api/**", route => { unexpected.push(route.request().url()); return route.fulfill({ json: {} }) })
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Read passage history for rec_long" }).click()
    const result = page.locator(".mission-recurrence-result")
    await result.getByRole("heading", { name: "Archived summary", exact: true }).waitFor()
    assert.equal(requests.length, 1, "opening loads one page of one archived source, not every report or the transcript")
    const pages = Math.ceil(texts[0].length / 9000)
    const summaryPage = result.getByRole("spinbutton", { name: `Page 1 of ${pages}` })
    await summaryPage.fill(String(pages)); await summaryPage.press("Enter")
    await result.getByText("FINAL END", { exact: false }).waitFor()
    assert.equal(requests.at(-1)?.page, pages - 1)
    assert.equal(requests.at(-1)?.revision, 7)
    assert.ok(await result.locator("pre code").count() > 0, "continued fenced code uses shared Markdown pagination")
    await result.getByRole("combobox").selectOption("1")
    await result.getByRole("heading", { name: "Exact evidence", exact: true }).waitFor()
    const evidencePage = result.getByRole("spinbutton", { name: /Page 1 of/ })
    await evidencePage.fill("2"); await evidencePage.press("Enter")
    await result.getByText("EVIDENCE END", { exact: false }).waitFor()
    await result.getByRole("combobox").selectOption("2")
    await result.getByRole("heading", { name: "Original brief", exact: true }).waitFor()
    const briefPage = result.getByRole("spinbutton", { name: /Page 1 of/ })
    await briefPage.fill("2"); await briefPage.press("Enter")
    await result.getByText("BRIEF END", { exact: false }).waitFor()
    await page.setViewportSize({ width: 390, height: 800 })
    await page.evaluate(() => { document.documentElement.dir = "rtl" })
    assert.ok(await page.locator(".mission-recurrence-item > button strong").first().evaluate(node => node.getBoundingClientRect().height) < 60,
      "the pinned eye column must not make the clock wrap one character per line")
    await captureMissionView(page, "archive-reader-390-rtl")
    const narrow = await result.getByRole("combobox").evaluate(node => ({ select: node.getBoundingClientRect().width,
      body: node.closest(".window-body")!.getBoundingClientRect().width, radius: getComputedStyle(node).borderRadius }))
    assert.ok(narrow.select <= narrow.body, "paged result selector remains inside narrow RTL reader chrome")
    assert.equal(narrow.radius, "0px")
    holdOld = true
    const old = data.history[0]
    const heldRequest = page.waitForRequest(request => request.url().includes(`/passages/${old.passageID}`))
    await page.getByRole("button", { name: `Read result for passage ${old.passageID}`, exact: true }).click()
    await heldRequest
    const beforeReturn = requests.length
    await page.getByRole("button", { name: `Read result for passage ${latest.passageID}`, exact: true }).click()
    await result.getByText("BRIEF END", { exact: false }).waitFor()
    await result.getByRole("combobox").selectOption("0")
    await result.getByRole("heading", { name: "Archived summary", exact: true }).waitFor()
    assert.equal(requests.length, beforeReturn, "returning to exact immutable cached pages does not reread the journal")
    heldRelease?.()
    assert.equal(await result.getAttribute("aria-label"), `Read result for passage ${latest.passageID}`, "late old passage cannot retarget the reader")
    missing = true; holdOld = false
    const absent = data.history[1]
    await page.getByRole("button", { name: `Read result for passage ${absent.passageID}`, exact: true }).click()
    heldRelease?.()
    await result.getByRole("alert").waitFor()
    assert.equal(await page.locator(".mission-reader").getByText(absent.passageID, { exact: true }).count(), 1, "source failure retains the exact receipt")
    assert.equal(await result.getByRole("heading", { name: "Archived summary", exact: true }).count(), 0, "no other passage prose is substituted")
    assert.deepEqual(unexpected, [])
  } finally { heldRelease?.(); await page.close() }
})

test("late Location response never installs data into a different reader or list", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 960, height: 700 } })
  let reads = 0, release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route("**/api/workspaces/fixture/missions/recurrence", async route => {
    const read = ++reads
    if (read === 2) await held
    await route.fulfill({ json: { version: 1, projectID: "project", schedules: [schedule(read <= 2 ? "rec_old" : "rec_new")] } }).catch(() => {})
  })
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Read passage history for rec_old" }).click()
    await page.locator(".mission-reader").getByText("msg_artifact_rec_old_29", { exact: true }).waitFor()
    const secondRead = page.waitForRequest(request => request.url().endsWith("/missions/recurrence"))
    await page.evaluate(() => window.passageHistory.refresh())
    await secondRead
    await page.evaluate(() => window.passageHistory.directory("/other"))
    await page.getByRole("button", { name: "Read passage history for rec_new" }).waitFor()
    release()
    await page.getByRole("button", { name: "Read passage history for rec_new" }).click()
    await page.locator(".mission-reader").getByText("msg_artifact_rec_new_29", { exact: true }).waitFor()
    assert.equal(await page.getByText("msg_artifact_rec_old_29", { exact: true }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "Read passage history for rec_old" }).count(), 0)
  } finally { release(); await page.close() }
})

test("native calendar archive event updates visible reader/list once; hidden consumers wait for activation", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 960, height: 800 } })
  const sample = schedule("rec_live"), receipt = sample.history.at(-1)!
  let data: MissionRecurrenceSnapshot["schedules"][number] = { ...sample, revision: 0, settledCount: 0,
    pendingPassageID: null, pendingStatus: null, pendingAdmission: null, latestResult: null, history: [] }
  let reads = 0, resultReads = 0, holdNext = false, release!: () => void
  let entered!: () => void
  const enteredRead = new Promise<void>(resolve => { entered = resolve })
  const unexpected: string[] = []
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => {
    if (route.request().method() !== "GET" || route.request().url().includes("/missions")) unexpected.push(route.request().url())
    return route.fulfill({ json: {} })
  })
  await page.route("**/api/workspaces/fixture/missions/recurrence", async route => {
    reads++
    if (holdNext) { holdNext = false; entered(); await new Promise<void>(resolve => { release = resolve }) }
    await route.fulfill({ json: { version: 1, projectID: "project", schedules: [data] } }).catch(() => {})
  })
  await page.route("**/api/workspaces/fixture/missions/recurrence/*/passages/*?*", route => {
    resultReads++
    const target = new URL(route.request().url()), passageID = target.pathname.split("/").at(-1)!
    const source = data.history.find(item => item.passageID === passageID)!
    const text = `## Archived result ${data.settledCount}\n\nExact native journal result.`
    const result: MissionRecurrenceReadPage = { version: 1, projectID: "project", scheduleID: data.id, passageID,
      missionID: source.missionID!, conversationID: source.conversationID!, revision: 7,
      section: 0, sectionCount: 1, sections: [{ index: 0, label: "summary", title: "", raw: false }],
      page: 0, pageCount: 1, sourceText: text, markdownText: text }
    return route.fulfill({ json: result })
  })
  await page.route("**/workspaces/**/instance/api/**", route => { unexpected.push(route.request().url()); return route.fulfill({ json: {} }) })
  try {
    await page.goto(url)
    const eye = page.getByRole("button", { name: "Read passage history for rec_live", exact: true })
    await eye.click()
    const reader = page.locator(".mission-reader")
    await reader.getByText("No archived passages yet.").waitFor()
    assert.equal(reads, 1, "list and reader share initial visible demand")
    assert.equal(resultReads, 0)
    const beforeProgress = reads
    await page.evaluate(() => {
      window.passageHistory.event("session.message.text.delta", { sessionID: "ses_progress", delta: "not a calendar commit" })
      window.passageHistory.event("rpc.codenomad.missions.changed", { missionID: "msn_finite", revision: 12 })
      window.passageHistory.event("rpc.codenomad.missions.scheduleChanged", { scheduleID: "rec_live", revision: 2 }, "foreign_instance")
      window.passageHistory.event("rpc.codenomad.missions.scheduleChanged", { scheduleID: "rec_live", revision: 2, prompt: "unexpected data" })
    })
    await page.waitForTimeout(130)
    assert.equal(reads, beforeProgress, "progress, finite Mission events and malformed/foreign events do not refresh calendars")
    // The right panel is hidden; the central result reader remains an actual visible consumer.
    await page.evaluate(() => window.passageHistory.activate(false))
    data = { ...data, revision: 4, settledCount: 1, latestResult: receipt, history: [receipt] }
    await page.evaluate(() => { for (const revision of [2, 3, 4]) window.passageHistory.scheduleChanged("rec_live", revision) })
    await reader.getByRole("heading", { name: "Archived result 1", exact: true }).waitFor()
    assert.equal(reads, beforeProgress + 1, "one typed native archive burst produces one bounded snapshot read")
    assert.equal(resultReads, 1, "only the exact newly archived result page is demanded")
    assert.equal(await eye.getAttribute("aria-pressed"), "true")
    const next = { ...receipt, passageID: "rcp_live_hidden", messageID: "msg_hidden", missionID: "msn_hidden", conversationID: "ses_hidden" }
    await page.evaluate(() => window.passageHistory.readerVisible(false))
    const hiddenReads = reads
    data = { ...data, revision: 6, settledCount: 2, latestResult: next, history: [receipt, next] }
    await page.evaluate(() => window.passageHistory.scheduleChanged("rec_live", 6))
    await page.waitForTimeout(130)
    assert.equal(reads, hiddenReads, "no consumer visible: retain cache without background reads or a UI scheduler")
    assert.equal(await page.getByText("Latest result: Completed (archived)", { exact: true }).count(), 1, "hidden list retains confirmed data")
    await page.evaluate(() => { window.passageHistory.activate(true); window.passageHistory.readerVisible(true) })
    await reader.getByRole("heading", { name: "Archived result 2", exact: true }).waitFor()
    assert.equal(reads, hiddenReads + 1, "activation coalesces reader/list demand into one authoritative revalidation")
    assert.equal(resultReads, 2)
    holdNext = true
    await page.evaluate(() => window.passageHistory.scheduleChanged("rec_live", 7))
    await enteredRead
    const duringRead = reads
    await page.evaluate(() => { for (const revision of [8, 9, 10]) window.passageHistory.scheduleChanged("rec_live", revision) })
    data = { ...data, revision: 10 }
    await page.waitForTimeout(90)
    assert.equal(reads, duringRead, "an in-flight calendar read is shared, not interrupted by another event")
    release()
    await page.waitForResponse(response => response.url().endsWith("/missions/recurrence"))
    await page.waitForTimeout(90)
    assert.equal(reads, duringRead + 1, "events during a read coalesce into exactly one follow-up")
    assert.equal(resultReads, 2, "an unchanged immutable archived receipt does not reload prose or transcript windows")
    assert.deepEqual(unexpected, [])
  } finally { release?.(); await page.close() }
})

test("numeric reader drafts commit on Enter/blur without losing keyboard focus during delayed and foreign page reads", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 960, height: 800 } })
  const data = schedule("rec_keyboard"), receipt = data.latestResult!
  const requests: string[] = [], unexpected: string[] = [], errors: string[] = []
  const held = new Map<string, { entered: Promise<void>; enter(): void; gate: Promise<void>; release(): void; foreign: boolean }>()
  const hold = (key: string, foreign = false) => {
    let enter!: () => void, release!: () => void
    const entry = { entered: new Promise<void>(resolve => { enter = resolve }), enter: () => enter(),
      gate: new Promise<void>(resolve => { release = resolve }), release: () => release(), foreign }
    held.set(key, entry); return entry
  }
  const sectionRead = hold("17:0"), pageRead = hold("18:11"), foreignRead = hold("18:13", true)
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => {
    if (route.request().method() !== "GET" || route.request().url().includes("/missions")) unexpected.push(route.request().url())
    return route.fulfill({ json: {} })
  })
  await page.route("**/api/workspaces/fixture/missions/recurrence", route => route.fulfill({ json: { version: 1, projectID: "project", schedules: [data] } }))
  await page.route("**/api/workspaces/fixture/missions/recurrence/*/passages/*?*", async route => {
    assert.equal(route.request().method(), "GET")
    const target = new URL(route.request().url()), section = Number(target.searchParams.get("section")), selectedPage = Number(target.searchParams.get("page"))
    const key = `${section}:${selectedPage}`, waiting = held.get(key)
    requests.push(key)
    if (waiting) { waiting.enter(); await waiting.gate }
    const offset = Math.floor(section / 32) * 32
    const text = waiting?.foreign ? "FOREIGN RESULT MUST NOT RENDER" : `Verified artifact section ${section + 1}, page ${selectedPage + 1}`
    const result: MissionRecurrenceReadPage = { version: 1, projectID: "project", scheduleID: data.id, passageID: receipt.passageID,
      missionID: waiting?.foreign ? "msn_foreign" : receipt.missionID!, conversationID: receipt.conversationID!, revision: 7,
      section, sectionCount: 40, sections: Array.from({ length: Math.min(32, 40 - offset) }, (_, index) => ({ index: offset + index,
        label: "artifact", title: `Native result ${offset + index + 1}`, raw: true })), page: selectedPage, pageCount: 24, sourceText: text, markdownText: text }
    return route.fulfill({ json: result }).catch(() => {})
  })
  await page.route("**/workspaces/**/instance/api/**", route => { unexpected.push(route.request().url()); return route.fulfill({ json: {} }) })
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Read passage history for rec_keyboard", exact: true }).click()
    const result = page.locator(".mission-recurrence-result")
    await result.getByText("Verified artifact section 1, page 1", { exact: true }).waitFor()
    const sectionInput = result.getByRole("spinbutton").nth(0), pageInput = result.getByRole("spinbutton").nth(1)
    const sectionNode = (await sectionInput.elementHandle())!, pageNode = (await pageInput.elementHandle())!
    await sectionInput.click(); await sectionInput.press("ControlOrMeta+A"); await sectionInput.pressSequentially("18", { delay: 30 })
    assert.equal(await sectionInput.inputValue(), "18")
    assert.deepEqual(requests, ["0:0"], "the first digit never starts a read or removes the input")
    await sectionInput.press("Enter"); await sectionRead.entered
    assert.equal(await sectionNode.evaluate(node => node.isConnected && node === document.activeElement), true)
    assert.equal(await pageNode.evaluate(node => node.isConnected), true, "page toolbar remains mounted during section loading")
    await sectionInput.press("ArrowUp")
    assert.equal(await sectionInput.inputValue(), "19")
    sectionRead.release()
    await result.getByText("Verified artifact section 18, page 1", { exact: true }).waitFor()
    assert.equal(await sectionInput.inputValue(), "19", "an older committed section reply cannot erase a newer draft")
    assert.equal(await sectionNode.evaluate(node => node === document.activeElement), true)
    assert.deepEqual(requests, ["0:0", "17:0"])
    await pageInput.click() // blur explicitly commits section 19
    await result.getByText("Verified artifact section 19, page 1", { exact: true }).waitFor()
    assert.equal(await pageNode.evaluate(node => node.isConnected && node === document.activeElement), true)
    await pageInput.press("ControlOrMeta+A"); await pageInput.pressSequentially("12", { delay: 30 })
    assert.deepEqual(requests, ["0:0", "17:0", "18:0"], "multi-digit page draft is not an HTTP request")
    await pageInput.press("Enter"); await pageRead.entered
    assert.equal(await pageNode.evaluate(node => node.isConnected && node === document.activeElement), true)
    await pageInput.press("ArrowUp")
    assert.equal(await pageInput.inputValue(), "13")
    pageRead.release()
    await result.getByText("Verified artifact section 19, page 12", { exact: true }).waitFor()
    assert.equal(await pageInput.inputValue(), "13", "a delayed page reply preserves the next arrow-key draft")
    assert.equal(await pageNode.evaluate(node => node === document.activeElement), true)
    await sectionInput.click() // blur explicitly commits page 13
    await result.getByText("Verified artifact section 19, page 13", { exact: true }).waitFor()
    await pageInput.click(); await pageInput.press("ArrowUp"); await pageInput.press("Enter"); await foreignRead.entered
    assert.equal(await pageInput.inputValue(), "14")
    assert.equal(await pageNode.evaluate(node => node.isConnected && node === document.activeElement), true)
    foreignRead.release()
    await result.getByRole("alert").waitFor()
    assert.equal(await result.getByText("FOREIGN RESULT MUST NOT RENDER", { exact: true }).count(), 0)
    assert.equal(await result.getByText("Verified artifact section 19, page 13", { exact: true }).count(), 1, "retain only the last owned confirmed source")
    assert.equal(await pageInput.inputValue(), "14")
    assert.equal(await pageNode.evaluate(node => node.isConnected && node === document.activeElement), true)
    assert.deepEqual(requests, ["0:0", "17:0", "18:0", "18:11", "18:12", "18:13"])
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, [])
  } finally { for (const entry of held.values()) entry.release(); await page.close() }
})
