import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Route } from "playwright"
import type { ViteDevServer } from "vite"
import { startDeviceUploadFixture } from "./fixtures/device-upload-server.mjs"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  ;({ server, url } = await startDeviceUploadFixture())
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function setup(submitOnEnter = true) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, locale: "en-US",
    permissions: ["clipboard-read", "clipboard-write"] })
  const prompts: unknown[] = [], searches: Route[] = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(() => {
    ;(window as any).__CODENOMAD_RUNTIME_HOST__ = "tauri"
    ;(window as any).__CODENOMAD_WINDOW_CONTEXT__ = "local"
  })
  await page.route("**/api/**", route => {
    const target = new URL(route.request().url())
    if (target.pathname.endsWith("/prompt")) {
      prompts.push(route.request().postDataJSON())
      return route.fulfill({ json: { data: {} } })
    }
    if (/\/api\/workspaces\/[^/]+\/files(?:\/search)?$/.test(target.pathname)) {
      searches.push(route)
      return
    }
    return route.fulfill({ json: {} })
  })
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  await page.evaluate(value => (window as any).fixture.submitOnEnter(value), submitOnEnter)
  const input = page.locator("textarea:visible").first()
  const picker = page.locator(".dropdown-surface")
  const waitSearch = async (count: number) => {
    const deadline = Date.now() + 5000
    while (searches.length < count && Date.now() < deadline) await page.waitForTimeout(10)
    assert.equal(searches.length, count)
  }
  const assertDraft = async (draft: string) => {
    await page.waitForTimeout(50)
    assert.equal(await input.inputValue(), draft)
    assert.deepEqual(prompts, [], "no native prompt may be dispatched by picker keys")
    assert.deepEqual(errors, [])
  }
  return { page, input, picker, searches, prompts, errors, waitSearch, assertDraft }
}

for (const submitOnEnter of [true, false]) {
  test(`empty and pending mention results never send, including modifiers (submitOnEnter=${submitOnEnter})`, async () => {
    const f = await setup(submitOnEnter)
    try {
      await f.input.fill("@missing/path")
      await f.picker.waitFor()
      await f.waitSearch(1)
      await f.input.press("Enter")
      await f.assertDraft("@missing/path")
      await f.searches[0].fulfill({ json: [] })
      await f.page.getByText("No results found", { exact: true }).waitFor()
      for (const key of ["Enter", "Shift+Enter", "Control+Enter", "Meta+Enter", "Control+Shift+Enter", "Meta+Shift+Enter"]) {
        await f.input.press(key)
        await f.assertDraft("@missing/path")
        assert.equal(await f.picker.count(), 1)
      }
    } finally { await f.page.close() }
  })
}

test("Ctrl+V extends an ignored picker query without sending; empty-result Enter still cannot send", async () => {
  const f = await setup()
  try {
    await f.input.fill("@missing")
    await f.picker.waitFor(); await f.waitSearch(1)
    await f.searches[0].fulfill({ json: [] })
    await f.page.evaluate(() => navigator.clipboard.writeText("/pasted/path"))
    await f.input.press("Control+v")
    await f.waitSearch(2)
    await f.assertDraft("@missing/pasted/path")
    await f.searches[1].fulfill({ json: [] })
    await f.input.press("Enter")
    await f.assertDraft("@missing/pasted/path")
    await f.input.press("Escape")
    await f.picker.waitFor({ state: "detached" })
    await f.assertDraft("@missing/pasted/path")
    await f.input.press("Enter")
    await f.page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea")?.value === "")
    assert.equal(f.prompts.length, 1, "explicit submission after dismissal remains available")
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("Tab autocomplete and Enter attach a selected file without sending; the next Enter sends", async () => {
  const f = await setup()
  try {
    await f.input.fill("@server")
    await f.picker.waitFor(); await f.waitSearch(1)
    await f.searches[0].fulfill({ json: [{ name: "server.txt", path: "server.txt", type: "file" }] })
    await f.page.getByText("server.txt", { exact: true }).last().waitFor()
    await f.input.press("Tab")
    await f.assertDraft("@server.txt")
    await f.waitSearch(2)
    await f.searches[1].fulfill({ json: [{ name: "server.txt", path: "server.txt", type: "file" }] })
    await f.input.press("Enter")
    await f.picker.waitFor({ state: "detached" })
    await f.assertDraft("@./server.txt ")
    assert.equal(await f.page.evaluate(() => (window as any).fixture.attachments().length), 1)
    await f.input.press("Enter")
    await f.page.waitForFunction(() => (window as any).fixture.attachments().length === 0)
    assert.equal(f.prompts.length, 1)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("an empty command picker swallows Enter rather than submitting the command text", async () => {
  const f = await setup()
  try {
    await f.input.fill("/unknown-command")
    await f.picker.waitFor()
    await f.input.press("Enter")
    await f.assertDraft("/unknown-command")
    await f.input.press("Control+Shift+Enter")
    await f.assertDraft("/unknown-command")
  } finally { await f.page.close() }
})

test("modified Enter cannot send a highlighted file; Shift+Enter retains path-only selection", async () => {
  const f = await setup(false)
  try {
    await f.input.fill("@server")
    await f.picker.waitFor(); await f.waitSearch(1)
    await f.searches[0].fulfill({ json: [{ name: "server.txt", path: "server.txt", type: "file" }] })
    await f.page.getByText("server.txt", { exact: true }).last().waitFor()
    for (const key of ["Control+Enter", "Control+Shift+Enter", "Meta+Enter", "Meta+Shift+Enter"]) {
      await f.input.press(key)
      await f.assertDraft("@server")
      assert.equal(await f.page.evaluate(() => (window as any).fixture.attachments().length), 0)
    }
    await f.input.press("Shift+Enter")
    await f.picker.waitFor({ state: "detached" })
    await f.assertDraft("@./server.txt ")
    assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.attachments().map((a: any) => a.source)),
      [{ type: "text", value: "./server.txt" }])
  } finally { await f.page.close() }
})

test("directory Tab navigation and arrow selection remain available without sending", async () => {
  const f = await setup()
  try {
    await f.input.fill("@docs")
    await f.picker.waitFor(); await f.waitSearch(1)
    await f.searches[0].fulfill({ json: [{ name: "docs", path: "docs", type: "directory" }] })
    await f.page.locator('[data-picker-selected="true"]').waitFor()
    await f.input.press("Tab")
    await f.assertDraft("@docs/")
    await f.waitSearch(2)
    await f.searches[1].fulfill({ json: [
      { name: "a.txt", path: "docs/a.txt", type: "file" },
      { name: "b.txt", path: "docs/b.txt", type: "file" },
    ] })
    await f.page.getByText("b.txt", { exact: true }).last().waitFor()
    await f.input.press("ArrowDown")
    await f.input.press("Enter")
    await f.picker.waitFor({ state: "detached" })
    await f.assertDraft("@./docs/b.txt ")
    assert.equal(await f.page.evaluate(() => (window as any).fixture.attachments()[0].filename), "b.txt")
  } finally { await f.page.close() }
})
