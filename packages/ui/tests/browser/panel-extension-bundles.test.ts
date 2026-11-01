import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

// Real Solid right panel, API 4 channel, iframe and MessagePort. HTTP alone is deterministic.
let browser: Awaited<ReturnType<typeof chromium.launch>>, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "panel-extension-bundles", routes: [{ path: "/fixture",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/panel-extension-api4.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

const sentinels = ["FOREIGN_SESSION_7ce0", "SECRET_TOKEN_96aa", "C:/foreign-project/private.blend", "PRIVATE_RPC_30ad",
  "OWNER_PROOF_0aaa", "REGISTRY_GENERATION_34bf", "FOREIGN_PROJECT_90a1", "FOREIGN_DOCUMENT_64ff", "GLOBAL_COUNT_6137"]
const secrets = { sessionID: sentinels[0], token: sentinels[1], directory: sentinels[2], rpc: sentinels[3] }
const author = `<p id="ctx"></p><pre id="answer"></pre><script>
  window.bundleChanges = []; window.imageChanges = []; window.portMessages = []; window.rawAnswers = [];
  window.addEventListener('message', event => {
    if (event.data?.type !== 'codenomad:init') return;
    window.rawPort = event.ports[0];
    rawPort.addEventListener('message', event => { portMessages.push(event.data); if (event.data.id >= 900) rawAnswers.push(event.data); }); rawPort.start();
  });
  window.call = (method, ...args) => Promise.resolve().then(() => codenomad.bundles[method](...args))
    .then(ok => ({ok}), error => ({error: error.message})).then(answer => { document.querySelector('#answer').textContent = JSON.stringify(answer); return answer; });
  if (codenomad.bundles) codenomad.bundles.onChanged(value => bundleChanges.push({value, frozen: Object.isFrozen(value)}));
  if (codenomad.images) codenomad.images.onChanged(value => imageChanges.push(value));
  codenomad.onContext(value => document.querySelector('#ctx').textContent = String(value.sessionId));
</script>`
const frame = (page: Page) => page.frameLocator('iframe[title="Bundles fixture"]')
const call = (page: Page, method: string, ...args: unknown[]) => frame(page).locator("body")
  .evaluate((_body, [method, args]) => (window as any).call(method, ...args), [method, args] as const)
const raw = (page: Page, messages: unknown[]) => frame(page).locator("body")
  .evaluate((_body, value) => { for (const message of value) (window as any).rawPort.postMessage(message) }, messages)
const message = (id: number, method: string, input: unknown = {}, capability = "bundles") => ({ type: "api4:request", id, capability, method, input })
const event = (page: Page, type: string, sessionID?: string, instanceId = "api4-instance") => page.evaluate(value =>
  (window as any).fixture.event(value), { type: "instance.event", instanceId, event: { type, data: { ...secrets, sessionID } } })
const changes = (page: Page) => frame(page).locator("body").evaluate(() => ({ bundles: (window as any).bundleChanges.splice(0), images: (window as any).imageChanges.splice(0) }))

async function open(permissions = ["bundles.read"], options: { session?: string | null } = {}) {
  const page = await browser.newPage(), errors: string[] = [], consoleArgs: unknown[] = [], consoleReads: Promise<void>[] = []
  const calls: Array<{ method: string; input: any }> = [], aborted: string[] = []
  const response = { status: 200, value: { offers: [] } as unknown, hold: undefined as undefined | (() => Promise<void>) }
  const entry = { manifest: { id: "fixture.bundles", name: "Bundles fixture", version: "1.0.0", author: "Fixture", license: "MIT",
    repository: "https://github.com/fixture/bundles", apiVersion: 4, permissions: ["session.context", ...permissions] }, digest: "b".repeat(64), enabled: true }
  page.on("pageerror", error => errors.push(`${error.message}\n${error.stack ?? ""}`))
  page.on("console", value => { consoleReads.push(Promise.all(value.args().map(arg => arg.evaluate(value =>
    JSON.parse(JSON.stringify(value, (_key, item) => item instanceof Error ? { ...item, name: item.name, message: item.message, stack: item.stack } : item) ?? "null"))))
    .then(args => { consoleArgs.push({ type: value.type(), text: value.text(), args }) })) })
  page.on("requestfailed", request => { if (request.failure()?.errorText.includes("ABORTED")) aborted.push(new URL(request.url()).pathname) })
  await page.addInitScript(() => { (window as any).EventSource = class { static OPEN = 1; readyState = 1; addEventListener() {} removeEventListener() {} close() {} } })
  await page.route("**/api/**", async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    if (pathname === "/api/panel-extensions") return route.fulfill({ json: [entry] })
    if (pathname.endsWith("/panel")) return route.fulfill({ json: { html: author } })
    if (pathname.endsWith("/preferencesGet")) {
      await response.hold?.()
      return route.fulfill({ json: { status: "ok", value: {} } }).catch(() => {})
    }
    if (pathname.includes("/bundles/")) {
      calls.push({ method: pathname.split("/").at(-1)!, input: request.postDataJSON() })
      const status = response.status, value = structuredClone(response.value)
      await response.hold?.()
      await route.fulfill({ status, json: value }).catch(() => {})
      return
    }
    return route.fulfill({ json: { entries: [], files: [], records: [], messages: [], data: [] } })
  })
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  if (options.session === null) await page.evaluate(() => (window as any).fixture.clear())
  else if (options.session) await page.evaluate(id => (window as any).fixture.show(id), options.session)
  await page.getByRole("tab", { name: "Bundles fixture", exact: true }).click()
  await frame(page).locator("#ctx").filter({ hasText: options.session === null ? "null" : options.session ?? "ses_work" }).waitFor()
  const clean = async () => {
    await Promise.all(consoleReads)
    const surfaces = await frame(page).locator("body").evaluate(() => ({ dom: document.body.textContent, ports: (window as any).portMessages,
      bundles: (window as any).bundleChanges, images: (window as any).imageChanges })).catch(() => null)
    const serialized = JSON.stringify({ surfaces, errors, consoleArgs })
    for (const sentinel of sentinels) assert.ok(!serialized.includes(sentinel), `foreign sentinel escaped: ${sentinel}`)
    assert.deepEqual(errors, [])
    assert.deepEqual(await page.evaluate(() => { const value = (window as any).fixture.snapshot(); return [value.prompts, value.commands, value.attachments] }), [0, 0, 0])
  }
  return { page, calls, response, aborted, entry, clean }
}

test("bundles object is frozen, read-only and absent without read; raw manage/inherited names dispatch nothing", async () => {
  for (const permissions of [["panel.preferences"], ["bundles.read"], ["bundles.read", "bundles.manage"]]) {
    const { page, calls, clean } = await open(permissions)
    try {
      const surface = await frame(page).locator("body").evaluate(() => ({ present: Boolean((window as any).codenomad.bundles),
        frozen: Object.isFrozen((window as any).codenomad.bundles), keys: Object.keys((window as any).codenomad.bundles ?? {}) }))
      assert.deepEqual(surface, { present: permissions.includes("bundles.read"), frozen: true,
        keys: permissions.includes("bundles.read") ? ["catalog", "state", "hosts", "onChanged"] : [] })
      const attacks = ["request", "setActive", "installHost", "attach", "detach", "constructor", "__proto__", "toString", "hasOwnProperty"].map((method, index) => message(900 + index, method, secrets))
      if (!permissions.includes("bundles.read")) for (const method of ["catalog", "state", "hosts"]) attacks.push(message(950 + attacks.length, method, method === "hosts" ? { integration: "blender" } : {}))
      await raw(page, attacks)
      await page.waitForTimeout(150)
      const answers = await frame(page).locator("body").evaluate(() => (window as any).rawAnswers)
      assert.equal(answers.length, attacks.length)
      assert.ok(answers.every((answer: any) => answer.error === true))
      await raw(page, [message(1100, "catalog", {}, "constructor"), message(1101, "state", {}, "__proto__")])
      await page.waitForTimeout(50)
      assert.deepEqual(calls, [])
      await clean()
    } finally { await page.close() }
  }
})

test("read methods use captured host selectors, reject author selectors and schema-filter results/errors before the frame", async () => {
  const { page, calls, response, clean } = await open()
  try {
    response.value = { offers: [{ offerID: "opaque-offer", label: "Scene", protocol: "ok", ...secrets }], ...secrets }
    const hosts = await call(page, "hosts", { integration: "blender" })
    // A rejecting strict schema or a stripping schema both keep foreign fields out.
    assert.ok(hosts.error === "Bundles unavailable" || JSON.stringify(hosts) === JSON.stringify({ ok: { offers: [{ offerID: "opaque-offer", label: "Scene", protocol: "ok" }] } }))
    response.value = { offers: [{ offerID: "opaque-offer", label: "Scene", protocol: "ok" }] }
    assert.deepEqual(await call(page, "hosts", { integration: "blender" }), { ok: response.value })
    assert.deepEqual(calls.at(-1), { method: "hosts", input: { instanceId: "api4-instance", digest: "b".repeat(64), sessionID: "ses_work", integration: "blender" } })
    for (const [method, input] of [["catalog", { sessionID: sentinels[0] }], ["state", { directory: sentinels[2] }],
      ["hosts", { integration: "blender", sessionID: sentinels[0] }], ["hosts", { integration: "../blender" }],
      ["hosts", { integration: "A" }], ["hosts", { integration: "a".repeat(33) }], ["hosts", { integration: "constructor", url: "https://example.com" }]] as const) {
      await raw(page, [message(1000 + calls.length, method, input)])
    }
    await page.waitForTimeout(100)
    assert.equal(calls.length, 2, "invalid raw reads make no HTTP request")
    response.status = 429; response.value = secrets
    assert.deepEqual(await call(page, "catalog"), { error: "busy" })
    response.status = 500
    assert.deepEqual(await call(page, "state"), { error: "Bundles unavailable" })
    response.status = 200; response.value = secrets
    assert.deepEqual(await call(page, "state"), { error: "Bundles unavailable" })
    await clean()
  } finally { await page.close() }
})

test("catalog and state publish only their bounded read contracts, with no native aggregate or authority", async () => {
  const { page, response, calls, clean } = await open()
  try {
    const catalog = { state: "stale", fetchedAt: "2026-11-01T00:00:00.000Z", integrations: [{ id: "blender", displayName: "OpenCode for Blender",
      family: "native", summary: { en: "Blender integration" }, app: { name: "Blender", versions: ">=5.2" },
      docs: "https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/blender", catalogStatus: "preview" }] }
    response.value = catalog
    assert.deepEqual(await call(page, "catalog"), { ok: catalog })
    const state = { catalog: { state: "fresh" }, integrations: [{ id: "blender", family: "native", configured: true, scopes: ["global"],
      activation: { global: "enabled", project: "default", effective: "enabled" }, version: "0.2.0", state: "ok",
      status: { version: "0.2.0", host: { state: "ok", appVersion: "5.2.0" }, connection: { offers: 1 } }, attachment: { state: "none" } }] }
    response.value = state
    assert.deepEqual(await call(page, "state"), { ok: state })
    response.value = { ...state, integrations: [{ ...state.integrations[0], status: { ...state.integrations[0]!.status,
      connection: { state: "attached", offers: 1, attachedSessions: 6137 }, ownerProof: sentinels[4] } }] }
    assert.deepEqual(await call(page, "state"), { error: "Bundles unavailable" })
    assert.deepEqual(calls.map(call => call.input.sessionID), ["ses_work", "ses_work", "ses_work"])
    await clean()
  } finally { await page.close() }
})

test("no displayed session: all three methods fail with fixed errors and no HTTP", async () => {
  const { page, calls, clean } = await open(["bundles.read"], { session: null })
  try {
    for (const [method, args] of [["catalog", []], ["state", []], ["hosts", [{ integration: "blender" }]]] as const)
      assert.deepEqual(await call(page, method, ...args), { error: "Bundles unavailable" })
    assert.deepEqual(calls, [])
    await clean()
  } finally { await page.close() }
})

test("the captured Location and exact session move/deletion fence reads before and after HTTP", async () => {
  const { page, calls, response, clean } = await open()
  let release: (() => void) | undefined
  try {
    // A different session's move cannot cancel this mounting's read.
    response.hold = () => new Promise<void>(resolve => { release = resolve })
    const own = call(page, "hosts", { integration: "blender" })
    while (!release) await page.waitForTimeout(10)
    await event(page, "session.moved", "ses_other")
    release(); release = undefined
    assert.deepEqual(await own, { ok: { offers: [] } })

    const stale = call(page, "hosts", { integration: "blender" })
    while (!release) await page.waitForTimeout(10)
    await page.evaluate(() => (window as any).fixture.move("/another-location"))
    release(); release = undefined
    assert.deepEqual(await stale, { error: "Bundles unavailable" }, "old Location response is refused")
    const count = calls.length
    assert.deepEqual(await call(page, "hosts", { integration: "blender" }), { error: "Bundles unavailable" })
    assert.equal(calls.length, count, "changed Location starts no read")
    await page.evaluate(() => (window as any).fixture.move("/fixture"))

    const moved = call(page, "hosts", { integration: "blender" })
    while (!release) await page.waitForTimeout(10)
    await event(page, "session.moved", "ses_work")
    release(); release = undefined
    assert.deepEqual(await moved, { error: "Bundles unavailable" }, "exact session move aborts its read")
    await event(page, "session.deleted", "ses_work")
    assert.deepEqual(await call(page, "hosts", { integration: "blender" }), { error: "Bundles unavailable" })
    assert.equal(calls.length, count + 1, "deleted session starts no read")
    await clean()
  } finally { release?.(); await page.close() }
})

test("four-request shared cap: bridge and raw fifth bundles reads answer busy without queueing", async () => {
  const { page, calls, response, clean } = await open(["bundles.read", "panel.preferences"])
  const releases: Array<() => void> = []
  try {
    response.hold = () => new Promise<void>(resolve => releases.push(resolve))
    await frame(page).locator("body").evaluate(() => { (window as any).held = Promise.all([
      ...Array.from({ length: 3 }, () => (window as any).call("hosts", { integration: "blender" })),
      (window as any).codenomad.preferences.get().then((ok: unknown) => ({ ok })),
    ]) })
    while (releases.length < 4) await page.waitForTimeout(10)
    assert.deepEqual(await call(page, "state"), { error: "busy" })
    await raw(page, [message(900, "catalog")])
    await page.waitForTimeout(80)
    assert.deepEqual(await frame(page).locator("body").evaluate(() => (window as any).rawAnswers), [{ type: "api4:result", id: 900, error: "busy" }])
    assert.equal(calls.length, 3, "the fourth slot belongs to another API 4 capability")
    response.hold = undefined
    for (const release of releases.splice(0)) release()
    assert.deepEqual(await frame(page).locator("body").evaluate(() => (window as any).held), [...Array.from({ length: 3 }, () => ({ ok: { offers: [] } })), { ok: {} }])
    await clean()
  } finally { for (const release of releases) release(); await page.close() }
})

test("bundles state invalidations are fixed, independent of images, scoped and batched over 300 ms without polling", async () => {
  const { page, calls, clean } = await open(["bundles.read", "session.images.read"])
  try {
    await page.waitForTimeout(400); await changes(page)
    await event(page, "rpc.neuralnomads.blender.hosts_changed", undefined, "foreign-instance")
    await event(page, "session.moved", "ses_other")
    await event(page, "rpc.neuralnomads.blender.arbitrary")
    await page.waitForTimeout(400)
    assert.deepEqual(await changes(page), { bundles: [], images: [] })
    await event(page, "rpc.neuralnomads.blender.status_changed")
    await event(page, "rpc.neuralnomads.blender.hosts_changed")
    await page.waitForTimeout(140)
    assert.deepEqual(await changes(page), { bundles: [], images: [] })
    await page.waitForTimeout(220)
    assert.deepEqual(await changes(page), { bundles: [{ value: { kind: "state" }, frozen: true }], images: [] })
    await event(page, "config.updated"); await event(page, "plugin.updated"); await event(page, "session.tool.success", "ses_work")
    await page.waitForTimeout(350)
    assert.deepEqual(await changes(page), { bundles: [{ value: { kind: "state" }, frozen: true }], images: [{ gallery: true, status: true }] })
    for (const type of ["server.connected", "session.moved"]) {
      await event(page, type, "ses_work")
      await page.waitForTimeout(350)
      assert.deepEqual((await changes(page)).bundles, [{ value: { kind: "state" }, frozen: true }], type)
    }
    // The real session dispatcher removes the displayed session on deletion. The new
    // null-session mounting must never receive the old mounting's queued invalidation.
    await event(page, "session.deleted", "ses_work")
    await frame(page).locator("#ctx").filter({ hasText: "null" }).waitFor()
    await page.waitForTimeout(350)
    assert.deepEqual((await changes(page)).bundles, [])
    await page.clock.install()
    await page.clock.fastForward(60_000)
    assert.deepEqual(calls, [], "notifications never fetch automatically")
    await clean()
  } finally { await page.close() }
})

test("pending reads are aborted on session change, digest remount and second navigation, with no late frame publication", async () => {
  for (const transition of ["session", "digest", "navigation"] as const) {
    const { page, response, calls, aborted, entry, clean } = await open()
    const releases: Array<() => void> = []
    try {
      response.hold = () => new Promise<void>(resolve => releases.push(resolve))
      await frame(page).locator("body").evaluate(() => { void (window as any).call("hosts", { integration: "blender" }) })
      while (!calls.length) await page.waitForTimeout(10)
      if (transition === "session") {
        await page.evaluate(() => (window as any).fixture.show("ses_other"))
        await frame(page).locator("#ctx").filter({ hasText: "ses_other" }).waitFor()
      } else if (transition === "digest") {
        entry.digest = "c".repeat(64)
        await page.evaluate(() => (window as any).fixture.changed())
        await page.waitForTimeout(300)
      } else {
        await frame(page).locator("body").evaluate(() => { location.href = "about:blank" })
        await page.locator('iframe[title="Bundles fixture"]').waitFor({ state: "detached" })
      }
      await page.waitForTimeout(150)
      assert.ok(aborted.some(value => value.endsWith("/bundles/hosts")), `${transition}: fetch aborted`)
      response.hold = undefined
      for (const release of releases.splice(0)) release()
      if (transition !== "navigation") {
        assert.deepEqual(await call(page, "hosts", { integration: "blender" }), { ok: { offers: [] } })
        assert.equal(calls.at(-1)!.input.digest, entry.digest)
        assert.equal(calls.at(-1)!.input.sessionID, transition === "session" ? "ses_other" : "ses_work")
      }
      await clean()
    } finally { for (const release of releases) release(); await page.close() }
  }
})
