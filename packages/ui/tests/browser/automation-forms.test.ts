import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type BrowserContext, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { MissionMap } from "../../../server/src/api-types"
import { DeveloperCdp, type DeveloperCdpIdentity } from "../../../server/src/developer-cdp"
import { recurrenceSnapshotSchema } from "../../../server/src/missions/recurrence-control-contract"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import type {} from "./fixtures/mission-editor-lifetime"

// The real codenomad.inspect/act controller drives real pages over Chromium's DevTools
// endpoint, exactly as it drives the CodeNomad window (#1008).
let server: ViteDevServer, context: BrowserContext, profile: string, endpoint: string, base: string, windows = 0

const FORM = `<!doctype html><html lang="en"><body><main>
  <label>Title <input id="title" value="Prefilled"></label>
  <label>Notes <textarea id="notes">Old notes</textarea></label>
  <div id="rich" contenteditable="true" role="textbox" aria-label="Rich">Old rich</div>
  <label>Scenario <select id="scenario"><option value="custom">Flexible mission</option><option value="wayfinder">Exploration</option>
    <option value="debug" disabled>Debugging</option></select></label>
  <label>Due <input id="due" type="date"></label>
  <label>Agree <input id="agree" type="checkbox"></label>
</main><script>
  window.events = []
  for (const element of document.querySelectorAll("input, textarea, select, [contenteditable]")) for (const type of ["input", "change"]) {
    element.addEventListener(type, () => window.events.push(type + ":" + element.id + ":" + (globalThis.__codenomadAutomationDepth || 0)))
  }
</script></body></html>`

// Fields an agent must not type into blindly, and inputs with browser-side normalization.
const EDGES = `<!doctype html><html lang="en"><body><main>
  <label>Outside <input id="outside" value="Kept"></label>
  <details><summary>More</summary><label>Hidden <input id="hidden"></label></details>
  <fieldset disabled><label>Locked <input id="locked"></label></fieldset>
  <label>Mail <input id="mail" type="email" value="ab"></label>
  <label>Count <input id="count" type="number" value="12"></label>
  <label>Tint <input id="tint" type="color"></label>
  <label>Volume <input id="volume" type="range" min="0" max="100" step="20" value="40"></label>
  <label>Day <input id="day" type="date" value="2026-01-02"></label>
  <label>Twins <select id="twins"><option value="s1">Same</option><option value="s2">Same</option></select></label>
  <div id="story" contenteditable="true" role="textbox" aria-label="Story"><div>one</div><div>two</div></div>
  <section aria-label="Mission editor"><p>Mission</p></section>
  <dialog id="modal"><label>Modal field <input id="modal-field"></label></dialog>
</main><script>
  window.events = []
  for (const element of document.querySelectorAll("input")) for (const type of ["input", "change"]) element.addEventListener(type, () => window.events.push(type + ":" + element.id))
</script></body></html>`

before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "automation-forms", configureServer(s) {
      s.middlewares.use("/automation-form", (_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(FORM) })
      s.middlewares.use("/automation-edges", (_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(EDGES) })
      s.middlewares.use("/automation-editor", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/automation-editor", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-editor-lifetime.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server)
  await server.listen()
  base = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`
  profile = await mkdtemp(path.join(os.tmpdir(), "codenomad-automation-forms-"))
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined, locale: "en-US",
    args: ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"] })
  let port = ""
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8").catch(() => "")).split(/\r?\n/, 1)[0]
    if (!port) await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(port, "Chromium published its DevTools port")
  endpoint = `http://127.0.0.1:${port}`
})

after(async () => {
  await context?.close()
  await server?.close()
  if (profile) await rm(profile, { recursive: true, force: true })
})

