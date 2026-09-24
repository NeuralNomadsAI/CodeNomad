import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "worktree-fixture", configureServer(s) {
      s.middlewares.use("/worktree-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/worktree-fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/worktrees.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/worktree-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function prepare(page: Page) {
  page.on("pageerror", error => console.error(error))
  await page.addInitScript(`
    window.nativeCalls = [];
    window.__TAURI__ = { core: { invoke: async (...args) => { window.nativeCalls.push(args) } } };
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async text => { window.copied = text } } });
  `)
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  page.setDefaultTimeout(5000)
}

test("worktree actions use click/keyboard/touch without selecting or moving the session", async () => {
  const context = await browser.newContext({ hasTouch: true })
  const page = await context.newPage()
  try {
    await prepare(page)
    const trigger = page.locator(".selector-trigger")
    await trigger.click()
    const feature = page.getByRole("option", { name: /feature/ })
    await feature.getByRole("button", { name: "Copy path" }).click()
    assert.equal(await page.evaluate(() => (window as any).copied), "/repo/.codenomad/worktrees/feature")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.calls), [])
    await trigger.click()
    const open = page.getByRole("option", { name: /feature/ }).getByRole("button", { name: "Open in file manager" })
    await open.focus()
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => (window as any).nativeCalls.length > 0)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.calls), [])
    await trigger.tap()
    await page.getByRole("option", { name: /feature/ }).getByRole("button", { name: "Delete worktree", exact: true }).tap()
    await page.getByRole("dialog").waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.calls), [])
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(await page.evaluate(() => (window as any).fixture.location()), "/repo")
  } finally { await context.close() }
})

test("background inventory completion updates the selector after an older HTTP response", async () => {
  const page = await browser.newPage()
  try {
    await prepare(page)
    await page.locator(".selector-trigger").click()
    await page.getByRole("option", { name: /feature/ }).waitFor()
    await page.getByRole("option", { name: /feature/ }).focus()
    const focused = await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.key)
    await page.evaluate(() => (window as any).fixture.backgroundUpdate())
    await page.waitForFunction(() => (window as any).fixture.worktrees().some((entry: any) => entry.label === "renamed in background"))
    await page.getByRole("option", { name: /renamed in background/ }).waitFor()
    assert.ok(focused)
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.key), focused)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.calls), [])
    assert.equal(await page.evaluate(() => (window as any).fixture.location()), "/repo")
  } finally { await page.close() }
})

test("selecting the current worktree dismisses the menu without moving the session", async () => {
  const page = await browser.newPage()
  try {
    await prepare(page)
    const trigger = page.locator(".selector-trigger")
    await trigger.click()
    await page.getByRole("option", { name: "Workspace", exact: true }).click()
    await page.getByRole("listbox").waitFor({ state: "hidden" })
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.calls), [])
    await trigger.focus()
    await page.keyboard.press("Enter")
    await page.getByRole("listbox").waitFor()
    await page.keyboard.press("Enter")
    await page.getByRole("listbox").waitFor({ state: "hidden" })
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.calls), [])
  } finally { await page.close() }
})

test("coalesces a refresh burst into one trailing HTTP read", async () => {
  const page = await browser.newPage()
  try {
    await prepare(page)
    assert.equal(await page.evaluate(() => (window as any).fixture.refreshBurst()), 2)
  } finally { await page.close() }
})

test("keeps an inline action focused through a background rename", async () => {
  const page = await browser.newPage()
  try {
    await prepare(page)
    await page.locator(".selector-trigger").click()
    await page.getByRole("option", { name: /feature/ }).getByRole("button", { name: "Copy path", exact: true }).focus()
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Copy path", "inline action must be focusable before refresh")
    await page.evaluate(() => (window as any).fixture.backgroundUpdate())
    const copy = page.getByRole("option", { name: /renamed in background/ }).getByRole("button", { name: "Copy path", exact: true })
    await copy.waitFor()
    assert.equal(await copy.evaluate(element => element === document.activeElement), true, await page.evaluate(() => document.activeElement?.outerHTML))
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => (window as any).copied === "/repo/.codenomad/worktrees/feature")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.calls), [])
  } finally { await page.close() }
})

test("opens cached options before refresh completes and keeps a dismissed menu closed", async () => {
  const page = await browser.newPage()
  try {
    await prepare(page)
    await page.evaluate(() => (window as any).fixture.holdRefresh())
    await page.locator(".selector-trigger").click()
    await page.getByRole("option", { name: /feature/ }).waitFor()
    await page.keyboard.press("Escape")
    await page.getByRole("listbox").waitFor({ state: "hidden" })
    await page.evaluate(() => (window as any).fixture.releaseRefresh())
    assert.equal(await page.locator(".selector-trigger").getAttribute("aria-expanded"), "false")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.calls), [])
  } finally { await page.close() }
})

