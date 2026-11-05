import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  ;({ url } = await borrowFixture({ name: "multiserver-capabilities", routes: [{ path: "/capabilities", html: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/multiserver-capabilities.tsx"></script></body></html>' }] }))
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

async function setup(native = false) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: "en-US", hasTouch: true })
  const errors: string[] = [], requests: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const bootError = new Promise<never>((_resolve, reject) => page.once("pageerror", reject))
  void bootError.catch(() => {})
  if (native) await page.addInitScript({ content: `
    window.__CODENOMAD_RUNTIME_HOST__ = "electron";
    window.__CODENOMAD_WINDOW_CONTEXT__ = "local";
    window.nativeCalls = 0;
    window.electronAPI = { setWorkspaceMenuEnabled: async () => ({}), openWorkspaceTarget: async () => { window.nativeCalls++ } };
  ` })
  await page.route("**/api/**", route => { requests.push(new URL(route.request().url()).pathname); return route.fulfill({ json: {} }) })
  await page.goto(url)
  await Promise.race([page.waitForFunction(() => Boolean((window as any).fixture)), bootError])
  return { page, errors, requests }
}

// prototype-1236: native read-only panels (Files, Changes, shells, Yolo, Usage, Plugins) are open on explicit
// servers; every host reader, write surface and deferred integration stays excluded before construction.
const HOST_ONLY = ["worktrees", "missions", "goal", "prune", "frame", "fetchGitHistory", "fetchGitCommit", "fetchGitCommitDiff",
  "initializeWorkspaceGit", "createWorktree", "writeWorkspaceFile", "stageWorktreeGitPaths", "commitWorktreeGitChanges", "native-git"]

test("explicit shells exclude deferred readers before construction and local Files remains functional", async () => {
  const f = await setup()
  try {
    assert.equal(await f.page.evaluate(() => (window as any).fixture.preferredTab()), "files", "an admission fallback must not overwrite the local preference")
    for (const id of ["A", "B"]) {
      await f.page.evaluate(id => (window as any).fixture.select(id), id)
      const owner = f.page.locator(`[data-owner="${id}"]`)
      assert.equal(await owner.locator('[role="tab"][data-tab-id="missions"]').count(), 0)
      assert.equal(await owner.locator(".mission-control, .project-capability-notice").count(), 0)
      assert.equal(await owner.getByRole("button", { name: /^Delete$|Remove tools and reasoning from this response/ }).count(), 0)
      await owner.locator('[data-tab-id="status"]').click()
      await f.page.evaluate(async id => {
        await (window as any).fixture.forced(id)
        ;(window as any).fixture.executeUnavailable()
        ;(window as any).fixture.rotate(id)
        ;(window as any).fixture.mismatch(id)
      }, id)
      assert.equal(await owner.locator('[role="tab"][data-tab-id="files"], iframe').count(), 0, "a mismatched source closes the native panels too")
    }
    const explicitCalls = await f.page.evaluate(() => (window as any).fixture.calls().filter((call: any) => call.id !== "local-shared").map((call: any) => call.method))
    assert.deepEqual(explicitCalls.filter((method: string) => HOST_ONLY.includes(method)), [], explicitCalls.join(","))
    assert.equal(f.requests.some(path => /opencode-servers|worktrees(?!\/root\/git-(?:status|diff))|\/missions|session-goal|git-history|git-init|git-stage|git-commit|plugin-sources/.test(path)), false, f.requests.join("\n"))
    assert.equal(await f.page.evaluate(() => (window as any).fixture.preferredTab()), "status", "an explicit user selection remains a shared preference")
    await f.page.evaluate(() => (window as any).fixture.select("local-shared"))
    const local = f.page.locator('[data-owner="local-shared"]')
    await local.locator('[data-tab-id="files"]').click()
    await local.getByText("local.txt", { exact: true }).waitFor()
    assert.ok(await f.page.evaluate(() => (window as any).fixture.calls().some((call: any) => call.id === "local-shared" && call.method === "files")))
    await f.page.evaluate(() => (window as any).fixture.preview("local-shared", "workspace"))
    await local.locator('[data-tab-id="status"]').click()
    await local.locator('[data-tab-id="files"]').click()
    assert.equal(await f.page.evaluate(() => (window as any).fixture.filePreview("local-shared")?.path), "local.txt")
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("an explicit project shows Files, Changes and its Status panels like a local one, read-only", async () => {
  const f = await setup()
  try {
    await f.page.evaluate(() => (window as any).fixture.select("A"))
    const owner = f.page.locator('[data-owner="A"]')
    await owner.locator('[data-tab-id="files"]').click()
    await owner.getByText("A-remote.txt", { exact: true }).waitFor()
    await owner.getByRole("button", { name: "Changes", exact: true }).click()
    await owner.getByText("A-change.ts").waitFor()
    await owner.getByText("A-branch", { exact: true }).waitFor()
    assert.equal(await owner.getByRole("button", { name: "Commits", exact: true }).count(), 0)
    assert.equal(await owner.getByText("Staged Changes", { exact: true }).count(), 0)
    assert.equal(await owner.locator(".git-change-commit-input, .git-init-button").count(), 0)
    await f.page.evaluate(() => (window as any).fixture.preview("A", "workspace"))
    await owner.locator(".workspace-file-view").waitFor()
    assert.equal(await owner.locator('.workspace-file-view [aria-label="Save"]').count(), 0)
    await owner.locator('[data-tab-id="status"]').click()
    for (const name of ["Yolo Mode", "Usage", "Background Shells", "Plugins"]) {
      await owner.getByRole("button", { name, exact: true }).waitFor()
    }
    const calls = await f.page.evaluate(() => (window as any).fixture.calls().filter((call: any) => call.id === "A").map((call: any) => call.method))
    for (const method of ["files", "fetchWorktreeGitStatus", "branch"]) assert.ok(calls.includes(method), `${method}: ${calls.join(",")}`)
    assert.deepEqual(calls.filter((method: string) => HOST_ONLY.includes(method)), [])
    // A local project keeps its full Git surface.
    await f.page.evaluate(() => (window as any).fixture.select("local-shared"))
    const local = f.page.locator('[data-owner="local-shared"]')
    await local.locator('[data-tab-id="files"]').click()
    await local.getByRole("button", { name: "Commits", exact: true }).waitFor()
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("local native technical cleanup remains functional after the explicit controls are excluded", async () => {
  const f = await setup()
  try {
    await f.page.getByText("Technical response", { exact: true }).waitFor()
    assert.equal(await f.page.locator('[data-owner="A"]').getByRole("button", { name: /^Delete$/ }).count(), 0)
    await f.page.evaluate(() => (window as any).fixture.select("local-shared"))
    const local = f.page.locator('[data-owner="local-shared"]')
    await local.getByText("Technical response", { exact: true }).waitFor()
    await local.getByRole("button", { name: /^Delete$/ }).first().click()
    await f.page.waitForFunction(() => (window as any).fixture.calls().some((call: any) => call.id === "local-shared" && call.method === "prune"))
    assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.calls().filter((call: any) => call.id !== "local-shared" && ["prune", "message-get"].includes(call.method))), [])
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("palette excludes unavailable commands; forced handlers, menus and hotkeys stay silent with a local positive control", async () => {
  const f = await setup(true)
  try {
    const registration = await f.page.evaluate(() => (window as any).fixture.commandRegistration())
    assert.equal(registration.native, true)
    assert.ok(registration.ids.includes("open-workspace-folder"))
    await f.page.evaluate(() => (window as any).fixture.prefs({ hotkeyOverrides: { "open-workspace-folder": [{ key: "y", mod: true, alt: true }] } }))
    await f.page.keyboard.press("Control+Shift+P")
    assert.equal(await f.page.evaluate(() => (window as any).fixture.paletteIsOpen("A")), true)
    for (const label of ["Open Project Folder", "Remove Session Tools and Reasoning"]) {
      assert.equal(await f.page.getByRole("button", { name: new RegExp(label) }).count(), 0)
    }
    const feedback = await f.page.evaluate(() => (window as any).fixture.feedback())
    await f.page.evaluate(() => (window as any).fixture.executeUnavailable())
    await f.page.keyboard.press("Escape")
    await f.page.keyboard.press("Control+Alt+Y")
    assert.equal(await f.page.evaluate(() => (window as any).nativeCalls), 0)
    assert.equal(await f.page.evaluate(() => (window as any).fixture.selectedSession("A")), "same")
    assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.feedback()), feedback)
    assert.deepEqual(await f.page.evaluate(only => (window as any).fixture.calls().filter((call: any) => call.id !== "local-shared" && only.includes(call.method)), HOST_ONLY), [])
    await f.page.evaluate(() => (window as any).fixture.select("local-shared"))
    await f.page.locator('[data-owner="local-shared"] .session-right-panel').waitFor()
    await f.page.keyboard.press("Control+Alt+Y")
    await f.page.waitForFunction(() => (window as any).nativeCalls === 1)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("retired reader callbacks dispatch nothing and return only their own removed focus to an existing tab", async () => {
  const f = await setup()
  try {
    await f.page.evaluate(() => (window as any).fixture.select("local-shared"))
    const owner = f.page.locator('[data-owner="local-shared"]')
    await owner.locator('[data-tab-id="files"]').click()
    await owner.getByText("local.txt", { exact: true }).waitFor()
    await owner.locator(".files-header-icon-button").first().focus()
    const before = await f.page.evaluate(() => { (window as any).retained = (document.activeElement as any).$$click; return (window as any).fixture.calls().length })
    await f.page.evaluate(() => (window as any).fixture.rebind("local-shared", "A"))
    await f.page.waitForFunction(() => document.activeElement?.getAttribute("data-tab-id") === "status")
    await f.page.evaluate(() => (window as any).retained(new MouseEvent("click")))
    assert.equal(await f.page.evaluate(() => (window as any).fixture.calls().length), before)
    assert.equal(await owner.locator('[data-tab-id="files"]').count(), 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("unknown, unresolved and revoked sources remain closed without moving external focus", async () => {
  const f = await setup()
  try {
    await f.page.locator("#external-focus").focus()
    for (const operation of ["rotate", "revoke", "unresolved", "mismatch"]) {
      await f.page.evaluate(async operation => { (window as any).fixture[operation]("A"); await (window as any).fixture.forced("A") }, operation)
      // prototype-1236: a rotation with current metadata keeps the native Files panel, like chat.
      const closed = operation === "rotate" ? '[data-owner="A"] [data-tab-id="missions"]' : '[data-owner="A"] [data-tab-id="files"], [data-owner="A"] [data-tab-id="missions"]'
      assert.equal(await f.page.locator(closed).count(), 0, operation)
      assert.equal(await f.page.locator("#external-focus").evaluate(element => element === document.activeElement), true)
    }
    await f.page.evaluate(() => (window as any).fixture.info("A"))
    assert.equal(await f.page.locator('[data-owner="A"] .log-container').count(), 0, "host Info readers are gated at their call site")
    assert.deepEqual(await f.page.evaluate(only => (window as any).fixture.calls().filter((call: any) => call.id !== "local-shared" && only.includes(call.method)), HOST_ONLY), [])
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("closed extension methods create neither a document request nor a frame; API 1 and profile preferences remain available", async () => {
  const f = await setup()
  try {
    for (const api of [2, 3, 4]) await f.page.evaluate(api => (window as any).fixture.extension(api), api)
    assert.equal(await f.page.locator("iframe").count(), 0)
    assert.equal(await f.page.evaluate(() => (window as any).fixture.calls().some((call: any) => call.method === "frame")), false)
    await f.page.evaluate(() => (window as any).fixture.extension(1))
    await f.page.locator('iframe[title="Extension"]').waitFor()
    await f.page.evaluate(() => (window as any).fixture.extension(4, true))
    await f.page.locator('iframe[title="Extension"]').waitFor()
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})