/** A page that identifies as one CodeNomad window, and the controller pinned to it. */
async function open(pathname: string, setup?: (page: Page) => Promise<void>) {
  const windowId = `automation-window-${++windows}`
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  await page.addInitScript(`window.__CODENOMAD_WINDOW_ID__ = ${JSON.stringify(windowId)}`)
  await setup?.(page)
  await page.goto(`${base}${pathname}`)
  const cdp = new DeveloperCdp({ timeoutMs: 10_000 })
  const identity: DeveloperCdpIdentity = { endpoint, runId: `run-${windowId}`, windowId }
  const refFor = async (pattern: RegExp, query?: string) => {
    const { snapshot } = await cdp.inspect(identity, query ? { query } : {})
    const match = new RegExp(`${pattern.source}[^\\n]*?\\[(e\\d+)\\]`).exec(snapshot)
    assert.ok(match, `${pattern} in:\n${snapshot}`)
    return match[1]
  }
  const act = (action: { kind: "click"; ref: string } | { kind: "type"; ref: string; text: string; clear?: boolean } | { kind: "select"; ref: string; values: string[] }) =>
    cdp.act(action.kind === "type" ? { ...identity, ...action, clear: action.clear !== false } : { ...identity, ...action })
  return { page, cdp, identity, refFor, act, close: async () => { cdp.close(); await page.close() } }
}

test("typing replaces a prefilled field by default, clear:false appends, and selects fire input/change like a user", async () => {
  const run = await open("/automation-form")
  try {
    const { page, act, refFor } = run
    const outline = (await run.cdp.inspect(run.identity)).snapshot
    assert.match(outline, /textbox "Title" \[e\d+\] value="Prefilled"/)
    assert.match(outline, /combobox "Scenario" \[e\d+\] value="Flexible mission" collapsed\n {4}- option "Flexible mission" \[e\d+\] selected\n {4}- option "Exploration" \[e\d+\]\n {4}- option "Debugging" \[e\d+\] disabled/)

    const title = await refFor(/textbox "Title"/)
    assert.deepEqual(await act({ kind: "type", ref: title, text: "Mission title" }), { value: "Mission title" })
    assert.deepEqual(await act({ kind: "type", ref: title, text: " suffix", clear: false }), { value: "Mission title suffix" })
    assert.equal(await page.inputValue("#title"), "Mission title suffix")
    assert.deepEqual(await act({ kind: "type", ref: await refFor(/textbox "Notes"/), text: "" }), { value: "" })
    assert.deepEqual(await act({ kind: "type", ref: await refFor(/textbox "Rich"/), text: "New rich" }), { value: "New rich" })
    const due = await refFor(/Date "Due"/)
    assert.deepEqual(await act({ kind: "type", ref: due, text: "2026-10-19" }), { value: "2026-10-19" })
    assert.match((await run.cdp.inspect(run.identity, { ref: due })).snapshot, /^- Date "Due" \[e\d+\][^\n]*$/, "a date field is one line, without its inner spinbuttons")

    const scenario = await refFor(/combobox "Scenario"/)
    await page.evaluate(() => { (window as any).events.length = 0 })
    assert.deepEqual(await act({ kind: "select", ref: scenario, values: ["Exploration"] }), { selected: ["Exploration"] })
    assert.equal(await page.inputValue("#scenario"), "wayfinder")
    assert.deepEqual(await page.evaluate(() => (window as any).events), ["input:scenario:1", "change:scenario:1"],
      "framework handlers see input then change, marked as automation")
    assert.equal(await page.evaluate(() => (globalThis as any).__codenomadAutomationDepth), 0)
    assert.deepEqual(await act({ kind: "select", ref: scenario, values: ["custom"] }), { selected: ["Flexible mission"] }, "values match too")
    await assert.rejects(act({ kind: "select", ref: scenario, values: ["Debugging"] }), /Option "Debugging" of e\d+ is disabled/)
    await assert.rejects(act({ kind: "select", ref: scenario, values: ["Nope"] }), /No option "Nope" in e\d+/)
    await assert.rejects(act({ kind: "select", ref: scenario, values: [] }), /takes exactly one value/)
    await assert.rejects(act({ kind: "type", ref: scenario, text: "x" }), /is not a text field/)
    await assert.rejects(act({ kind: "type", ref: await refFor(/checkbox "Agree"/), text: "x" }), /is not a text field; use click/)
    await assert.rejects(act({ kind: "select", ref: title, values: ["x"] }), /is not a native select/)

    // An option ref is clickable: it picks that option, since the native popup is not in the page.
    assert.deepEqual(await act({ kind: "click", ref: await refFor(/option "Exploration"/, "Scenario") }), { selected: ["Exploration"] })
    assert.match((await run.cdp.inspect(run.identity, { query: "scenario" })).snapshot, /combobox "Scenario" \[e\d+\] value="Exploration"/)
  } finally { await run.close() }
})

