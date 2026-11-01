import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { borrowFixture } from "./fixture-borrow"
import type {} from "./fixtures/file-preview-panel"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
    name: "file-preview-panel",
    routes: [{ path: "/file-preview-panel", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/file-preview-panel.tsx\"></script></body></html>" }],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

async function setup(viewport: { width: number; height: number }) {
  const page = await browser.newPage({ locale: "en-US", viewport })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{
    claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}})`)
  await page.route("**/api/**", route => {
    const pathname = new URL(route.request().url()).pathname
    const location = { directory: "/fixture" }
    if (pathname === "/api/events") return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" })
    if (pathname === "/api/panel-extensions") return route.fulfill({ json: [] })
    if (pathname.endsWith("/worktrees")) return route.fulfill({ json: { isGitRepo: true, worktrees: [{ slug: "root", directory: "/fixture", kind: "root" }] } })
    if (pathname.endsWith("/agent")) return route.fulfill({ json: { location, data: [{ id: "build", name: "build", mode: "primary" }] } })
    if (pathname.endsWith("/provider") || pathname.endsWith("/model")) return route.fulfill({ json: { location, data: [] } })
    if (pathname.endsWith("/model/default")) return route.fulfill({ json: { location, data: null } })
    if (pathname.includes("/message")) return route.fulfill({ json: { data: [], cursor: {} } })
    if (pathname.includes("/form") || pathname.endsWith("/command")) return route.fulfill({ json: { location, data: [] } })
    if (pathname.includes("/session")) return route.fulfill({ json: { data: [], cursor: {} } })
    return route.fulfill({ json: {} })
  })
  await page.goto(url)
  return { page, errors }
}

const toggle = (page: Page) => page.getByRole("button", { name: "Right panel", exact: true })
const eye = (page: Page) => page.getByRole("button", { name: "File preview · README.md", exact: true })
const reader = (page: Page) => page.locator(".workspace-file-view")

async function openReader(page: Page) {
  await eye(page).click()
  await reader(page).getByText("Keep me open.", { exact: true }).waitFor()
  // Mark the mounted reader: one that survives keeps its editor state and position.
  await reader(page).evaluate(element => { element.dataset.mounted = "first" })
}

async function assertSameReader(page: Page) {
  await reader(page).getByText("Keep me open.", { exact: true }).waitFor()
  assert.equal(await reader(page).getAttribute("data-mounted"), "first", "the open reader stays mounted, never recreated")
  assert.equal(await page.evaluate(() => window.filePreviewPanel.target()), "README.md")
  assert.deepEqual(await page.evaluate(() => window.filePreviewPanel.reads()), ["README.md"], "no reread")
}

test("hiding and showing the docked right panel keeps the open file reader", async () => {
  const { page, errors } = await setup({ width: 1600, height: 950 })
  try {
    await openReader(page)
    const width = await reader(page).evaluate(element => element.getBoundingClientRect().width)
    await toggle(page).click()
    await page.waitForFunction(() => document.querySelector("[aria-label='Right panel']")?.getAttribute("aria-expanded") === "false")
    await assertSameReader(page)
    assert.ok(await reader(page).evaluate(element => element.getBoundingClientRect().width) > width, "the reader takes the freed width")
    await toggle(page).click()
    await eye(page).waitFor()
    await assertSameReader(page)
    assert.equal(await page.locator(".workspace-file-view").count(), 1, "showing the panel never duplicates the reader")

    // An explicit close still closes it, with the panel hidden too.
    await toggle(page).click()
    await page.getByRole("button", { name: "Back to conversation", exact: true }).click()
    await reader(page).waitFor({ state: "detached" })
    assert.equal(await page.evaluate(() => window.filePreviewPanel.target()), null)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a window too narrow for the docked panel keeps the reader, and so does widening it again", async () => {
  const { page, errors } = await setup({ width: 1600, height: 950 })
  try {
    await openReader(page)
    await page.setViewportSize({ width: 700, height: 950 })
    await page.waitForFunction(() => document.querySelector("[aria-label='Right panel']")?.getAttribute("aria-expanded") === "false")
    await assertSameReader(page)
    await page.setViewportSize({ width: 1600, height: 950 })
    await eye(page).waitFor()
    await assertSameReader(page)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a reader opened from the floating panel survives its dismissal", async () => {
  const { page, errors } = await setup({ width: 700, height: 900 })
  try {
    await toggle(page).click()
    await openReader(page)
    await page.keyboard.press("Escape")
    await eye(page).waitFor({ state: "detached" })
    await assertSameReader(page)
    await toggle(page).click()
    await eye(page).waitFor()
    await assertSameReader(page)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a conversation change still closes the reader while the panel is hidden", async () => {
  const { page, errors } = await setup({ width: 1600, height: 950 })
  try {
    await openReader(page)
    await toggle(page).click()
    await assertSameReader(page)
    await page.locator(".session-sidebar").getByText("Conversation two", { exact: true }).click()
    await reader(page).waitFor({ state: "detached" })
    assert.equal(await page.evaluate(() => window.filePreviewPanel.target()), null)
    await page.locator(".session-sidebar").getByText("Conversation one", { exact: true }).click()
    await page.waitForTimeout(100)
    assert.equal(await reader(page).count(), 0, "returning to the conversation does not resurrect the reader")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
