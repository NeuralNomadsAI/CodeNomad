import assert from "node:assert/strict"
import { after, afterEach, before, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Page } from "playwright"
import Fastify from "fastify"
import { startProductFixture } from "./fixtures/product-fixture-server"
import { PanelExtensionStore } from "../../../server/src/panel-extensions/store"
import { readPanelExtensionArchive, type PanelExtensionPackage } from "../../../server/src/panel-extensions/archive"
import { fixtureArchive } from "../../../server/src/panel-extensions/archive-fixture"
import { PANEL_EXTENSION_API4_PERMISSIONS } from "../../../server/src/panel-extensions/contract"
import { registerPanelExtensionRoutes } from "../../../server/src/server/routes/panel-extensions"
import { registerPanelExtensionApi4Routes } from "../../../server/src/server/routes/panel-extension-api4"
import { WorktreeDeletionFence } from "../../../server/src/workspaces/worktree-session-evacuation"

// The real host routes, store, bridge, channels and composer; only OpenCode is a fake.
const instanceId = "api4-instance"
const target = { messageID: "msg_a", part: 1, index: 0, digest: "a".repeat(64) }
const ALL = ["session.context", ...PANEL_EXTENSION_API4_PERMISSIONS]
let fixture: Awaited<ReturnType<typeof startProductFixture>>, root: string, store: PanelExtensionStore
const app = Fastify()
const rpc = { calls: [] as Array<{ method: string; input: any }>, hold: undefined as undefined | ((method: string) => Promise<void>),
  references: [] as unknown[], conversation: "ses_images", image: { status: "asset", mime: "image/png", uri: "" } as Record<string, unknown> }
let installed: PanelExtensionPackage | undefined, realPng = ""
const transit = { hold: undefined as undefined | (() => Promise<void>) }

const png = (width: number, height: number) => {
  const bytes = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
  return `data:image/png;base64,${bytes.toString("base64")}`
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "codenomad-api4-browser-"))
  store = new PanelExtensionStore(root)
  const client: any = {
    session: { get: async ({ sessionID }: any) => ({ id: sessionID, location: { directory: "/fixture" }, agent: "build",
      ...(sessionID === "ses_images" ? { metadata: { "codenomad.companion": "images" }, agent: "design" } : {}), time: { updated: 7 } }) },
    location: { get: async ({ location }: any) => ({ directory: location.directory, project: { id: "fixture" } }) },
    agent: { list: async () => ({ data: [{ id: "build" }] }) },
    model: { list: async () => ({ data: [{ providerID: "fixture", id: "chosen", capabilities: { tools: true, input: ["text"], output: ["text"] } }] }),
      default: async () => ({ data: { providerID: "fixture", id: "chosen", capabilities: { tools: true, input: ["text"], output: ["text"] } } }) },
    rpc: { call: async ({ method, input }: any) => {
      rpc.calls.push({ method, input })
      await rpc.hold?.(method)
      if (method === "images") return { output: { status: "page", cursor: null, entries: [{ kind: "image", target, series: "s".repeat(22), time: 1,
        label: input.sessionID, mime: "image/png", origin: "proven" }] } }
      if (method === "imageRead") return { output: rpc.image }
      if (method === "imageReference") return { output: rpc.references.shift() ?? { status: "path", path: ".codenomad/design/icône/图标-a.png" } }
      if (method === "imagesConversation") return { output: input.mode === "lookup" ? { status: "absent" } : { status: "found", sessionID: rpc.conversation, created: true } }
      throw new Error(method)
    } },
  }
  registerPanelExtensionRoutes(app, { store, workspaceManager: { get: id => id === instanceId ? { id, path: "/fixture" } as any : undefined } })
  registerPanelExtensionApi4Routes(app, { store, worktreeDeletionFence: new WorktreeDeletionFence(), excludeDesignFolder: async () => "excluded",
    imageSettings: { read: async () => ({ location: { directory: "/fixture" }, mediaStorage: null, generation: { global: false, effective: false, models: [] } }) },
    workspaceManager: { get: (id: string) => id === instanceId ? { id, path: "/fixture" } as any : undefined,
      getSharedServiceConnection: async () => ({ client, assertCurrent() {} }) as any, getSharedServiceClient: async () => client,
      ownsLocation: async (id: string, location: { directory: string }) => id === instanceId && location.directory === "/fixture",
      desktopPluginsReady: async () => {}, getWorktreeIdentityForPath: async () => "/fixture", getServiceWslDistro: () => undefined,
      getHostPathForServicePath: async (_id: string, value: string) => value } })
  fixture = await startProductFixture("panel-extension-api4")
  const canvas = await fixture.browser.newPage()
  realPng = await canvas.evaluate(() => { const element = document.createElement("canvas"); element.width = 400; element.height = 300; return element.toDataURL("image/png") })
  await canvas.close()
  rpc.image.uri = realPng
})
afterEach(async () => {
  rpc.hold = undefined; transit.hold = undefined; rpc.calls = []; rpc.references = []; rpc.conversation = "ses_images"; rpc.image = { status: "asset", mime: "image/png", uri: realPng }
  if (installed) await store.remove(installed.manifest.id, installed.digest).catch(() => {})
  installed = undefined
})
after(async () => { await fixture?.close(); await app.close(); await rm(root, { recursive: true, force: true }) })