test("typing never lands in another field, and normalized inputs keep the browser's value or stay untouched", async () => {
  const run = await open("/automation-edges")
  try {
    const { page, act, refFor } = run
    const outline = (await run.cdp.inspect(run.identity)).snapshot
    assert.match(outline, /slider "Volume" \[e\d+\] value="40"/, "numeric values appear")
    assert.match(outline, /region "Mission editor" \[e\d+\]\n {4}- text "Mission"/, "a region's title does not swallow its text")
    assert.equal((await run.cdp.inspect(run.identity, { query: "value" })).snapshot, "No element matches \"value\"", "query ignores field labels")

    // A focused field is where misdirected native text insertion would land.
    await page.focus("#outside")
    // The ref was seen while its disclosure was open; it closed before typing (#1015 review).
    await page.evaluate(() => { document.querySelector("details")!.open = true })
    const hidden = await refFor(/textbox "Hidden"/)
    await page.evaluate(() => { document.querySelector("details")!.open = false })
    await assert.rejects(act({ kind: "type", ref: hidden, text: "Lost" }), /cannot take focus/)
    await assert.rejects(act({ kind: "type", ref: await refFor(/textbox "Locked"/), text: "Lost" }), /is disabled/)
    assert.equal(await page.evaluate(() => document.activeElement?.id), "outside")
    assert.equal(await page.inputValue("#outside"), "Kept", "nothing was typed into the focused field instead")
    const modalOutside = await refFor(/textbox "Outside"/)
    await page.evaluate(() => (document.getElementById("modal") as HTMLDialogElement).showModal())
    await assert.rejects(act({ kind: "type", ref: modalOutside, text: "Lost" }), /cannot take focus/)
    assert.equal(await page.inputValue("#modal-field"), "", "the dialog's field received nothing")
    await page.evaluate(() => (document.getElementById("modal") as HTMLDialogElement).close())

    assert.deepEqual(await act({ kind: "type", ref: await refFor(/textbox "Mail"/), text: "c", clear: false }), { value: "abc" })
    assert.deepEqual(await act({ kind: "type", ref: await refFor(/spinbutton "Count"/), text: "3", clear: false }), { value: "123" })
    assert.deepEqual(await act({ kind: "type", ref: await refFor(/textbox "Mail"/), text: "x@y.z" }), { value: "x@y.z" }, "clearing works there too")
    // Through its label's text, which designates the labelled control.
    assert.deepEqual(await act({ kind: "type", ref: await refFor(/text "Tint"/), text: "#FF0000" }), { value: "#ff0000" })
    const volume = await refFor(/slider "Volume"/)
    assert.deepEqual(await act({ kind: "type", ref: volume, text: "55" }), { value: "60" }, "ranges snap to their step")
    await page.evaluate(() => { (window as any).events.length = 0 })
    for (const text of ["0x50", " 70", ""]) {
      await assert.rejects(act({ kind: "type", ref: volume, text }), /is not a valid value/, `range ${JSON.stringify(text)}`)
    }
    await assert.rejects(act({ kind: "type", ref: await refFor(/text "Tint"/), text: "" }), /is not a valid value/, "a color has no empty value")
    assert.deepEqual(await act({ kind: "type", ref: await refFor(/textbox "Mail"/), text: "", clear: false }), { value: "x@y.z" })
    assert.deepEqual([await page.inputValue("#volume"), await page.inputValue("#tint")], ["60", "#ff0000"])
    assert.deepEqual(await page.evaluate(() => (window as any).events), [], "refused or unchanged values fire nothing")
    await assert.rejects(act({ kind: "type", ref: await refFor(/Date "Day"/), text: "2026-13-45" }), /"2026-13-45" is not a valid value/)
    assert.equal(await page.inputValue("#day"), "2026-01-02", "an invalid date changes nothing")
    assert.deepEqual(await page.evaluate(() => (window as any).events), [])

    const second = /option "Same" \[(e\d+)\][^\n]*\n\s*- option "Same" \[(e\d+)\]/.exec((await run.cdp.inspect(run.identity, { query: "Twins" })).snapshot)![2]
    await act({ kind: "click", ref: second })
    assert.equal(await page.inputValue("#twins"), "s2", "an option click picks that exact option, not the first with its label")

    assert.deepEqual(await act({ kind: "type", ref: await refFor(/textbox "Story"/), text: " end", clear: false }), { value: "one\ntwo end" })
  } finally { await run.close() }
})

