import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  url = (await borrowFixture({ name: "mission-precise-states", routes: [{ path: "/states", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-precise-states.tsx"></script></body></html>' }] })).url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

test("a failed passage section retries only its own page and never keeps a false reading state", async () => {
  const page = await browser.newPage({ locale: "en-US" }), reads: number[] = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  let fail = true
  try {
    await page.route("**/api/**", route => route.fulfill({ json: { settings: { locale: "en" } } }))
    await page.route("**/missions/recurrence/schedule/current/passage/content**", route => {
      const index = Number(new URL(route.request().url()).searchParams.get("page"))
      reads.push(index)
      return fail ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: {
        version: 1, projectID: "project", missionID: "mission", scheduleID: "schedule", passageID: "passage", revision: 1,
        page: index, pageCount: 3, sourceText: `Section page ${index}`, markdownText: null,
      } })
    })
    await page.goto(url)
    await page.locator("#body").getByText("Reading content…", { exact: true }).waitFor()
    const section = page.locator("#passage")
    await section.getByText("Section unavailable.").waitFor()
    assert.equal(await section.getByText(/Reading/).count(), 0)
    fail = false
    await section.getByRole("button", { name: "Try again", exact: true }).click()
    await section.getByText("Section page 0", { exact: true }).waitFor()
    assert.deepEqual(reads, [0, 0])
    await page.getByRole("button", { name: "Next section page" }).click()
    await section.getByText("Section page 1", { exact: true }).waitFor()
    fail = true
    await page.getByRole("button", { name: "Next section page" }).click()
    await section.getByText("Section unavailable.").waitFor()
    fail = false
    await section.getByRole("button", { name: "Try again", exact: true }).click()
    await section.getByText("Section page 2", { exact: true }).waitFor()
    assert.deepEqual(reads, [0, 0, 1, 2, 2])
    fail = true
    await page.getByRole("button", { name: "Toggle section" }).click()
    await page.getByRole("button", { name: "Toggle section" }).click()
    await section.getByText("Could not refresh section.").waitFor()
    assert.equal(await section.getByText("Section page 2", { exact: true }).count(), 1, "failed revalidation keeps the last good section")
    fail = false
    const reread = page.waitForResponse(response => response.url().includes("/current/passage/content"))
    await section.getByRole("button", { name: "Try again", exact: true }).click()
    await reread
    await section.getByText("Could not refresh section.").waitFor({ state: "detached" })
    assert.deepEqual(reads, [0, 0, 1, 2, 2, 2, 2])
    assert.deepEqual(errors, [])
  } catch (error) {
    throw new Error(`${error}\n${JSON.stringify({ errors, reads })}\n${await page.locator("body").innerText()}`)
  } finally { await page.close() }
})