test("creation uses the selected source and the returned stable worktree ID", async () => {
  const page = await browser.newPage()
  try {
    await prepare(page)
    const trigger = page.locator(".selector-trigger")
    await trigger.click()
    await page.getByRole("option", { name: /feature/ }).locator(".selector-option-label").click()
    await page.waitForFunction(() => (window as any).fixture.calls.length === 1)
    await trigger.click()
    await page.getByRole("option", { name: /Create worktree/ }).click()
    await page.getByRole("textbox").fill("new-feature")
    await page.getByRole("button", { name: "Create and use worktree", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.calls.length === 3)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.calls), [
      { move: "stable-feature-id" }, { create: { slug: "new-feature", fromSlug: "stable-feature-id" } }, { move: "created-stable-id" },
    ])
  } finally { await page.close() }
})

for (const first of ["session", "session-b"]) {
  for (const fail of [false, true]) {
    test(`pending moves survive session switches and remounts: ${first} settles first, failure=${fail}`, async () => {
      const page = await browser.newPage()
      try {
        await prepare(page)
        await page.evaluate(() => (window as any).fixture.holdFamilyMoves())
        const trigger = page.locator(".selector-trigger")
        const select = (id: string) => page.evaluate(id => (window as any).fixture.selectSession(id), id)
        const assertPending = async () => {
          assert.match(await trigger.innerText(), /feature/)
          assert.equal(await trigger.getAttribute("aria-busy"), "true")
          assert.equal(await trigger.isDisabled(), true)
        }
        for (const id of ["session", "session-b"]) {
          await select(id)
          await trigger.click()
          await page.getByRole("option", { name: /feature/ }).locator(".selector-option-label").click()
          await page.getByRole("listbox").waitFor({ state: "hidden" })
          await assertPending()
        }
        await select("session")
        await assertPending()
        await page.evaluate(() => (window as any).fixture.setMounted(false))
        await trigger.waitFor({ state: "detached" })
        await page.evaluate(() => (window as any).fixture.setMounted(true))
        await assertPending()
        await select(first)
        await page.evaluate(({ first, fail }) => (window as any).fixture.releaseFamilyMove(first, fail), { first, fail })
        await page.waitForFunction(() => document.querySelector(".selector-trigger")?.getAttribute("aria-busy") === "false")
        assert.equal(await trigger.isDisabled(), false)
        assert.match(await trigger.innerText(), fail ? /Workspace/ : /feature/)
        const last = first === "session" ? "session-b" : "session"
        await select(last)
        await assertPending()
        await page.evaluate(last => (window as any).fixture.releaseFamilyMove(last), last)
        await page.waitForFunction(() => document.querySelector(".selector-trigger")?.getAttribute("aria-busy") === "false")
        assert.match(await trigger.innerText(), /feature/)
        assert.deepEqual(await page.evaluate(() => (window as any).fixture.moveRequests), ["session", "session-b"])
      } finally { await page.close() }
    })
  }
}

for (const fail of [false, true]) {
  test(`retains the requested worktree while moving and ${fail ? "restores the native location on failure" : "confirms it on success"}`, async () => {
    const page = await browser.newPage()
    try {
      await prepare(page)
      await page.evaluate(fail => (window as any).fixture.holdMove(fail), fail)
      const trigger = page.locator(".selector-trigger")
      await trigger.click()
      await page.getByRole("option", { name: /feature/ }).locator(".selector-option-label").click()
      await page.getByRole("listbox").waitFor({ state: "hidden" })
      assert.match(await trigger.innerText(), /feature/)
      assert.equal(await trigger.isDisabled(), true)
      assert.equal(await trigger.getAttribute("aria-busy"), "true")
      assert.equal(await page.evaluate(() => (window as any).fixture.location()), "/repo", "pending UI does not mutate native placement")
      await page.evaluate(() => (window as any).fixture.releaseMove())
      await page.waitForFunction(() => document.querySelector(".selector-trigger")?.getAttribute("aria-busy") === "false")
      assert.equal(await trigger.isDisabled(), false)
      assert.match(await trigger.innerText(), fail ? /Workspace/ : /feature/)
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.calls), fail ? [] : [{ move: "stable-feature-id" }])
    } finally { await page.close() }
  })
}