const emptyRecurrence = () => recurrenceSnapshotSchema.parse({ version: 1, projectID: "project", projectCanonical: "/fixture", location: { directory: "/fixture" }, schedules: [] })
const profiles = { coordinator: { agent: "coordinator", model: { providerID: "p", id: "m" } } }

test("an agent fills the real Mission editor: the title is replaced, not concatenated, and the playbook reaches the created mission", async () => {
  const creates: Array<Record<string, unknown>> = [], errors: string[] = []
  const run = await open("/automation-editor", async page => {
    page.on("pageerror", error => errors.push(error.message))
    await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
      claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/storage/config/ui", route => route.fulfill({ json: { settings: { missionProfileDefaults: [{ template: "all", profiles }] } } }))
    let list: MissionMap[] = []
    await page.route("**/api/workspaces/fixture/missions**", route => {
      const request = route.request(), pathname = new URL(request.url()).pathname
      if (request.method() === "GET") return route.fulfill({ json: pathname.endsWith("/missions/recurrence") ? emptyRecurrence()
        : { available: true, projectID: "project", missions: list, generatedAt: 1, discardedEvents: 0 } })
      const body = request.postDataJSON()
      creates.push(body)
      list = [{ version: 1, id: "msn_created", projectID: "project", projectCanonical: "/fixture", title: body.title, objective: body.objective,
        template: body.template, status: "active", runState: "prepared", coordinatorSessionId: "ses_coordinator", revision: 1, createdAt: 1, updatedAt: 1,
        history: [], historyTruncated: false, frontier: [], claims: [], actors: [], tasks: [], reports: [] } as MissionMap]
      return route.fulfill({ json: { mission: list[0] } })
    })
  })
  try {
    const { page, act, refFor } = run
    await act({ kind: "click", ref: await refFor(/button "Create mission"/, "Create mission") })
    await act({ kind: "type", ref: await refFor(/textbox "What should the mission do\?"/, "What should the mission do?"), text: "Chart the module seams" })
    const title = await refFor(/textbox "Title"/, "Title")
    await act({ kind: "type", ref: title, text: "First draft" })
    assert.deepEqual(await act({ kind: "type", ref: title, text: "Seam survey" }), { value: "Seam survey" }, "a second type replaces the first")
    assert.deepEqual(await act({ kind: "type", ref: title, text: " (pilot)", clear: false }), { value: "Seam survey (pilot)" })
    await act({ kind: "click", ref: await refFor(/DisclosureTriangle "Options"/, "Options") })
    assert.deepEqual(await act({ kind: "select", ref: await refFor(/combobox "Playbook"/, "Playbook"), values: ["Exploration"] }), { selected: ["Exploration"] })
    assert.match((await run.cdp.inspect(run.identity, { query: "Playbook" })).snapshot, /combobox "Playbook" \[e\d+\] value="Exploration"/)
    await page.waitForFunction(() => !(document.querySelector('form.mission-editor button[type="submit"]') as HTMLButtonElement)?.disabled)
    await act({ kind: "click", ref: await refFor(/button "Create"(?= \[)/, "Create") })
    await page.waitForFunction(() => document.querySelector("form.mission-editor") === null)
    assert.equal(creates.length, 1)
    assert.deepEqual([creates[0].title, creates[0].objective, creates[0].template], ["Seam survey (pilot)", "Chart the module seams", "wayfinder"])
    assert.deepEqual(errors, [])
  } finally { await run.close() }
})
