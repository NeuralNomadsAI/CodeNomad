import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Locator, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { marked } from "marked"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import type { NativeMissionCapture } from "./fixtures/native-mission-integration"

let browser: Browser, server: ViteDevServer, url: string, capture: NativeMissionCapture
let current: NativeMissionCapture["frames"][number]
let outputDirectory: string
const requests: string[] = []
const requiredLabels = ["initial", "investigate-reported", "implemented", "verified", "finished"]
const capturedMission = (frame: NativeMissionCapture["frames"][number]) => {
  const matches = frame.snapshot.missions.filter(mission => mission.coordinatorSessionId === capture.rootID)
  assert.equal(matches.length, 1, `${frame.label}: capture must identify exactly one coordinator mission`)
  return matches[0]
}
function capturedSessions(frame: NativeMissionCapture["frames"][number]) {
  const roots = new Set([capture.rootID, ...capturedMission(frame).actors.map(actor => actor.sessionId)])
  const retained = new Set(roots)
  // Include actual descendants, never infer a native hierarchy from task dependencies.
  for (let size = -1; size !== retained.size;) {
    size = retained.size
    for (const session of frame.sessions) if (session.parentID && retained.has(session.parentID)) retained.add(session.id)
  }
  return frame.sessions.filter(session => retained.has(session.id))
}

