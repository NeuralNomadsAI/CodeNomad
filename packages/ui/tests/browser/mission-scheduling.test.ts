import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { missionLaunchPolicySchema } from "../../../server/src/missions/launch-policy"

let browser: Browser, url: string
const captures = path.join(process.env.LOCALAPPDATA || process.env.TEMP!, "codenomad-agent-scratch", "issue-926", "impl", "ui-final")
before(async () => {
  url = (await borrowFixture({ name: "mission-scheduling", routes: [{ path: "/scheduling", html:
    '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#root{min-height:100%;margin:0;background:var(--surface-canvas)}</style></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-scheduling.tsx"></script></body></html>' }] })).url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  await mkdir(captures, { recursive: true })
})
after(async () => { await browser?.close() })
async function setup(query = "") {
  const page = await browser.newPage({ viewport: { width: 440, height: 1000 }, locale: "en-US" })
  page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(60_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  const theme = query.includes("light") ? "light" : "dark"
  await page.route("**/api/storage/state/ui", route => route.fulfill({ json: { theme, colorScheme: theme === "light" ? "porcelain" : "mist" } }))
  await page.goto(url + query)
  await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme)
  await page.locator(".mission-scheduling > summary").waitFor()
  await page.locator(".mission-scheduling > summary").click()
  return { page, errors }
}
const policy = (page: Page) => page.evaluate(() => (window as any).schedulingFixture.policy())
const patch = (page: Page, value: object) => page.evaluate(value => (window as any).schedulingFixture.change(value), value)
const times = (page: Page) => page.locator(".mission-scheduling-preview time").evaluateAll(items => items.map(item => item.getAttribute("datetime")))