// Author code: exposes each bridge call to the test, never reaching the host otherwise.
const panel = `<p id="ctx"></p><script>
  window.changes = [];
  window.call = (path, ...args) => { const [object, method] = path.split('.');
    return Promise.resolve().then(() => codenomad[object][method](...args)).then(ok => ({ ok }), error => ({ error: error.message })); };
  window.report = (path, ...args) => { void window.call(path, ...args).then(answer => parent.postMessage({ fixtureAnswer: answer }, '*')); };
  window.objects = () => ['images', 'composer', 'conversation', 'preferences', 'assets', 'workItems'].filter(name => codenomad[name]);
  if (codenomad.images) codenomad.images.onChanged(detail => window.changes.push(detail));
  codenomad.onContext(context => { document.querySelector('#ctx').textContent = String(context.sessionId) + ':' + context.apiVersion; });
</script>`

async function install(permissions: string[] = ALL) {
  installed = await readPanelExtensionArchive(fixtureArchive(panel, { apiVersion: 4, permissions }))
  await store.install(installed)
  await store.activate(installed.manifest.id, installed.digest, true)
}
async function open(options: { phone?: boolean } = {}) {
  const page = await fixture.browser.newPage({ viewport: options.phone ? { width: 390, height: 844 } : { width: 1200, height: 800 }, locale: "en-US" })
  const errors: string[] = [], requests: string[] = [], aborted: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("requestfailed", request => { if (request.failure()?.errorText.includes("ABORTED")) aborted.push(new URL(request.url()).pathname) })
  // A steady transport: reconnects would remount the panel.
  await page.addInitScript(() => {
    ;(window as any).EventSource = class { static OPEN = 1; readyState = 1; addEventListener() {} removeEventListener() {} close() {} }
  })
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url())
    if (!url.pathname.startsWith("/api/panel-extensions")) return route.fulfill({ json: { entries: [], files: [], records: [], messages: [], data: [] } })
    requests.push(url.pathname)
    if (url.pathname.endsWith("/images")) await transit.hold?.()
    const response = await app.inject({ method: request.method() as any, url: url.pathname + url.search,
      payload: request.postData() ?? undefined, headers: { "content-type": "application/json" } })
    await route.fulfill({ status: response.statusCode, contentType: "application/json", body: response.body }).catch(() => {})
  })
  await page.goto(`${fixture.url}${options.phone ? "?phone=1" : ""}`)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  return { page, errors, requests, aborted }
}
const frameOf = (page: Page) => page.frameLocator("iframe[title='Session example']")
async function showPanel(page: Page, session = "ses_work") {
  await page.getByRole("tab", { name: "Session example", exact: true }).click()
  await frameOf(page).locator("#ctx").filter({ hasText: `${session}:4` }).waitFor()
}
const call = (page: Page, method: string, ...args: unknown[]) => frameOf(page).locator("body")
  .evaluate((_body, [method, args]) => (window as any).call(method, ...(args as unknown[])), [method, args] as const)
const report = (page: Page, method: string, ...args: unknown[]) => frameOf(page).locator("body")
  .evaluate((_body, [method, args]) => { (window as any).report(method, ...(args as unknown[])) }, [method, args] as const)
