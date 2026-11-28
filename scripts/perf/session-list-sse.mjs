// Run against a sourcemapped production UI build, with no native app or daemon.
// node scripts/perf/session-list-sse.mjs <dist> <artifacts> [seconds]
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { resolve, join, extname, sep } from "node:path"
import { chromium } from "playwright"
import { sampleSessionList } from "./session-list-probes.mjs"

const [dist, artifacts, seconds = "90"] = process.argv.slice(2)
const root = resolve(dist)
const output = resolve(artifacts)
await mkdir(output, { recursive: true })
const profile = await mkdtemp(join(output, "chromium-"))
const folder = "/perf"
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const workspace = {
  id: "wrk_perf", path: folder, status: "ready", port: 1234, proxyPath: "/workspaces/wrk_perf/instance",
  binaryId: "fixture", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
}
const rows = Array.from({ length: 6000 }, (_, i) => ({
  id: `ses_${i}`, parentID: i % 2 ? `ses_${i - 1}` : undefined,
  title: `Conversation ${i}`, projectID: "perf", location: { directory: folder },
  time: { created: 1, updated: i + 1 }, cost: 0, tokens,
}))
const byId = new Map(rows.map(row => [row.id, row]))
for (let i = 0; i < 120; i++) {
  const id = `ses_${6000 + i}`
  byId.set(id, { ...rows[i], id, parentID: "ses_0", title: `Cold conversation ${i}` })
}
const streams = new Set()
const requested = new Set()
const sessionReads = new Map()
let measuring = false
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost"), path = url.pathname
  requested.add(path)
  if (measuring && req.method === "GET" && /\/api\/session(?:\/ses_\d+)?$/.test(path)) {
    const key = path + url.search
    sessionReads.set(key, (sessionReads.get(key) ?? 0) + 1)
  }
  if (path === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
    res.write(": connected\n\n")
    streams.add(res)
    res.on("close", () => streams.delete(res))
    return
  }
  let body
  if (path === "/api/meta") body = { apiContract: 1, serverId: "local", localRequest: true }
  else if (path === "/api/auth/status") body = { authenticated: true }
  else if (path === "/api/workspaces") {
    if (req.method === "POST") {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      body = { ...workspace, requestId: JSON.parse(Buffer.concat(chunks)).requestId }
    } else body = [workspace]
  } else if (path.includes("/api/opencode/")) body = { state: "ready", serviceState: "ready" }
  else if (path.endsWith("/worktrees")) body = { isGitRepo: true, worktrees: [{ slug: "root", kind: "root", directory: folder }] }
  else if (path.endsWith("/api/location")) body = { directory: folder, project: { id: "perf", directory: folder, canonical: folder } }
  else if (path.endsWith("/api/project")) body = [{ id: "perf", canonical: folder, vcs: "git", time: { created: 1, updated: 1 }, sandboxes: [] }]
  else if (path.endsWith("/api/mcp")) body = { location: { directory: folder }, data: [] }
  else if (path.endsWith("/api/session")) {
    if (!url.searchParams.has("project") && !url.searchParams.has("cursor")) {
      body = { data: rows.filter(row => !row.parentID).slice(-200), cursor: {} }
    } else {
      const offset = Number(url.searchParams.get("cursor") ?? "0")
      const next = offset + 200
      body = { data: rows.slice(offset, next), cursor: next < rows.length ? { next: String(next) } : {} }
    }
  }
  else if (path.endsWith("/api/session/active")) body = { data: Object.fromEntries(
    rows.slice(-20).filter(row => !row.parentID).map(row => [row.id, {}]),
  ) }
  else if (/\/api\/session\/ses_\d+$/.test(path)) {
    const row = byId.get(path.split("/").at(-1))
    if (Number(row.id.slice(4)) >= 6000) await new Promise(resolve => setTimeout(resolve, 40))
    body = { data: row }
  }
  else if (path.includes("/instance/api/")) body = { data: [], cursor: {} }
  else if (path.startsWith("/api/")) body = path.endsWith("/config/ui") ? { settings: { locale: "en" } } : {}
  if (body !== undefined) {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(body))
    return
  }
  const asset = resolve(root, path === "/" ? "index.html" : `.${path}`)
  try {
    if (!asset.startsWith(root + sep)) throw new Error("Outside the fixture")
    const file = await readFile(asset)
    res.writeHead(200, { "Content-Type": mime[extname(asset)] ?? "application/octet-stream" })
    res.end(file)
  } catch {
    res.writeHead(404)
    res.end()
  }
})
await new Promise(ok => server.listen(0, "127.0.0.1", ok))
let context, activity
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true, serviceWorkers: "block",
    viewport: { width: 1400, height: 950 },
  })
  await context.addInitScript(({ folder, catalog }) => {
    window.__CODENOMAD_RUNTIME_HOST__ = "electron"
    window.__CODENOMAD_WINDOW_CONTEXT__ = "local"
    window.perfCommits = 0
    const snapshot = { version: 1, revision: 1, savedAt: 1, layout: {}, session: { activeTabIndex: 0, tabs: [{
      kind: "workspace", folder, occurrence: 0, activeSessionId: "ses_5998", activeParentSessionId: "ses_5998",
      drafts: {}, attachments: {}, unseenIdleSince: {}, generationRecovery: {}, scrollSnapshots: {}, sessionCatalog: catalog,
    }] } }
    window.electronAPI = {
      claimClientStateAccess: async () => true,
      loadClientState: async () => ({ snapshot, isPrimary: true, restoreEnabled: true, partitionProtocolVersion: 1 }),
      loadClientStatePartition: async () => null,
      commitClientStatePartitions: async () => { window.perfCommits++; return true },
    }
  }, { folder, catalog: rows.map(row => ({ ...row, parentId: row.parentID ?? null, agent: "build", model: { providerId: "p", modelId: "m" } })) })
  const page = context.pages()[0]
  page.on("pageerror", e => console.error(e))
  page.on("console", message => { if (message.type() === "error") console.error(message.text()) })
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "domcontentloaded" })
  await page.locator(".session-item-base").first().waitFor({ timeout: 12000 }).catch(async error => {
    console.error(page.url(), [...requested])
    throw error
  })
  const editor = page.locator("textarea:visible").first()
  await editor.focus({ timeout: 12000 })
  const emit = event => {
    const payload = JSON.stringify({ type: "instance.event", instanceId: workspace.id, event })
    for (const stream of streams) stream.write(`data: ${payload}\n\n`)
  }
  const rename = (sessionID, ordinal, title) => ({
    type: "session.renamed", id: `event-${ordinal}`, created: Date.now(), location: { directory: folder },
    durable: { aggregateID: sessionID, seq: ordinal, version: 1 }, data: { sessionID, title },
  })
  emit(rename("ses_5998", 1, "Fixture ready"))
  await page.locator(".session-item-base").getByText("Fixture ready", { exact: true }).waitFor({ timeout: 12000 })
  assert.equal(await editor.inputValue(), "", "the production composer starts empty")
  await editor.evaluate(input => {
    window.perfKeys = []
    window.perfInputs = []
    input.addEventListener("input", event => window.perfInputs.push([event.inputType, input.value]))
    document.addEventListener("keydown", event => {
      if (event.target !== input || !["a", "Backspace"].includes(event.key)) return
      // Include input, synchronous reactive work and microtasks before the next
      // render opportunity; use every key, unlike Event Timing's 16 ms floor.
      requestAnimationFrame(() => window.perfKeys.push(performance.now() - event.timeStamp))
    }, { capture: true })
  })
  const commitsBefore = await page.evaluate(() => window.perfCommits)
  const finishSample = await sampleSessionList(context, page)
  measuring = true
  let seq = 0
  let presses = Promise.resolve()
  const keyboardErrors = []
  activity = setInterval(() => {
    const ordinal = ++seq
    const sessionID = ordinal % 12 === 0 ? `ses_${6000 + Math.floor(ordinal / 12) % 120}` : `ses_${(ordinal * 283) % 5900}`
    emit(rename(sessionID, ordinal * 2, `Renamed ${ordinal}`))
    if (ordinal % 12 === 0) emit(rename(sessionID, ordinal * 2 + 1, `Renamed twice ${ordinal}`))
    if (ordinal % 3 === 0) presses = presses
      .then(() => page.keyboard.press(ordinal % 6 === 0 ? "Backspace" : "a"))
      .catch(error => { keyboardErrors.push(error) })
  }, 83)
  await new Promise(resolve => setTimeout(resolve, Number(seconds) * 1000))
  clearInterval(activity)
  await presses
  if (keyboardErrors.length) throw new AggregateError(keyboardErrors, "Production composer keyboard presses failed")
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
  measuring = false
  const { tasks, ...report } = await finishSample()
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2))
  await writeFile(join(output, "longtasks.json"), JSON.stringify(tasks, null, 2))
  const counters = { eventTicks: seq, streams: streams.size,
    mockPartitionCommits: await page.evaluate(start => window.perfCommits - start, commitsBefore) }
  const keys = await page.evaluate(() => window.perfKeys.sort((a, b) => a - b))
  const inputs = await page.evaluate(() => window.perfInputs)
  assert.ok(keys.length > 0, "the production composer received keyboard input")
  assert.equal(keys.length, Math.floor(seq / 3), "every scheduled press reached the production composer")
  assert.deepEqual(inputs, Array.from({ length: keys.length }, (_, i) => i % 2
    ? ["deleteContentBackward", ""] : ["insertText", "a"]), "every press changed the composer value as intended")
  assert.equal(await editor.inputValue(), keys.length % 2 ? "a" : "")
  counters.inputCount = inputs.length
  counters.keyToFrame = { count: keys.length, p50: keys[Math.ceil(keys.length * 0.5) - 1],
    p95: keys[Math.ceil(keys.length * 0.95) - 1], max: keys.at(-1) }
  await writeFile(join(output, "fixture.json"), JSON.stringify(counters, null, 2))
  await writeFile(join(output, "session-reads.json"), JSON.stringify(Object.fromEntries(sessionReads), null, 2))
  console.log({ ...counters, ...report, sessionPointReads: [...sessionReads].reduce(
    (count, [url, reads]) => /\/api\/session\/ses_\d+/.test(url) ? count + reads : count, 0) })
} finally {
  clearInterval(activity)
  await context?.close()
  for (const stream of streams) stream.end()
  server.closeAllConnections()
  await new Promise(ok => server.close(ok))
  await rm(profile, { recursive: true, force: true })
}