test("scheduling defaults folded, has all frequencies, normalizes arbitrary minutes and refuses a ninth time", async () => {
  const { page, errors } = await setup()
  try {
    assert.equal(await page.locator(".mission-scheduling").getAttribute("open"), "")
    await page.locator(".mission-scheduling > summary").click()
    assert.equal(await page.locator(".mission-scheduling").getAttribute("open"), null)
    assert.match(await page.locator("summary").innerText(), /Once, immediately · Without a condition/)
    await page.locator("summary").click()
    assert.equal(await page.getByLabel("Frequency", { exact: true }).locator("option").count(), 9)
    await page.getByLabel("Frequency", { exact: true }).selectOption("multi")
    await page.getByLabel("Time 1", { exact: true }).fill("09:15")
    await page.getByRole("button", { name: "Add a time", exact: true }).click()
    assert.equal(await page.getByLabel("Time 2", { exact: true }).inputValue(), "17:45")
    const saved = missionLaunchPolicySchema.parse(await policy(page))
    assert.equal(saved.timing.kind, "multi")
    assert.deepEqual((await times(page)).slice(0, 2), ["2026-03-07T17:45:00.000Z", "2026-03-08T09:15:00.000Z"])
    for (let index = 2; index < 8; index++) await page.getByRole("button", { name: "Add a time", exact: true }).click()
    assert.equal(await page.getByRole("button", { name: "Add a time", exact: true }).isDisabled(), true)
    assert.equal(await page.locator('input[type="time"]').count(), 8)
    assert.equal(await page.getByLabel("Time 1", { exact: true }).evaluate(input => getComputedStyle(input).color === getComputedStyle(input.parentElement!).color), true)
    await page.screenshot({ path: path.join(captures, "multi-en-dark.png"), fullPage: true })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
test("interval validation, monthly skip, exact native DST preview and combined end/quota fields", async () => {
  const { page, errors } = await setup()
  try {
    await page.getByLabel("Frequency", { exact: true }).selectOption("every")
    await page.getByLabel("Duration", { exact: true }).fill("14")
    await page.getByRole("alert").waitFor()
    assert.equal(await policy(page), undefined)
    await page.getByLabel("Duration", { exact: true }).fill("15")
    await page.getByLabel("Maximum launched passages", { exact: true }).fill("2")
    assert.equal((await times(page)).length, 2)
    await page.getByLabel("Frequency", { exact: true }).selectOption("monthly")
    await page.getByLabel("Maximum launched passages", { exact: true }).fill("")
    await page.getByLabel("Day of month", { exact: true }).fill("31")
    assert.match(await page.locator(".mission-scheduling").innerText(), /Months without this day are skipped/)
    assert.deepEqual((await times(page)).map(at => new Date(at!).getUTCMonth()), [2, 4, 6, 7, 9])
    await page.getByLabel("Frequency", { exact: true }).selectOption("daily")
    await page.getByLabel("Time 1", { exact: true }).fill("02:30")
    await page.getByLabel("Saved time zone (IANA)", { exact: true }).fill("America/New_York")
    assert.equal((await times(page)).length, 5)
    assert.equal((await times(page))[0], "2026-03-08T07:30:00.000Z", "native cron advances the DST gap")
    await page.getByLabel("Last allowed slot", { exact: true }).fill("2026-03-10T02:30")
    assert.equal((await times(page)).length, 3)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
test("all sources stay explicit, event-only shows checks, unavailable source preserves draft and invalidates policy", async () => {
  const { page, errors } = await setup()
  try {
    for (const [condition, source] of [["schedule-success", "msn_schedule"], ["branch-commits", "refs/heads/dev"],
      ["mission-completed", "msn_oneoff"], ["conversation-message", "ses_followed"]]) {
      await page.getByLabel("Condition", { exact: true }).selectOption(condition)
      assert.equal(await policy(page), undefined)
      await page.getByLabel("Source in this project", { exact: true }).selectOption(source)
      assert.equal(missionLaunchPolicySchema.parse(await policy(page)).condition?.kind, condition)
      assert.match(await page.locator(".mission-scheduling-preview h4").innerText(), /Next checks/)
      assert.equal((await times(page)).length, 5)
    }
    await page.evaluate(() => (window as any).schedulingFixture.sources({}))
    assert.equal(await page.getByLabel("Source in this project", { exact: true }).inputValue(), "ses_followed")
    assert.equal(await page.getByLabel("Source in this project", { exact: true }).isDisabled(), true)
    assert.equal(await policy(page), undefined)
    await page.getByLabel("Condition", { exact: true }).selectOption("files-changed")
    await page.getByLabel("Relative file paths (one per line)", { exact: true }).fill("../outside")
    assert.equal(await policy(page), undefined)
    await page.getByLabel("Relative file paths (one per line)", { exact: true }).fill("src/a.ts\nsrc/b.ts")
    assert.deepEqual((await policy(page)).condition, { kind: "files-changed", paths: ["src/a.ts", "src/b.ts"] })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
test("H9 locks explain why and when; missing capability leaves immediate unconditional available", async () => {
  const { page, errors } = await setup()
  try {
    await patch(page, { frequency: "daily" })
    for (const lock of ["uncertain", "passage", "launched-once", "terminal", "deleted"]) {
      await page.evaluate(lock => (window as any).schedulingFixture.lock(lock), lock)
      assert.equal(await page.getByLabel("Frequency", { exact: true }).isDisabled(), true)
      assert.equal(await page.getByLabel("Time 1", { exact: true }).isDisabled(), true)
      assert.ok((await page.getByRole("status").innerText()).length > 30)
    }
    await page.evaluate(() => { (window as any).schedulingFixture.lock(null); (window as any).schedulingFixture.capability("missing") })
    assert.equal(await page.getByLabel("Frequency", { exact: true }).isDisabled(), false)
    assert.equal(await page.getByLabel("Time 1", { exact: true }).isDisabled(), true)
    assert.equal(await policy(page), undefined)
    await page.getByLabel("Frequency", { exact: true }).selectOption("immediate")
    assert.equal((await policy(page)).timing.kind, "immediate")
    assert.equal(await page.getByLabel("Condition", { exact: true }).isDisabled(), true)
    assert.equal(await page.locator('select option[value="daily"]').evaluate(option => (option as HTMLOptionElement).disabled), true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
test("French light and Hebrew RTL remain readable at narrow widths without overflow", async () => {
  for (const locale of ["fr", "he"]) {
    const { page, errors } = await setup(`?locale=${locale}&light`)
    try {
      await page.setViewportSize({ width: 320, height: 1000 })
      await patch(page, { frequency: "multi", times: ["09:15", "17:45"], condition: "files-changed", files: "src/a.ts", maxLaunches: "3" })
      await page.waitForFunction(() => document.documentElement.lang.startsWith(new URLSearchParams(location.search).get("locale")!))
      assert.equal(await page.locator("main").evaluate(element => element.scrollWidth <= element.clientWidth), true)
      assert.equal(await page.locator(".mission-scheduling-preview time").count(), 5)
      assert.equal(await page.locator("main").innerText().then(text => text.includes("missions.scheduling.")), false)
      await page.screenshot({ path: path.join(captures, `multi-${locale}-light.png`), fullPage: true })
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  }
})

test("stored simple/advanced policies reopen without a temporal rewrite; unsupported shapes require explicit replacement", async () => {
  const { page, errors } = await setup()
  const load = (value: object) => page.evaluate(value => (window as any).schedulingFixture.load(value), value)
  const original = { timing: { kind: "cron", expression: "15 09 * * MON,WED,FRI", zone: "UTC" }, condition: null,
    ends: { maxLaunches: 3, at: null, afterMs: null } }
  try {
    await load(original)
    assert.equal(await page.getByLabel("Frequency", { exact: true }).inputValue(), "weekly")
    assert.deepEqual(await policy(page), original)
    await page.getByLabel("Maximum launched passages", { exact: true }).fill("5")
    assert.deepEqual((await policy(page)).timing, original.timing)
    await load({ ...original, timing: { ...original.timing, expression: "*/15 9-17 * * MON-FRI" } })
    assert.equal(await page.getByLabel("Frequency", { exact: true }).inputValue(), "cron")
    assert.equal(await page.getByLabel("Cron expression", { exact: true }).inputValue(), "*/15 9-17 * * MON-FRI")
    const retained = { ...original, timing: { kind: "multi", calendars: [
      { expression: "15 9 * * *", zone: "America/New_York" }, { expression: "45 17 * * *", zone: "Asia/Tokyo" },
    ] } }
    await load(retained)
    assert.deepEqual(await policy(page), retained)
    assert.equal(await page.getByLabel("Frequency", { exact: true }).count(), 0)
    assert.match(await page.locator(".mission-scheduling pre").innerText(), /Asia\/Tokyo/)
    await page.locator(".mission-scheduling > summary").click()
    await page.getByRole("button", { name: "Replace with a new scheduling policy", exact: true }).isVisible().then(value => assert.equal(value, false))
    await page.locator(".mission-scheduling > summary").focus()
    await page.keyboard.press("Enter")
    await page.getByRole("button", { name: "Replace with a new scheduling policy", exact: true }).waitFor()
    await page.screenshot({ path: path.join(captures, "stored-policy-en-dark.png"), fullPage: true })
    await page.evaluate(() => (window as any).schedulingFixture.lock("passage"))
    assert.equal(await page.getByRole("button", { name: "Replace with a new scheduling policy", exact: true }).isDisabled(), true)
    await page.evaluate(() => (window as any).schedulingFixture.lock(null))
    await page.getByRole("button", { name: "Replace with a new scheduling policy", exact: true }).click()
    assert.equal(await page.getByLabel("Frequency", { exact: true }).inputValue(), "immediate")
    assert.equal((await policy(page)).timing.kind, "immediate")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("retained policy explanation and exact JSON fit French/Hebrew narrow light views; invalid fields open their section", async () => {
  for (const locale of ["fr", "he"]) {
    const { page, errors } = await setup(`?locale=${locale}&light`)
    try {
      await page.setViewportSize({ width: 320, height: 1000 })
      await page.evaluate(() => (window as any).schedulingFixture.load({ timing: { kind: "every", intervalMs: 900_001 }, condition: null,
        ends: { at: null, afterMs: null, maxLaunches: 3 } }))
      assert.equal(await page.locator("main").evaluate(element => element.scrollWidth <= element.clientWidth), true)
      assert.equal(await page.locator("main").innerText().then(text => text.includes("missions.scheduling.")), false)
      await page.screenshot({ path: path.join(captures, `stored-policy-${locale}-light.png`), fullPage: true })
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  }
  const { page } = await setup()
  try {
    await page.locator(".mission-scheduling > summary").click()
    await patch(page, { frequency: "every", amount: "14" })
    await page.getByRole("alert").waitFor()
    assert.equal(await page.locator(".mission-scheduling").getAttribute("open"), "")
    assert.equal(await policy(page), undefined)
  } finally { await page.close() }
})