before(async () => {
  assert(process.env.NATIVE_MISSION_CAPTURE && path.isAbsolute(process.env.NATIVE_MISSION_CAPTURE), "Set NATIVE_MISSION_CAPTURE to the absolute capture.json from the private native run")
  capture = JSON.parse(await readFile(process.env.NATIVE_MISSION_CAPTURE, "utf8")) as NativeMissionCapture
  assert.equal(capture.version, 1); assert.equal(capture.transport, "captured-native-fixture")
  assert.equal(typeof capture.rootID, "string"); assert(capture.rootID)
  assert(Array.isArray(capture.frames)); assert.equal(new Set(capture.frames.map(frame => frame.label)).size, capture.frames.length)
  for (const label of requiredLabels) assert(capture.frames.some(frame => frame.label === label), `Missing actual native frame: ${label}`)
  for (const frame of capture.frames) {
    assert(Array.isArray(frame.sessions) && Array.isArray(frame.events), `${frame.label}: native sessions/events required`)
    capturedMission(frame)
  }
  current = capture.frames.find(frame => frame.label === "initial")!
  const coordinator = current.sessions.find(session => session.id === capture.rootID)
  assert(coordinator, "Actual coordinator Session.Info missing")
  outputDirectory = process.env.NATIVE_MISSION_OUTPUT || path.join(tmpdir(), "opencode", `native-mission-ui-${Date.now()}`)
  assert(path.isAbsolute(outputDirectory), "NATIVE_MISSION_OUTPUT must be absolute")
  await mkdir(outputDirectory, { recursive: true })
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  try {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), cacheDir: cache.cacheDir,
      logLevel: "error", plugins: [shutdown.plugin, solid(), { name: "captured-native-fixture-only", configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          const request = new URL(req.url!, "http://127.0.0.1")
          const pathname = request.pathname
          const json = (value: unknown, status = 200) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)) }
          if (pathname === "/__native_capture") return json(capture)
          if (pathname === "/__native_frame") {
            const frame = capture.frames.find(frame => frame.label === request.searchParams.get("label"))
            if (req.method !== "POST" || !frame) return json({ error: "Unknown captured frame" }, 400)
            current = frame; return json({ label: frame.label, transport: capture.transport })
          }
          if (pathname === "/native-mission-integration") {
            res.setHeader("Content-Type", "text/html")
            res.end(await s.transformIndexHtml(pathname, '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/native-mission-integration.tsx"></script></body></html>'))
            return
          }
          if (!pathname.startsWith("/api/") && !pathname.startsWith("/workspaces/")) return next()
          requests.push(`${req.method} ${pathname}`)
          if (pathname === "/api/events") { res.setHeader("Content-Type", "text/event-stream"); res.write(": captured-native-fixture transport; events replay via existing publisher\n\n"); return }
          if (req.method !== "GET") return json({ error: "Captured fixture never admits native mutations" }, 405)
          const mission = capturedMission(current), location = coordinator.location
          if (pathname.endsWith("/missions")) return json({ ...current.snapshot, available: true, missions: [mission] })
          if (pathname.endsWith("/worktrees")) return json({ isGitRepo: true, worktrees: [{ slug: "root", directory: location.directory, kind: "root" }] })
          if (pathname.endsWith("/session/active")) return json({ error: "No active-session snapshot captured; runtime state remains unknown" }, 501)
          if (pathname.endsWith("/session")) {
            const inventory = capturedSessions(current)
            const parent = request.searchParams.get("parentID")
            return json({ data: parent === "null" ? inventory.filter(session => !session.parentID) : parent ? inventory.filter(session => session.parentID === parent) : inventory, cursor: {} })
          }
          const sessionID = pathname.match(/\/session\/([^/]+)$/)?.[1]
          if (sessionID) {
            const session = capturedSessions(current).find(session => session.id === decodeURIComponent(sessionID))
            return session ? json(session) : json({ error: "Session absent from capture" }, 404)
          }
          if (pathname.endsWith("/command") || pathname.endsWith("/agent") || pathname.endsWith("/provider") || pathname.endsWith("/model")) return json({ location, data: [] })
          if (pathname.endsWith("/model/default")) return json({ location, data: null })
          return json({ error: `Uncaptured fixture endpoint: ${pathname}` }, 501)
        })
      } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
    shutdown.own(server); await server.listen()
    url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/native-mission-integration`
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  } catch (error) { if (server) await server.close(); else await cache.dispose(); throw error }
})
after(async () => { try { await browser?.close() } finally { await server?.close() } })

const taskRow = (page: Page, key: string) => page.locator(`.mission-route-task[data-task-key="${key}"]`)
async function assertFrame(page: Page, frame: NativeMissionCapture["frames"][number]) {
  const mission = capturedMission(frame)
  await page.waitForFunction(expected => JSON.stringify(window.nativeMissionIntegration.snapshot().missions) === expected, JSON.stringify([mission]))
  for (const task of mission.tasks) {
    await taskRow(page, task.key).waitFor()
    assert.equal(await taskRow(page, task.key).getAttribute("data-status"), task.status, `${frame.label}: ${task.key}`)
  }
  const edges = mission.tasks.flatMap(task => task.blockedBy.map(from => `${from}->${task.key}`)).sort()
  assert.deepEqual(edges, ["implement->verify", "investigate->implement"], "Only captured declared task edges are expected")
  await page.waitForFunction(count => document.querySelectorAll(".mission-graph path[data-from]").length === count, edges.length)
  assert.deepEqual(await page.locator(".mission-graph path[data-from]").evaluateAll(paths => paths.map(item => `${item.getAttribute("data-from")}->${item.getAttribute("data-to")}`).sort()), edges)
  const state = await page.evaluate(() => window.nativeMissionIntegration.snapshot())
  assert.deepEqual(state.sessions.sort((a, b) => a.id.localeCompare(b.id)), capturedSessions(frame).map(session => ({ id: session.id, parentID: session.parentID ?? null })).sort((a, b) => a.id.localeCompare(b.id)))
  return state
}

async function assertReaderSection(page: Page, article: Locator, source: string, raw = false) {
  const number = article.getByRole("spinbutton")
  const count = await number.count() ? Number(await number.getAttribute("max")) : 1
  assert.equal(count, Math.max(1, Math.ceil(source.length / 9000)))
  for (let index = 0; index < count; index++) {
    if (index) await number.fill(String(index + 1))
    const boundary = (offset: number) => offset > 0 && /[\uDC00-\uDFFF]/.test(source.charAt(offset)) && /[\uD800-\uDBFF]/.test(source.charAt(offset - 1)) ? offset - 1 : offset
    const piece = source.slice(boundary(index * 9000), boundary((index + 1) * 9000))
    assert(piece.length <= 9001, "Reader must mount a bounded native report page")
    if (raw) {
      await page.waitForFunction(({ expected, articleIndex }) => document.querySelectorAll(".mission-reader article")[articleIndex]?.querySelector("pre")?.textContent === expected,
        { expected: piece, articleIndex: await article.evaluate(element => [...document.querySelectorAll(".mission-reader article")].indexOf(element)) })
      assert.equal(await article.locator("pre").textContent(), piece)
      continue
    }
    const expectedHTML = await marked.parse(piece, { breaks: true })
    const expectedText = await page.evaluate(html => { const document = new DOMParser().parseFromString(html, "text/html"); return document.body.textContent?.replace(/\s+/g, " ").trim() ?? "" }, expectedHTML)
    const content = article.locator(".markdown-body").first()
    await page.waitForFunction(({ expected, articleIndex }) => {
      const value = document.querySelectorAll(".mission-reader article")[articleIndex]?.querySelector(".markdown-body")?.textContent?.replace(/\s+/g, " ").trim()
      return value === expected
    }, { expected: expectedText, articleIndex: await article.evaluate(element => [...document.querySelectorAll(".mission-reader article")].indexOf(element)) })
    assert.equal((await content.textContent())?.replace(/\s+/g, " ").trim(), expectedText)
  }
  if (count > 1) {
    await article.getByRole("button", { name: "Copy", exact: true }).click()
    await page.waitForFunction(expected => window.nativeMissionCopiedText === expected, source)
  }
}

test("captured actual-native mission frames render dependencies, reports and exact descendant navigation", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, locale: "en-US" })
  const errors: string[] = [], externalRequests: string[] = [], observations: unknown[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== new URL(url).origin) { externalRequests.push(route.request().url()); return route.abort() }
    return route.continue()
  })
  // String transport avoids tsx's named-function helper in the isolated page.
  await page.addInitScript("Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.nativeMissionCopiedText=text}}})")
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean(window.nativeMissionIntegration))
    const expectedTransitions: Record<string, Record<string, string>> = {
      initial: { investigate: "ready", implement: "blocked", verify: "blocked" },
      "native-success-unreported": { investigate: "ready", implement: "blocked", verify: "blocked" },
      "negative-reports-denied": { investigate: "ready", implement: "blocked", verify: "blocked" },
      "investigate-reported": { investigate: "completed", implement: "ready", verify: "blocked" },
      "parallel-review-active": { investigate: "completed", implement: "ready", verify: "blocked" },
      implemented: { investigate: "completed", implement: "completed", verify: "ready" },
      verified: { investigate: "completed", implement: "completed", verify: "completed" },
    }
    // Replay native history forward; a bounded display refresh is not a deletion
    // event and must not erase future sessions retained after a backward replay.
    for (const { label } of capture.frames) {
      const frame = capture.frames.find(frame => frame.label === label)!, mission = capturedMission(frame)
      if (label !== "initial") await page.evaluate(label => window.nativeMissionIntegration.replay(label), label)
      if (expectedTransitions[label]) assert.deepEqual(Object.fromEntries(mission.tasks.map(task => [task.key, task.status])), expectedTransitions[label], `Actual capture violates ${label} transition contract`)
      if (label === "finished") assert.equal(mission.status, "completed")
      observations.push(await assertFrame(page, frame))
      await page.screenshot({ path: path.join(outputDirectory, `${label}.png`), fullPage: true })
    }
    const finalMission = capturedMission(capture.frames.find(frame => frame.label === "finished")!)
    for (const report of finalMission.reports) {
      const row = taskRow(page, report.taskKey), trigger = row.locator(".mission-disclosure-trigger").first()
      if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click()
      await row.locator(".mission-task-result button").click()
      await page.waitForFunction(reportID => window.nativeMissionIntegration.snapshot().reader?.itemId === reportID, report.id)
      const articles = page.locator(".mission-reader article")
      await assertReaderSection(page, articles.filter({ has: page.getByRole("heading", { name: "Summary", exact: true }) }), report.summary)
      if (report.evidence.length) await assertReaderSection(page, articles.filter({ has: page.getByRole("heading", { name: "Evidence", exact: true }) }), report.evidence.join("\n\n"))
      if (report.next.length) await assertReaderSection(page, articles.filter({ has: page.getByRole("heading", { name: "Recommended next moves", exact: true }) }), report.next.join("\n\n"))
      if (report.artifact !== undefined) await assertReaderSection(page, articles.filter({ has: page.getByRole("heading", { name: "Structured report", exact: true }) }), JSON.stringify(report.artifact, null, 2), true)
      await page.screenshot({ path: path.join(outputDirectory, `report-${report.taskKey}.png`), fullPage: true })
      await page.getByRole("button", { name: "Back to chat", exact: true }).click()
    }
    assert(finalMission.reports.length >= 3, "All three actual native task reports must be captured")
    const actors = page.locator(".mission-disclosure").filter({ has: page.locator(".mission-activity-intro") }).first()
    // Actors initially collapse; locate its header by the real translated title.
    const actorsTrigger = page.locator(".mission-disclosure-trigger").filter({ hasText: "Observed activity" }).first()
    if (await actorsTrigger.getAttribute("aria-expanded") !== "true") await actorsTrigger.click()
    for (const actor of finalMission.actors) {
      await actors.locator(".mission-activity-actor").filter({ has: page.getByText(actor.title, { exact: true }) }).getByRole("button").click()
      assert.equal((await page.evaluate(() => window.nativeMissionIntegration.snapshot())).selectedID, actor.sessionId)
    }
    const inventory = capturedSessions(capture.frames.find(frame => frame.label === "finished")!)
    const children = inventory.filter(session => session.parentID)
    assert(children.some(session => inventory.find(parent => parent.id === session.parentID)?.parentID), "Capture must include an actual native grandchild")
    for (const session of children) {
      const button = page.locator(`[data-native-session-id="${session.id}"]`)
      assert.equal(await button.getAttribute("data-native-parent-id"), session.parentID)
      await button.click()
      const selected = await page.evaluate(() => window.nativeMissionIntegration.snapshot())
      assert.equal(selected.selectedID, session.id, "Native child navigation must select its exact ID")
      let root = session
      while (root.parentID) { const parent = inventory.find(parent => parent.id === root.parentID); assert(parent, "Captured native parent chain is incomplete"); root = parent }
      assert.equal(selected.selectedRootID, root.id)
      observations.push({ nativeNavigation: { id: session.id, parentID: session.parentID }, selected })
    }
    await page.screenshot({ path: path.join(outputDirectory, "native-descendants.png"), fullPage: true })
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, [])
  } catch (error) {
    await page.screenshot({ path: path.join(outputDirectory, "failure.png"), fullPage: true }).catch(() => {})
    observations.push({ failure: String(error) }); throw error
  } finally {
    await writeFile(path.join(outputDirectory, "browser-report.json"), JSON.stringify({ transport: capture.transport, capturePath: process.env.NATIVE_MISSION_CAPTURE,
      publisher: "serverEvents.dispatchBatch -> missions.ts + sse-manager -> sessions.ts", sessionProjection: "fetchSessions -> toClientSessionV2",
      omitted: "Live SSE/authenticated desktop bridge and active-session inventory (not captured); navigation uses native store callbacks, not a rebuilt session tree",
      labels: capture.frames.map(frame => frame.label), observations, errors, externalRequests, requests }, null, 2))
    console.info(`Native mission fixture artifacts: ${outputDirectory}`)
    await page.close()
  }
})