const snapshot = (page: Page) => page.evaluate(() => (window as any).fixture.snapshot())
const show = (page: Page, id: string) => page.evaluate(value => (window as any).fixture.show(value), id)
const draft = async (page: Page, text: string) => { await page.locator("textarea.prompt-input").fill(text) }
const pause = (page: Page) => page.waitForTimeout(1050) // one prefill a second per extension

test("the review shows one install sentence per declared permission before the trust checkbox", async () => {
  const { page, errors } = await open()
  try {
    await page.getByRole("button", { name: "Customize right panel", exact: true }).click()
    await page.locator(".panel-extension-disclosure summary").click()
    await page.locator(".panel-extension-manager").waitFor()
    await page.locator('input[type="file"]').setInputFiles({ name: "design.zip", mimeType: "application/zip",
      buffer: fixtureArchive(panel, { apiVersion: 4, permissions: ["session.context", "panel.preferences", "session.images.prompts", "session.images.read"] }) })
    const review = page.locator(".panel-extension-review")
    await review.getByRole("checkbox", { name: "I trust this package and its author" }).waitFor()
    assert.deepEqual(await review.locator(".panel-extension-permissions li").allTextContents(), [
      "Read the images returned by the read tool in the displayed conversation, with generation status and lineage when they can be verified.",
      "Read the prompt and model of each image generated in the project's Images conversation.",
      "Remember this panel's own settings.",
    ])
    const order = await review.evaluate(element => {
      const list = element.querySelector(".panel-extension-permissions")!, trust = element.querySelector("input[type=checkbox]")!
      return Boolean(list.compareDocumentPosition(trust) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    assert.equal(order, true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("only declared permissions expose frame objects; undeclared calls never reach the host", async () => {
  await install(["session.context", "panel.preferences"])
  const { page, requests } = await open()
  try {
    await showPanel(page)
    assert.deepEqual(await frameOf(page).locator("body").evaluate(() => (window as any).objects()), ["preferences"])
    assert.deepEqual((await call(page, "images.status")).error, "Cannot read properties of undefined (reading 'status')")
    assert.deepEqual(requests.filter(value => !value.endsWith("/panel") && value !== "/api/panel-extensions"), [])
  } finally { await page.close() }
})

test("prefill writes the real composer draft with the composer's rules and never sends", async () => {
  await install()
  const { page, errors } = await open()
  try {
    await showPanel(page)
    assert.deepEqual(await call(page, "composer.prefill", { text: "Hello" }), { ok: "added" })
    await page.waitForFunction(() => (window as any).fixture.snapshot().focused)
    let state = await snapshot(page)
    assert.equal(state.draft, "Hello")
    await pause(page)
    assert.deepEqual(await call(page, "composer.prefill", { text: "Refine {{1}} now", refs: [target] }), { ok: "added" })
    assert.equal((await snapshot(page)).draft, "Hello\n\nRefine `.codenomad/design/icône/图标-a.png` now")
    assert.deepEqual(rpc.calls.at(-1), { method: "imageReference", input: { sessionID: "ses_work", target } })
    assert.deepEqual(await call(page, "composer.prefill", { text: "Again" }), { ok: "busy" }, "a second request within the second")
    await pause(page)
    await draft(page, "Line\n")
    assert.deepEqual(await call(page, "composer.prefill", { text: "x".repeat(2049) }), { ok: "too-long" })
    await pause(page)
    assert.deepEqual(await call(page, "composer.prefill", { text: "Next" }), { ok: "added" })
    assert.equal((await snapshot(page)).draft, "Line\n\nNext")

    const invalid: Array<[string, unknown]> = [
      ["/review the diff", { text: "Refine" }], ["/btw why", { text: "Refine" }], ["", { text: "/review" }],
      ["", { text: "Ask @x" }], ["", { text: "Copy (@file" }], ["", { text: "Refine {{1}}" }],
      ["", { text: "Refine", refs: [target] }], ["", { text: "Refine {{2}} {{1}}", refs: [target] }],
    ]
    for (const [existing, input] of invalid) {
      await pause(page); await draft(page, existing)
      assert.deepEqual(await call(page, "composer.prefill", input), { ok: "invalid" }, JSON.stringify([existing, input]))
      assert.equal((await snapshot(page)).draft, existing, "nothing is written")
    }
    assert.deepEqual(await call(page, "composer.prefill", { text: "x", refs: new Array(17).fill(target) }), { ok: "invalid" })
    for (const answer of [{ status: "refused", reason: "unverifiable" }, { status: "refused", reason: "outside" }, { status: "refused", reason: "changed" },
      { status: "refused", reason: "missing" }, { status: "path", path: "a`b.png" }]) {
      await pause(page); await draft(page, "")
      rpc.references = [answer]
      assert.deepEqual(await call(page, "composer.prefill", { text: "Refine {{1}}", refs: [target] }), { ok: "invalid" }, JSON.stringify(answer))
      assert.equal((await snapshot(page)).draft, "")
    }

    // Shell mode is busy; without a displayed conversation there is no session.
    await pause(page)
    await page.locator("textarea.prompt-input").focus()
    await page.keyboard.press("!")
    await page.locator(".prompt-input.shell-mode").waitFor()
    assert.deepEqual(await call(page, "composer.prefill", { text: "ls" }), { ok: "busy" })
    state = await snapshot(page)
    assert.deepEqual([state.prompts, state.commands, state.attachments], [0, 0, 0], "nothing sent, run or attached")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a conversation change during the request writes no draft, one way or round trip", async () => {
  await install()
  const { page } = await open()
  try {
    for (const roundTrip of [false, true]) {
      await show(page, "ses_work"); await showPanel(page)
      await draft(page, "Keep")
      let release!: () => void, started!: () => void
      const admitted = new Promise<void>(resolve => { started = resolve })
      rpc.hold = method => method === "imageReference" ? new Promise<void>(resolve => { release = resolve; started() }) : Promise.resolve()
      const answer = call(page, "composer.prefill", { text: "Refine {{1}}", refs: [target] }).catch(() => ({ error: "detached" }))
      await admitted
      await show(page, "ses_other")
      if (roundTrip) await show(page, "ses_work")
      release()
      rpc.hold = undefined
      assert.ok("error" in await answer)
      await page.waitForTimeout(100)
      await show(page, "ses_work")
      assert.equal((await snapshot(page)).draft, "Keep", `round trip: ${roundTrip}`)
      await pause(page)
    }
  } finally { await page.close() }
})

test("on a phone the prefill answers, closes the panel and focuses the message box", async () => {
  await install()
  const { page, errors } = await open({ phone: true })
  try {
    await showPanel(page)
    await report(page, "composer.prefill", { text: "Draw an icon" })
    await page.waitForFunction(() => { const state = (window as any).fixture.snapshot(); return !state.panelOpen && state.focused })
    const state = await snapshot(page)
    assert.deepEqual([state.draft, state.closed, state.prompts], ["Draw an icon", 1, 0])
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.frameMessages()), [{ ok: "added" }])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a held method fails at the host deadline and is cancelled; late answers never reach another mounting", async () => {
  await install()
  const { page, aborted } = await open()
  try {
    await showPanel(page)
    let releases: Array<() => void> = []
    // Held in transit, after the server: only the host's own deadline can answer.
    transit.hold = () => new Promise<void>(resolve => releases.push(resolve))
    const started = Date.now()
    const held = call(page, "images.list")
    const others = [call(page, "images.list"), call(page, "images.list"), call(page, "images.list")]
    assert.deepEqual(await call(page, "images.list"), { error: "Images unavailable" }, "a fifth concurrent request is refused")
    assert.deepEqual(await held, { error: "Images unavailable" })
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 19_300 && elapsed < 19_950, `answered by the host at ${elapsed} ms`)
    await Promise.all(others)
    await page.waitForFunction(() => true)
    assert.ok(aborted.filter(value => value.endsWith("/images")).length >= 4, `server work cancelled: ${aborted.join()}`)
    transit.hold = undefined
    for (const release of releases.splice(0)) release()
    rpc.hold = () => new Promise<void>(resolve => releases.push(resolve))

    // A late answer to the first mounting never reaches the next one (both restart request ids at 1).
    const old = call(page, "images.list").catch(() => undefined)
    while (!releases.length) await page.waitForTimeout(10)
    const stale = releases.splice(0)
    await show(page, "ses_other"); await showPanel(page, "ses_other")
    const fresh = call(page, "images.list")
    while (!releases.length) await page.waitForTimeout(10)
    for (const release of stale) release()
    await page.waitForTimeout(200)
    rpc.hold = undefined
    for (const release of releases.splice(0)) release()
    assert.equal(((await fresh).ok as any).entries[0].label, "ses_other")
    await old
  } finally { await page.close() }
})

test("images: status at the session's Location, gallery and full-size decode bounds, coalesced invalidations without polling", async () => {
  await install()
  const { page, requests, errors } = await open()
  try {
    await showPanel(page)
    assert.deepEqual((await call(page, "images.status")).ok, { generation: "disabled", imageModels: false, designAgent: "absent", contentVersion: null,
      chatModelSeesImages: false })
    assert.equal(((await call(page, "images.list")).ok as any).entries[0].label, "ses_work")
    assert.deepEqual((await call(page, "images.read", target)).ok, rpc.image)
    assert.equal(((await call(page, "images.read", target, { thumbnail: true })).ok as any).mime, "image/png")
    rpc.image = { status: "asset", mime: "image/png", uri: png(4096, 4096) }
    for (const thumbnail of [false, true]) assert.deepEqual((await call(page, "images.read", target, { thumbnail })).ok, { status: "not-previewable" })
    rpc.image = { status: "blocked", reason: "not-gallery" }
    assert.deepEqual((await call(page, "images.read", target)).ok, { status: "blocked", reason: "not-gallery" })

    const event = (type: string, sessionID?: string) => page.evaluate(([type, sessionID]) => (window as any).fixture.event({ type: "instance.event",
      instanceId: "api4-instance", event: { type, data: sessionID ? { sessionID } : {} } }), [type, sessionID] as const)
    const changes = () => frameOf(page).locator("body").evaluate(() => (window as any).changes.splice(0))
    await changes()
    const statusReads = requests.filter(value => value.endsWith("/imagesStatus")).length
    await page.waitForTimeout(1200)
    assert.equal(requests.filter(value => value.endsWith("/imagesStatus")).length, statusReads, "no polling")
    await event("session.tool.success", "ses_other")
    await event("session.tool.input.delta", "ses_work")
    await page.waitForTimeout(500)
    assert.deepEqual(await changes(), [], "other sessions and streaming deltas do not invalidate")
    await event("session.tool.success", "ses_work"); await event("session.revert.staged", "ses_work"); await event("config.updated")
    await page.waitForTimeout(500)
    assert.deepEqual(await changes(), [{ gallery: true, status: true }], "coalesced")
    for (const type of ["skill.updated", "agent.updated", "credential.updated", "model.updated"]) {
      await event(type)
      await page.waitForTimeout(450)
      assert.deepEqual(await changes(), [{ gallery: false, status: true }], type)
    }

    // Without a displayed conversation: the instance's current Location, an empty gallery.
    await page.evaluate(() => (window as any).fixture.clear())
    await frameOf(page).locator("#ctx").filter({ hasText: "null:4" }).waitFor()
    assert.equal(((await call(page, "images.status")).ok as any).chatModelSeesImages, null)
    assert.deepEqual((await call(page, "images.list")).ok, { status: "page", entries: [], cursor: null })
    assert.deepEqual(await call(page, "composer.prefill", { text: "Hello" }), { ok: "no-session" })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("conversation: status, then open answers the frame before showing the Images conversation with its composer focused", async () => {
  await install()
  const { page, errors } = await open()
  try {
    await showPanel(page)
    assert.deepEqual((await call(page, "conversation.status")).ok,
      { lookup: "absent", imageCount: null, lastUsed: null, displayedIsImages: false, gitExclusion: null })
    await report(page, "conversation.open")
    await page.waitForFunction(() => { const state = (window as any).fixture.snapshot(); return state.active === "ses_images" && state.focused })
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.frameMessages()), [{ ok: { opened: true, created: true } }],
      "the frame got its answer before the navigation removed it")
    const opened = rpc.calls.find(entry => entry.method === "imagesConversation" && entry.input.mode === "open")
    assert.deepEqual(opened?.input, { mode: "open", title: "Images", agent: "design", model: { providerID: "fixture", id: "chosen" } })
    assert.equal((await snapshot(page)).prompts, 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a conversation selected while the opened one hydrates stays selected", async () => {
  await install()
  rpc.conversation = "ses_fresh"
  const { page, errors } = await open()
  try {
    await showPanel(page)
    await page.evaluate(() => (window as any).fixture.holdHydration("ses_fresh"))
    await report(page, "conversation.open")
    await page.waitForFunction(() => (window as any).fixture.hydrationWaiting() > 0)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.frameMessages()), [{ ok: { opened: true, created: true } }])
    await show(page, "ses_other")
    await page.waitForFunction(() => (window as any).fixture.snapshot().active === "ses_other")
    await page.evaluate(() => (window as any).fixture.releaseHydration())
    await page.waitForTimeout(300)
    assert.equal((await snapshot(page)).active, "ses_other", "the later selection wins")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("p95 under one second for status, gallery, reads up to 3 MiB, conversation status/open and prefill", async () => {
  await install()
  const { page } = await open()
  try {
    // An incompressible ~2.5 MiB PNG within the decode bounds.
    rpc.image = { status: "asset", mime: "image/png", uri: await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 840; canvas.height = 840
      const context = canvas.getContext("2d")!, pixels = context.createImageData(840, 840)
      crypto.getRandomValues(pixels.data.subarray(0, 65536)); for (let index = 65536; index < pixels.data.length; index += 65536) pixels.data.copyWithin(index, 0, 65536)
      for (let index = 0; index < pixels.data.length; index++) pixels.data[index] ^= (index * 2654435761) >>> 24
      context.putImageData(pixels, 0, 0); return canvas.toDataURL("image/png")
    }) }
    const bytes = Math.floor(String(rpc.image.uri).split(",")[1]!.length * 3 / 4)
    assert.ok(bytes > 1024 * 1024 && bytes <= 3 * 1024 * 1024, `fixture image of ${bytes} bytes`)
    await showPanel(page)
    const p95 = async (runs: number, run: () => Promise<unknown>, before?: () => Promise<unknown>) => {
      const times: number[] = []
      for (let index = 0; index < runs; index++) {
        await before?.()
        const started = Date.now(), answer = await run() as any
        times.push(Date.now() - started)
        assert.ok(answer.ok, JSON.stringify(answer).slice(0, 200))
      }
      return times.sort((a, b) => a - b)[Math.ceil(runs * 0.95) - 1]!
    }
    const measured: Record<string, number> = {
      status: await p95(20, () => call(page, "images.status")),
      list: await p95(20, () => call(page, "images.list")),
      thumbnail: await p95(20, () => call(page, "images.read", target, { thumbnail: true })),
      full: await p95(20, () => call(page, "images.read", target)),
      conversation: await p95(20, () => call(page, "conversation.status")),
      prefill: await p95(5, () => call(page, "composer.prefill", { text: "Refine {{1}}", refs: [target] }), () => pause(page)),
    }
    const started = Date.now()
    await report(page, "conversation.open")
    await page.waitForFunction(() => (window as any).fixture.snapshot().active === "ses_images")
    measured.open = Date.now() - started
    for (const [name, value] of Object.entries(measured)) assert.ok(value < 1000, `${name} p95 ${value} ms`)
    console.log("API 4 p95 (ms):", JSON.stringify(measured))
  } finally { await page.close() }
})

test("preferences: saved through the real store, kept across mountings, bounded and validated", async () => {
  await install()
  const { page } = await open()
  try {
    await showPanel(page)
    assert.deepEqual(await call(page, "preferences.get"), { ok: {} })
    assert.deepEqual(await call(page, "preferences.set", { imagesPerTurn: 2 }), { ok: "saved" })
    assert.deepEqual(await call(page, "preferences.set", { v: "x".repeat(4096) }), { ok: "too-large" })
    assert.deepEqual(await call(page, "preferences.set", [1]), { ok: "invalid" })
    await show(page, "ses_other"); await showPanel(page, "ses_other")
    assert.deepEqual(await call(page, "preferences.get"), { ok: { imagesPerTurn: 2 } })
    assert.deepEqual(await store.preferences(installed!.manifest.id, installed!.digest), { imagesPerTurn: 2 })
  } finally { await page.close() }
})
