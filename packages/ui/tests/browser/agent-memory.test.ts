import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page, type Route } from "playwright"
import type { MemoryUIEntry } from "../../../server/src/api-types"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { fixtureEventStream } from "./fixture-event-stream"
import { runWithDiagnosticCleanup } from "./fixture-diagnostic-boundary"
import { agentMemoryMessages as en } from "../../src/lib/i18n/messages/en/agent-memory"

let browser: Browser, url: string, events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({ name: "agent-memory", routes: [{ path: "/fixture", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/agent-memory.tsx"></script></body></html>' }] })
  url = fixture.url
  let ready = false
  await runWithDiagnosticCleanup({ run: async () => {
    events = await fixtureEventStream(url)
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
    armFixtureNavigationBudget(browser)
    ready = true
  }, diagnose: async () => {}, cleanup: async () => {
    if (!ready) { try { await browser?.close() } finally { await events?.close() } }
  }, onObservationError: () => console.error("memory-startup-observation-failed"), onCleanupError: () => console.error("memory-startup-cleanup-failed") })
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })
const entry = (id: string, title: string, extra: Partial<MemoryUIEntry> = {}): MemoryUIEntry => ({
  id, title, text: `Useful text for ${title}`, type: "fact", createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-01T10:00:00Z",
  sessionId: "ses_agent", revision: "a".repeat(64), flagged: false, ...extra,
})
const observedAt = "2026-11-06T10:00:00Z"
const card = (page: Page) => page.locator("#agent-memory")
const title = (page: Page) => page.getByRole("textbox", { name: en["settings.memory.entryTitle"], exact: true })
const text = (page: Page) => page.getByRole("textbox", { name: en["settings.memory.text"], exact: true })
const scope = (page: Page) => page.getByRole("combobox", { name: en["settings.memory.scope"] })
const save = (page: Page) => page.getByRole("button", { name: en["settings.memory.save"], exact: true })
async function setup(page: Page, initial = true) {
  let enabled = initial, writeError: string | undefined, listError: string | undefined, settingFailure = false, frontier = observedAt
  let hold: ((route: Route) => Promise<void>) | undefined
  let inventory = [
    { id: "project-a", path: "C:/project-a", status: "ready" },
    { id: "project-b", path: "C:/project-b", status: "ready" },
  ]
  const data: Record<string, MemoryUIEntry[]> = { global: [entry("global", "Global memory")], "project-a": [entry("a", "Project A")], "project-b": [entry("b", "Project B")] }
  const requests: any[] = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path === "/api/workspaces") return route.fulfill({ json: inventory })
    if (path === "/api/memory/settings") {
      if (request.method() === "PUT") {
        const next = request.postDataJSON().enabled; requests.push({ enabled: next })
        if (settingFailure) return route.fulfill({ status: 503, json: { code: "unreadable" } })
        enabled = next
      }
      return route.fulfill({ json: { enabled } })
    }
    if (path !== "/api/memory") return route.fulfill({ json: {} })
    const body = request.postDataJSON(), operation = body.operation
    requests.push(body)
    const key = operation.scope === "global" ? "global" : body.context.workspaceId
    if (operation.action === "list") {
      if (hold) { const handler = hold; hold = undefined; return handler(route) }
      return listError ? route.fulfill({ status: 503, json: { code: listError } }) : route.fulfill({ json: { entries: data[key] ?? [], scopeKey: key, observedAt: frontier } })
    }
    if (writeError) return route.fulfill({ status: 409, json: { code: writeError, titles: writeError === "full" ? ["Stored title"] : undefined } })
    const current = data[key].find(value => value.id === operation.id)!
    assert.equal(operation.revision, current.revision)
    if (operation.action === "delete") { data[key] = data[key].filter(value => value.id !== operation.id); return route.fulfill({ json: { deleted: true } }) }
    Object.assign(current, operation.content, { revision: "b".repeat(64), updatedAt: observedAt })
    return route.fulfill({ json: { id: current.id, revision: current.revision, flagged: current.flagged } })
  })
  await events.route(page)
  return { data, requests, errors, writeError: (value?: string) => { writeError = value }, listError: (value?: string) => { listError = value },
    settingFailure: (value: boolean) => { settingFailure = value }, frontier: (value: string) => { frontier = value },
    hold: (value: (route: Route) => Promise<void>) => { hold = value }, inventory: (value: typeof inventory) => { inventory = value } }
}
async function open(page: Page) {
  await page.goto(url)
  await page.getByRole("button", { name: /Project A/ }).waitFor()
  assert.equal(await scope(page).inputValue(), "project")
}
test("disabled memory shows only the activation card and makes no entry reads", async () => {
  const page = await browser.newPage(), f = await setup(page, false)
  try {
    await page.goto(url)
    await page.waitForFunction(() => !(document.querySelector("#agent-memory input[role=switch]") as HTMLInputElement)?.disabled)
    assert.equal(await page.getByRole("switch").isChecked(), false)
    assert.equal(await scope(page).count(), 0)
    assert.equal(f.requests.length, 0)
    f.settingFailure(true)
    await page.getByRole("switch").click()
    await page.getByRole("alert").getByText(en["settings.memory.error.unavailable"], { exact: true }).waitFor()
    assert.equal(await page.getByRole("switch").isChecked(), false)
    assert.equal(f.requests.some(value => value.operation), false)
    f.settingFailure(false)
    await page.getByRole("switch").click()
    await page.getByRole("button", { name: /Project A/ }).waitFor()
    assert.deepEqual(f.requests.filter(value => "enabled" in value), [{ enabled: true }, { enabled: true }])
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})
test("badges use a frozen server frontier, prefer New and advance only after successful reads", async () => {
  const page = await browser.newPage(), f = await setup(page)
  f.data["project-a"] = [entry("new", "New item", { createdAt: "2026-11-05T10:00:00Z", updatedAt: "2026-11-05T11:00:00Z" }),
    entry("modified", "Modified item", { updatedAt: "2026-11-05T11:00:00Z" })]
  await page.addInitScript(() => localStorage.setItem("codenomad.memory.seen.project-a", String(Date.parse("2026-11-01T00:00:00Z"))))
  try {
    await page.goto(url)
    const newItem = page.getByRole("button", { name: /New item/ }), modified = page.getByRole("button", { name: /Modified item/ })
    await newItem.waitFor()
    assert.equal(await newItem.getByText("New", { exact: true }).count(), 1)
    f.frontier("2026-11-07T10:00:00Z"); f.listError("unreadable")
    await page.evaluate(() => (window as any).fixture.event({ type: "memory.changed" }))
    await page.getByRole("alert").getByText(en["settings.memory.error.unreadable"], { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => Number(localStorage.getItem("codenomad.memory.seen.project-a"))), Date.parse(observedAt))
    f.listError(); await page.getByRole("button", { name: "Try again", exact: true }).click()
    await page.getByRole("alert").waitFor({ state: "detached" })
    assert.equal(await newItem.getByText("New", { exact: true }).count(), 1)
    assert.equal(await newItem.getByText("Modified", { exact: true }).count(), 0)
    assert.equal(await modified.getByText("Modified", { exact: true }).count(), 1)
    assert.equal(await page.evaluate(() => Number(localStorage.getItem("codenomad.memory.seen.project-a"))), Date.parse("2026-11-07T10:00:00Z"))
    await page.evaluate(() => (window as any).fixture.event({ type: "memory.changed" }))
    await newItem.waitFor()
    assert.equal(await newItem.getByText("New", { exact: true }).count(), 1)
    await page.evaluate(() => (window as any).fixture.mount(false))
    await page.evaluate(() => (window as any).fixture.mount(true))
    await newItem.waitFor()
    assert.equal(await newItem.getByText("New", { exact: true }).count(), 0)
  } finally { await page.close() }
})
test("native fields validate Unicode lengths without truncation and protect dirty drafts", async () => {
  const page = await browser.newPage(), f = await setup(page)
  try {
    await open(page); await page.getByRole("button", { name: /Project A/ }).click()
    assert.equal(await save(page).isDisabled(), true)
    await title(page).fill("😀".repeat(61))
    assert.equal(await title(page).inputValue(), "😀".repeat(61))
    assert.equal(await title(page).getAttribute("aria-invalid"), "true")
    assert.equal(await save(page).isDisabled(), true)
    await title(page).fill("😀".repeat(60)); await text(page).fill("字".repeat(2001))
    assert.equal(await text(page).getAttribute("aria-invalid"), "true")
    await text(page).fill("Edited draft")
    await scope(page).selectOption("global")
    await page.getByRole("dialog").waitFor()
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(await scope(page).inputValue(), "project")
    assert.equal(await text(page).inputValue(), "Edited draft")
    await page.evaluate(() => { void (window as any).fixture.leave() })
    await page.getByRole("dialog").waitFor()
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(await text(page).inputValue(), "Edited draft")
    await save(page).click()
    await page.waitForFunction(() => (document.querySelector("#agent-memory button[type=submit]") as HTMLButtonElement)?.disabled)
    assert.equal(f.requests.filter(value => value.operation?.action === "save").length, 1)
    assert.equal(await text(page).inputValue(), "Edited draft")
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})
test("conflict retains draft and revision until explicit reload; flagged entries remain reviewable", async () => {
  const page = await browser.newPage(), f = await setup(page)
  f.data["project-a"][0].flagged = true
  try {
    await open(page)
    await page.getByRole("button", { name: /Project A.*Needs review/ }).click()
    await page.getByText(en["settings.memory.excluded"], { exact: true }).waitFor()
    assert.equal(await page.getByText(en["settings.memory.warning"], { exact: true }).count(), 0)
    await text(page).fill("Safe draft")
    f.writeError("conflict")
    await save(page).click()
    await page.getByRole("alert").getByText(en["settings.memory.error.conflict"], { exact: true }).waitFor()
    assert.equal(await text(page).inputValue(), "Safe draft")
    assert.equal(await save(page).isDisabled(), true)
    await page.evaluate(() => (window as any).fixture.event({ type: "memory.changed" }))
    await page.getByRole("alert").getByText(en["settings.memory.error.conflict"], { exact: true }).waitFor()
    assert.equal(await save(page).isDisabled(), true)
    await page.getByRole("button", { name: "Reload", exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: "Discard", exact: true }).click()
    await title(page).waitFor({ state: "detached" })
    assert.equal(f.requests.filter(value => value.operation?.action === "save").length, 1)
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})
test("replaced/deleted contexts fence late memory replies and preserve their own draft", async () => {
  const page = await browser.newPage(), f = await setup(page)
  let release!: () => void, reached!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { reached = resolve })
  try {
    await open(page); await page.getByRole("button", { name: /Project A/ }).click(); await text(page).fill("A draft")
    f.hold(async route => { reached(); await gate; await route.fulfill({ json: { entries: [entry("stale", "Stale A")], scopeKey: "project-a", observedAt } }) })
    await page.evaluate(() => (window as any).fixture.event({ type: "memory.changed" })); await started
    await page.evaluate(() => (window as any).fixture.context({ instanceId: "project-b", workspacePath: "C:/project-b", location: { directory: "/repo-b" } }))
    await page.getByRole("button", { name: /Project B/ }).waitFor()
    release()
    await page.getByRole("button", { name: /Project B/ }).click()
    assert.equal(await title(page).inputValue(), "Project B")
    assert.equal(await page.getByRole("button", { name: /Stale A/ }).count(), 0)
    await page.evaluate(() => (window as any).fixture.context({ instanceId: "project-a", workspacePath: "C:/project-a", location: { directory: "/repo-a" } }))
    await text(page).waitFor()
    assert.equal(await text(page).inputValue(), "A draft")
    await page.evaluate(() => (window as any).fixture.event({ type: "workspace.stopped", workspaceId: "project-a", reason: "deleted" }))
    await page.getByText(en["settings.memory.noProject"], { exact: true }).waitFor()
    assert.equal(await title(page).count(), 0)
    assert.equal(await page.getByRole("button", { name: /Project B/ }).count(), 0)
    assert.equal(f.requests.filter(value => value.operation?.scope === "project").every(value => value.context.workspaceId && value.context.directory), true)
    assert.deepEqual(f.errors, [])
  } finally { release?.(); await page.close() }
})
test("scope errors are explicit, never empty, and retained snapshots become read-only", async () => {
  const page = await browser.newPage(), f = await setup(page)
  try {
    f.listError("malformed"); await page.goto(url)
    await page.waitForFunction(() => (document.querySelector("#agent-memory select") as HTMLSelectElement)?.value === "project")
    await page.getByRole("alert").getByText(en["settings.memory.error.malformed"], { exact: true }).waitFor()
    assert.equal(await page.getByText(en["settings.memory.empty"], { exact: true }).count(), 0)
    assert.equal(await page.getByText("0/200", { exact: true }).count(), 0)
    f.listError(); await page.getByRole("button", { name: "Try again", exact: true }).click()
    await page.getByRole("button", { name: /Project A/ }).click(); await text(page).fill("Draft")
    f.listError("git_unavailable"); await page.evaluate(() => (window as any).fixture.event({ type: "memory.changed" }))
    await page.getByRole("alert").getByText(en["settings.memory.error.git_unavailable"], { exact: true }).waitFor()
    assert.equal(await text(page).inputValue(), "Draft"); assert.equal(await text(page).isDisabled(), true)
    f.listError(); await page.getByRole("button", { name: "Try again", exact: true }).click()
    await page.getByRole("alert").waitFor({ state: "detached" })
    f.writeError("full"); await save(page).click()
    await page.getByRole("alert").getByText(en["settings.memory.error.full"], { exact: true }).waitFor()
    await page.getByText("Stored title", { exact: true }).waitFor()
  } finally { await page.close() }
})
test("Forget uses the action menu, Cancel gets focus and successful deletion restores scope focus", async () => {
  const page = await browser.newPage(), f = await setup(page)
  try {
    await open(page); await page.getByRole("button", { name: /Project A/ }).click()
    assert.equal(await card(page).locator(".action-overflow-trigger").count(), 1, await card(page).innerHTML())
    assert.equal(await card(page).locator(".action-overflow-trigger").getAttribute("aria-label"), "Actions for Project A")
    await page.getByRole("button", { name: "Actions for Project A", exact: true }).click()
    await page.getByRole("menuitem", { name: "Forget", exact: true }).click()
    const dialog = page.getByRole("dialog")
    await dialog.waitFor()
    assert.equal(await dialog.getByRole("button", { name: "Cancel", exact: true }).evaluate(element => element === document.activeElement), true)
    await dialog.getByRole("button", { name: "Forget", exact: true }).click()
    await page.getByText(en["settings.memory.empty"], { exact: true }).waitFor()
    assert.equal(await scope(page).evaluate(element => element === document.activeElement), true)
    assert.equal(f.requests.filter(value => value.operation?.action === "delete").length, 1)
  } finally { await page.close() }
})
test("ten locales have the same labels; Hebrew layout keeps fields and actions inside the viewport", async () => {
  for (const locale of ["fr", "de", "es", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) {
    const { agentMemoryMessages } = await import(`../../src/lib/i18n/messages/${locale}/agent-memory.ts`)
    assert.deepEqual(Object.keys(agentMemoryMessages).sort(), Object.keys(en).sort(), locale)
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 850 } }), f = await setup(page)
  try {
    await page.goto(`${url}?locale=he`); await page.getByRole("button", { name: /Project A/ }).click()
    assert.equal(await page.locator("html").getAttribute("dir"), "rtl")
    for (const element of await card(page).locator("input, textarea, select, button").all()) {
      const rect = await element.boundingBox()
      // The native switch's checkbox is intentionally visually hidden.
      if (await element.getAttribute("role") === "switch") continue
      assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= 391, await element.evaluate(node => node.outerHTML))
    }
    assert.equal((await card(page).innerText()).includes("settings.memory."), false)
    assert.deepEqual(f.errors, [])
  } finally { await page.close() }
})
