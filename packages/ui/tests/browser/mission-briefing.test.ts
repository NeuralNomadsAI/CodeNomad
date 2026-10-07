import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import path from "node:path"
import os from "node:os"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { MissionMap, MissionReport } from "../../../server/src/api-types"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import type {} from "./fixtures/mission-navigation"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "briefing", configureServer(s) { s.middlewares.use("/mission-briefing", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/mission-briefing", '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-navigation.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server); await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-briefing`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

const NOW = Date.parse("2026-10-05T15:30:00+02:00")
function mobileMission(id = "A"): MissionMap {
  const report = (key: string, summary: string, outcome: MissionReport["outcome"] = "completed", next: string[] = []): MissionReport => ({
    id: `report-${id}-${key}`, taskKey: key, sessionId: `ses_${id}`, outcome, summary, evidence: ["Source conservée et vérifiable."], next, createdAt: NOW + 10,
  })
  const task = (key: string, title: string, value: MissionReport, status = value.outcome === "blocked" ? "needs-input" : "completed"): MissionMap["tasks"][number] => ({
    id: `task-${id}-${key}`, key, title, brief: "Un périmètre borné", role: "specialist", status: status as any, report: value,
    blockedBy: [], createdAt: NOW, updatedAt: NOW + 10, outstandingExecution: false,
  })
  const xcode = report("xcode", "Xcode a été vérifié. Cela ne constitue pas une application iOS compilée.")
  const android = report("android-boot", "Le démarrage Android attend la quantité de mémoire requise.", "blocked", ["Vérifier à nouveau les ressources avant un essai autorisé."])
  const old = report("old-xcode", "Ancien obstacle : Xcode absent.", "blocked")
  const tasks = [task("xcode", "iOS — vérifier Xcode", xcode), task("android-boot", "Android — préparer l’essai", android),
    { ...task("old-xcode", "Ancienne tentative Xcode", old, "withdrawn"), replacedByTaskKey: "xcode" },
    { ...task("compile-ios", "iOS — compiler l’application", xcode, "blocked"), report: undefined, blockedBy: ["xcode"] }]
  return { version: 1, id, projectID: "project", projectCanonical: "/fixture", objective: id === "A" ? "Livrer CodeNomad pour Android et iOS" : "Mission distincte",
    coordinatorSessionId: `ses_${id}`, status: "active", runState: "running", actors: [{ sessionId: `ses_${id}`, kind: "coordinator", title: "Coordinateur mobile",
      managed: false, roles: ["coordinator"], location: { directory: "/fixture" }, joinedAt: 1 }],
    tasks, reports: [xcode, android, old], frontier: [], claims: [], revision: 4, createdAt: NOW, updatedAt: NOW + 10, history: [], historyTruncated: false }
}
async function setup(locale = "fr-FR") {
  const page = await browser.newPage({ locale, viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(15000)
  const writes: Array<{ path: string; body: any }> = [], errors: string[] = [], values = [mobileMission(), mobileMission("B")]
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    if (request.method() !== "GET") writes.push({ path: pathname, body: request.postData() ? request.postDataJSON() : undefined })
    if (pathname === "/api/events") return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" })
    if (pathname.includes("/instructions/") && request.method() !== "GET") return route.fulfill({ status: 204, body: "" })
    if (pathname.endsWith("/missions")) return route.fulfill({ json: { available: true, projectID: "project", missions: values,
      generatedAt: NOW + 10000, discardedEvents: 0, activity: { generatedAt: NOW + 10000, missions: values.map(value => ({ missionId: value.id,
        actors: [{ sessionId: value.coordinatorSessionId, state: "idle-without-report" }] })) } } })
    if (/\/session\/ses_[AB]$/.test(pathname)) return route.fulfill({ json: { data: { id: pathname.split("/").pop(), projectID: "project",
      title: "Coordinateur mobile", slug: "coordinator", version: "1", agent: "build", model: { id: "native", providerID: "native" },
      location: { directory: "/fixture" }, time: { created: 1, updated: 1 } } } })
    if (pathname.endsWith("/agent")) return route.fulfill({ json: [{ id: "build", name: "build", mode: "primary" }] })
    if (pathname.endsWith("/provider")) return route.fulfill({ json: { all: [], connected: [], default: {} } })
    if (pathname.endsWith("/prompt")) return route.fulfill({ json: { data: { id: request.postDataJSON().id } } })
    return route.fulfill({ json: pathname.includes("/instance/") ? [] : {} })
  })
  await page.goto(url, { timeout: 60000 })
  await page.getByRole("button", { name: values[0].objective, exact: true }).click()
  const refresh = async () => {
    const response = page.waitForResponse(response => response.url().endsWith("/missions"))
    await page.getByRole("button", { name: locale.startsWith("fr") ? "Actualiser la carte de mission" : "Refresh mission map", exact: true }).click()
    await response
  }
  return { page, values, writes, errors, refresh }
}
const briefing = (page: Page) => page.getByRole("region", { name: "Bilan du projet", exact: true })
const prompts = (writes: Array<{ path: string; body: any }>) => writes.filter(write => write.path.endsWith("/prompt"))
function publish(value: MissionMap, requestID: string) {
  value.briefing = { id: `briefing-${value.id}-${requestID}`, requestID, basedOnRevision: value.revision, basedOnUpdatedAt: value.updatedAt,
    createdAt: value.updatedAt + 1000, summary: "Les outils sont préparés, mais aucune application Android ou iOS n’est encore prête à tester.",
    achieved: [{ text: "iOS : Xcode a été vérifié, pas l’application.", taskKeys: ["xcode"] }], ongoing: [],
    obstacles: [{ text: "Android : l’essai attend les ressources requises.", taskKeys: ["android-boot"] }],
    next: [{ text: "Lever les prérequis puis compiler et tester chaque application.", taskKeys: ["compile-ios", "android-boot"] }] }
  value.revision++; value.updatedAt = value.briefing.createdAt
}

test("existing mobile project keeps a compact panel and exact current results in its central reader, not an invented product percentage", async () => {
  const { page, writes, errors } = await setup()
  try {
    await briefing(page).getByText(/Pas encore de bilan du projet/).waitFor()
    const progress = page.locator(".mission-progress")
    assert.equal(await progress.getByText("Le démarrage Android attend la quantité de mémoire requise.", { exact: true }).count(), 0)
    await page.locator(".mission-flow").getByText("iOS — compiler l’application", { exact: true }).waitFor()
    await progress.getByText(/Aucune activité observée/).waitFor()
    assert.equal(await progress.getByText("Ancien obstacle : Xcode absent.", { exact: true }).count(), 0)
    assert.equal(await page.locator(".mission-attention-list").count(), 0)
    assert.equal(await page.getByRole("button", { name: "Détails techniques", exact: true }).getAttribute("aria-expanded"), "false")
    assert.equal(await page.locator(".mission-control-index").getByText("Active", { exact: true }).count(), 0)
    assert.deepEqual(writes, [])
    assert.deepEqual(errors, [])
    const overview = page.locator('.mission-control-index .mission-list-item').filter({ has: page.getByRole("button", { name: "Livrer CodeNomad pour Android et iOS", exact: true }) })
      .getByRole("button", { name: "Lire dans la zone de chat", exact: true })
    await overview.click()
    await page.locator(".mission-reader").getByText("Le démarrage Android attend la quantité de mémoire requise.", { exact: true }).waitFor()
    await page.locator(".mission-reader").getByText("Xcode a été vérifié. Cela ne constitue pas une application iOS compilée.", { exact: true }).waitFor()
    assert.equal(await page.locator(".mission-reader").getByText("Ancien obstacle : Xcode absent.", { exact: true }).count(), 0)
    await overview.click()
    await page.setViewportSize({ width: 390, height: 900 })
    await page.locator("#root > div").evaluate(element => { (element as HTMLElement).style.gridTemplateColumns = "0 minmax(0,1fr)" })
    await page.locator("aside").evaluate(element => { element.scrollTop = 0 })
    await page.screenshot({ path: path.join(os.tmpdir(), "opencode", "mission-briefing-fr-missing-390.png") })
  } finally { await page.close() }
})

test("one click prepares the briefing request, preserves conversation/profile/drafts and waits for the exact returned briefing", async () => {
  const { page, values, writes, errors, refresh } = await setup()
  try {
    await page.getByRole("button", { name: "Donner une orientation", exact: true }).click()
    await page.getByLabel("Votre consigne", { exact: true }).fill("Brouillon à conserver")
    await briefing(page).getByRole("button", { name: "Faire le point", exact: true }).click()
    await briefing(page).getByText(/Demande envoyée/).waitFor()
    assert.equal(prompts(writes).length, 1)
    const sent = prompts(writes)[0]
    assert.match(sent.path, /\/ses_A\/prompt$/)
    assert.equal(sent.body.delivery, "steer")
    assert.match(sent.body.text, /Response language: fr/)
    const requestID = /Request ID: ([^\n]+)/.exec(sent.body.text)![1]
    assert.equal(await briefing(page).getByRole("button", { name: "Faire le point", exact: true }).isDisabled(), true)
    assert.equal((await page.evaluate(() => window.missionNavigation.snapshot())).selectedSession, "ses_B")
    assert.equal(await page.getByLabel("Votre consigne", { exact: true }).inputValue(), "Brouillon à conserver")
    assert.ok(!writes.some(write => /\/missions(?:\/|$)|\/session\/[^/]+\/(agent|model)$/.test(write.path)))
    publish(values[0], "another-request"); await refresh()
    await briefing(page).getByRole("button", { name: "Bilan du projet", exact: true }).waitFor()
    assert.equal(await briefing(page).getByRole("button", { name: "Faire le point", exact: true }).isDisabled(), true)
    publish(values[0], requestID); await refresh()
    await briefing(page).getByRole("button", { name: "Faire le point", exact: true }).waitFor()
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".mission-briefing header button")!.disabled)
    assert.equal(await briefing(page).getByText(/Demande envoyée/).count(), 0)
    await briefing(page).getByRole("button", { name: "Bilan du projet", exact: true }).click()
    await page.locator(".mission-reader").getByRole("button", { name: "iOS — vérifier Xcode", exact: true }).click()
    await page.locator(".mission-reader").getByText("Source conservée et vérifiable.", { exact: true }).waitFor()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("unconfirmed briefing admission survives navigation and remount without automatic replay", async () => {
  const { page, writes, refresh } = await setup()
  let attempts = 0
  try {
    await page.route("**/session/ses_A/prompt", route => { attempts++; return route.fulfill({ status: 503, json: { error: "lost acknowledgement" } }) })
    await briefing(page).getByRole("button", { name: "Faire le point", exact: true }).click()
    await briefing(page).getByRole("alert").waitFor()
    await page.getByRole("button", { name: "Mission distincte", exact: true }).click()
    await page.getByRole("button", { name: "Livrer CodeNomad pour Android et iOS", exact: true }).click()
    await page.evaluate(() => { window.missionNavigation.mount(false); window.missionNavigation.mount(true) })
    await page.getByRole("button", { name: "Livrer CodeNomad pour Android et iOS", exact: true }).click()
    await refresh()
    await briefing(page).getByRole("alert").waitFor()
    assert.equal(await briefing(page).getByRole("button", { name: "Faire le point", exact: true }).isDisabled(), true)
    page.once("dialog", dialog => dialog.dismiss())
    await briefing(page).getByRole("button", { name: "Faire une nouvelle demande distincte", exact: true }).click()
    assert.equal(attempts, 1)
    assert.equal(prompts(writes).length, 0, "overridden failed endpoint counted separately")
  } finally { await page.close() }
})

test("a freshly paused mission fences the request without resuming or sending it", async () => {
  const { page, values, writes } = await setup()
  try {
    values[0].runState = "paused"
    await briefing(page).getByRole("button", { name: "Faire le point", exact: true }).click()
    await briefing(page).getByRole("alert").waitFor()
    assert.equal(prompts(writes).length, 0)
    assert.ok(!writes.some(write => write.path.includes("/missions/")))
  } finally { await page.close() }
})

test("optional explanation stays separate from direction and briefing refresh, with its own draft and exact coordinator link", async () => {
  const { page, writes, values, errors } = await setup()
  try {
    await page.getByRole("button", { name: "Donner une orientation", exact: true }).click()
    await page.getByLabel("Votre consigne", { exact: true }).fill("Une orientation conservée")
    const toggle = page.getByRole("button", { name: "Poser une question", exact: true })
    assert.equal(await toggle.getAttribute("aria-expanded"), "false")
    await toggle.click()
    const form = page.locator(".mission-question")
    assert.equal(await form.getByRole("combobox").count(), 0)
    await form.getByLabel("Votre question", { exact: true }).fill("Pourquoi iOS n’est-il pas encore testable ?")
    await form.getByRole("button", { name: "Envoyer au coordinateur", exact: true }).click()
    await form.getByText(/Question envoyée/).waitFor()
    assert.equal(prompts(writes).length, 1)
    assert.match(prompts(writes)[0].body.text, /explanation request\. Mission ID: A/)
    assert.match(prompts(writes)[0].body.text, /not a direction to change priorities/)
    assert.match(prompts(writes)[0].body.text, /Pourquoi iOS n’est-il pas encore testable/)
    assert.equal(await page.getByLabel("Votre consigne", { exact: true }).inputValue(), "Une orientation conservée")
    assert.equal(values[0].briefing, undefined)
    assert.equal((await page.evaluate(() => window.missionNavigation.snapshot())).selectedSession, "ses_B")
    await form.getByRole("button", { name: "Ouvrir le coordinateur", exact: true }).click()
    await page.waitForFunction(() => window.missionNavigation.snapshot().selectedSession === "ses_A")
    assert.ok(!writes.some(write => write.path.includes("/missions/")))
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("dated briefing stays distinct from observed activity, signals new evidence and remains readable at desktop and narrow mobile widths", async () => {
  const { page, values, refresh, errors } = await setup()
  try {
    publish(values[0], "initial"); await refresh()
    await briefing(page).getByRole("button", { name: "Bilan du projet", exact: true }).waitFor()
    assert.equal(await briefing(page).getByText(values[0].briefing!.summary, { exact: true }).count(), 0)
    for (const width of [440, 280, 390]) {
      await page.setViewportSize({ width: width === 390 ? 390 : 1280, height: 900 })
      await page.locator("#root > div").evaluate((element, width) => { (element as HTMLElement).style.gridTemplateColumns = width === 390 ? "0 minmax(0,1fr)" : `minmax(0,1fr) ${width}px` }, width)
      await page.locator("aside").evaluate(element => { element.scrollTop = 0 })
      assert.equal(await page.locator("aside").evaluate(element => element.scrollWidth <= element.clientWidth), true)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.screenshot({ path: path.join(os.tmpdir(), "opencode", `mission-briefing-fr-${width}.png`) })
    }
    values[0].tasks[0].report = { ...values[0].tasks[0].report!, id: "new-evidence", createdAt: values[0].updatedAt + 1000 }
    values[0].reports.push(values[0].tasks[0].report!)
    values[0].revision++; values[0].updatedAt = values[0].tasks[0].report!.createdAt
    await refresh()
    await briefing(page).getByText("1 nouveau résultat depuis ce bilan. Demandez une évaluation actualisée.", { exact: true }).waitFor()
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.locator("#root > div").evaluate(element => { (element as HTMLElement).style.gridTemplateColumns = "minmax(0,1fr) 440px" })
    const eye = briefing(page).getByRole("button", { name: "Bilan du projet", exact: true })
    await eye.click()
    assert.equal(await eye.getAttribute("aria-pressed"), "true")
    await page.locator(".mission-reader").getByText(values[0].briefing!.summary, { exact: true }).waitFor()
    assert.equal(await page.locator(".mission-reader").getByRole("heading", { name: "Travail annoncé dans ce bilan", exact: true }).count(), 0)
    await eye.click()
    assert.equal(await eye.getAttribute("aria-pressed"), "false")
    assert.equal(await page.locator(".mission-reader").count(), 0)
    await eye.click()
    await page.setViewportSize({ width: 390, height: 900 })
    await page.locator("#root > div").evaluate(element => { (element as HTMLElement).style.gridTemplateColumns = "minmax(0,1fr) 0" })
    await page.screenshot({ path: path.join(os.tmpdir(), "opencode", "mission-briefing-reader-fr-390.png") })
    await page.getByRole("button", { name: "Retour au chat", exact: true }).click()
    assert.equal(await eye.getAttribute("aria-pressed"), "false")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("seen exact response remains acknowledged when a later briefing supersedes it, while a terminal summary takes precedence", async () => {
  const { page, values, writes, refresh } = await setup()
  try {
    await briefing(page).getByRole("button", { name: "Faire le point", exact: true }).click()
    await briefing(page).getByText(/Demande envoyée/).waitFor()
    const requestID = /Request ID: ([^\n]+)/.exec(prompts(writes)[0].body.text)![1]
    publish(values[0], requestID); await refresh()
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".mission-briefing header button")!.disabled)
    publish(values[0], "subsequent"); await refresh()
    assert.equal(await briefing(page).getByRole("button", { name: "Faire le point", exact: true }).isDisabled(), false)
    values[0].status = "completed"
    values[0].summary = "Résultat final : préparation validée ; aucune application livrée dans cette mission limitée."
    values[0].revision++; await refresh()
    const eye = briefing(page).getByRole("button", { name: "Bilan du projet", exact: true })
    await eye.click()
    await page.locator(".mission-reader").getByText(values[0].summary, { exact: true }).waitFor()
    assert.equal(await briefing(page).getByText(values[0].briefing!.summary, { exact: true }).count(), 0)
    assert.equal(await briefing(page).getByRole("button", { name: "Faire le point", exact: true }).count(), 0)
    assert.equal(prompts(writes).length, 1)
  } finally { await page.close() }
})

test("an early A briefing and late admission acknowledgements never attach A's receipt to newer request B", async () => {
  const { page, values, errors, refresh } = await setup()
  const sent: any[] = []
  let releaseA!: () => void, releaseB!: () => void, reachedA!: () => void, reachedB!: () => void
  const holdA = new Promise<void>(resolve => { releaseA = resolve }), holdB = new Promise<void>(resolve => { releaseB = resolve })
  const startedA = new Promise<void>(resolve => { reachedA = resolve }), startedB = new Promise<void>(resolve => { reachedB = resolve })
  const request = () => page.evaluate(async () => {
    const path = "/src/stores/mission-briefing-request.ts", { missionBriefingRequest } = await import(path)
    return missionBriefingRequest(JSON.stringify(["fixture", "/fixture", "project", "project", "A", "ses_A"]))
  })
  try {
    await page.route("**/session/ses_A/prompt", async route => {
      const body = route.request().postDataJSON(), index = sent.length
      sent.push(body)
      ;(index ? reachedB : reachedA)()
      await (index ? holdB : holdA)
      return route.fulfill({ json: { data: { id: body.id } } })
    })
    const ask = briefing(page).getByRole("button", { name: "Faire le point", exact: true })
    await ask.click(); await startedA
    assert.equal(sent.length, 1)
    const idA = /Request ID: ([^\n]+)/.exec(sent[0].text)![1]
    publish(values[0], idA); await refresh()
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".mission-briefing .window-text-button")!.disabled)
    await ask.click()
    const idB = (await request())!.requestID
    assert.notEqual(idB, idA)
    const postB = page.waitForRequest(request => request.url().endsWith("/prompt"))
    releaseA()
    await postB; await startedB
    assert.equal(/Request ID: ([^\n]+)/.exec(sent[1].text)![1], idB)
    assert.equal((await request())?.requestID, idB)
    assert.equal((await request())?.briefingId, undefined)
    assert.equal(await ask.isDisabled(), true)
    releaseB()
    await briefing(page).getByText(/Demande envoyée/).waitFor()
    assert.equal((await request())?.requestID, idB)
    assert.equal((await request())?.briefingId, undefined)
    assert.equal(await ask.isDisabled(), true)
    publish(values[0], idB); await refresh()
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".mission-briefing .window-text-button")!.disabled)
    assert.equal((await request())?.briefingId, values[0].briefing!.id)
    assert.equal(sent.length, 2, "neither result causes an automatic replay")
    assert.deepEqual(errors, [])
  } finally { releaseA(); releaseB(); await page.close() }
})
