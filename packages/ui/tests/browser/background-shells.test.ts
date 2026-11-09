import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let fixture: { browser: Awaited<ReturnType<typeof chromium.launch>>; url: string; close(): Promise<void> }
before(async () => {
  const page = await borrowFixture({ name: "background-shells", routes: [{ path: "/fixture", html:
    '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/background-shells.tsx"></script></body></html>' }] })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  fixture = { browser, url: page.url, close: () => browser.close() }
})
after(async () => { await fixture?.close() })

test("compact shell rows, native output and stop target the displayed background shell", async () => {
  const page = await fixture.browser.newPage({ viewport: { width: 1000, height: 700 }, locale: "en-US" })
  const errors: string[] = [], deleted: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  const shell = { id: "sh_bg", command: "pwsh -NoProfile -File build.ps1 " + "long-argument ".repeat(20),
    cwd: "/tmp/build", shell: "pwsh", file: "/tmp/output", pid: 42, metadata: { sessionID: "ses_own" }, time: { started: 1 }, status: "running" }
  let present = true, output = "plain output\nsecond line", listReads = 0
  try {
    await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
    await page.route("**/api/**", route => {
      const request = route.request(), url = new URL(request.url())
      let body: unknown = {}
      if (url.pathname.endsWith("/background-shells")) { listReads++; body = { data: present ? [shell] : [] } }
      else if (url.pathname.endsWith("/shell/sh_bg/output")) {
        const cursor = Number(url.searchParams.get("cursor"))
        body = { location: { directory: "/repo" }, data: { output: output.slice(cursor), cursor: output.length, size: output.length, truncated: false } }
      } else if (url.pathname.endsWith("/shell/sh_bg") && request.method() === "DELETE") {
        deleted.push(url.searchParams.get("location[directory]")!)
        present = false
        return route.fulfill({ status: 204 })
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) })
    })
    await page.goto(fixture.url)
    const row = page.locator(".status-process-card")
    await row.waitFor()
    for (const dir of ["ltr", "rtl"]) {
      await page.locator("aside").evaluate((el, dir) => { el.style.width = "220px"; el.dir = dir }, dir)
      const geometry = await row.evaluate(el => ({ height: el.getBoundingClientRect().height, overflow: el.scrollWidth > el.clientWidth }))
      assert.ok(geometry.height <= 38, `one compact row, got ${geometry.height}px`)
      assert.equal(geometry.overflow, false)
    }
    await row.getByRole("button", { name: "View output", exact: true }).click()
    await page.getByRole("dialog").locator("pre").filter({ hasText: "plain output" }).waitFor()
    assert.equal(await page.getByRole("dialog").locator("pre").textContent(), output)
    await page.getByRole("button", { name: "Close", exact: true }).click()
    output = "\u001b[31mred output\u001b[0m"
    await row.getByRole("button", { name: "View output", exact: true }).click()
    await page.getByRole("dialog").locator("pre").filter({ hasText: "red output" }).waitFor()
    assert.equal(await page.getByRole("dialog").locator("pre").textContent(), "red output")
    await page.getByRole("button", { name: "Close", exact: true }).click()
    const count = listReads
    const originalRow = await row.elementHandle()
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/background-shells")),
      page.evaluate(() => (window as any).fixture.event("session.tool.success")),
    ])
    assert.ok(listReads > count)
    assert.equal(await originalRow!.evaluate(el => el.isConnected), true, "passive refresh preserves row actions")
    await row.getByRole("button", { name: "Stop and remove", exact: true }).click()
    await page.getByRole("alertdialog").getByRole("button", { name: "Stop and remove", exact: true }).click()
    await row.waitFor({ state: "detached" })
    assert.deepEqual(deleted, ["/repo"])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
