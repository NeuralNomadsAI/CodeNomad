import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
    name: "launch-errors",
    routes: [{ path: "/fixture", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/launch-errors.tsx"></script></body></html>' }],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

test("creation and workspace launch failures always offer Settings without changing the diagnosis or retrying", async () => {
  const page = await browser.newPage()
  const errors: string[] = [], mutations: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    if (pathname === "/api/storage/binaries/validate" && request.method() === "POST") return route.fulfill({ json: { valid: true, version: "2.3.0" } })
    if (request.method() !== "GET") mutations.push(`${request.method()} ${pathname}`)
    if (pathname === "/api/events") return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" })
    if (pathname === "/api/opencode/update") return route.fulfill({ json: {
      state: "ready", currentVersion: "2.3.0", latestVersion: "2.3.0", minimumVersion: "2.3.0",
      recommendedVersion: "2.3.0", binaryPath: "/fixture/opencode", target: "host",
      serviceState: "ready", daemonVersion: "2.3.0", canUpgrade: false, canRestart: false,
    } })
    if (pathname === "/api/workspaces") return route.fulfill({ json: { workspaces: [] } })
    return route.fulfill({ json: {} })
  })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture))
    for (const workspace of [false, true]) {
      for (const message of ["OpenCode binary not found", "opencode_v2_required", "Invalid environment variable", "OpenCode exited with code 1"]) {
        await page.evaluate(({ message, workspace }) => (window as any).fixture.fail(message, workspace, message.includes("not found")), { message, workspace })
        const dialog = page.getByRole("dialog", { name: "Unable to launch OpenCode", exact: true })
        await dialog.waitFor()
        const state = await page.evaluate(() => (window as any).fixture.state())
        assert.equal(await dialog.locator("pre").innerText(), state.error.message)
        assert.equal(await dialog.getByText("OpenCode could not start this workspace. Review the error output below or check your OpenCode settings.", { exact: true }).count(), 1)
        await dialog.getByRole("button", { name: "Open OpenCode Settings", exact: true }).click({ timeout: 3000 })
        await dialog.waitFor({ state: "hidden" })
        assert.deepEqual(await page.evaluate(() => (window as any).fixture.state()), { error: null, settingsOpen: true, section: "opencode" })
      }
    }
    assert.deepEqual(errors, [])
    assert.deepEqual(mutations, [], "opening Settings never retries the launch or changes the shared service")
  } finally { await page.close() }
})
