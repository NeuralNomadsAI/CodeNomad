import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { missionLaunchPolicySchema } from "../../../server/src/missions/launch-policy"
import { fixtureEventStream } from "./fixture-event-stream"

let browser: Browser, url: string
let events: Awaited<ReturnType<typeof fixtureEventStream>>
let captures: string
before(async () => {
  url = (await borrowFixture({ name: "mission-scheduling", routes: [{ path: "/scheduling", html:
    '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#root{min-height:100%;margin:0;background:var(--surface-canvas)}</style></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-scheduling.tsx"></script></body></html>' }] })).url
  events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  captures = process.env.CODENOMAD_SCHEDULING_CAPTURES || await mkdtemp(path.join(tmpdir(), "codenomad-mission-scheduling-"))
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })
async function setup(query = "", prepare?: (page: Page) => void) {
  const page = await browser.newPage({ viewport: { width: 440, height: 1000 }, locale: "en-US" })
  prepare?.(page)
  page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(60_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await events.route(page)
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
/** Replace the criteria with fresh rows of the given kinds and fields. */
const rows = (page: Page, specs: [string, object?][], extra: object = {}) => page.evaluate(({ specs, extra }) => {
  const fixture = (window as any).schedulingFixture
  fixture.change({ criteria: specs.map(([kind, fields]) => fixture.row(kind, fields)), ...extra })
}, { specs, extra })
const times = (page: Page) => page.locator(".mission-scheduling-preview time").evaluateAll(items => items.map(item => item.getAttribute("datetime")))
const label = (page: Page, name: string) => page.getByLabel(name, { exact: true })

test("an empty form is a one-time Mission; explanations stay behind help and criteria OR into one policy", async () => {
  const { page, errors } = await setup()
  try {
    const schedule = page.locator(".mission-scheduling")
    assert.equal(await schedule.locator("p").count(), 0)
    assert.equal(await schedule.locator(".mission-scheduling-preview").count(), 0)
    assert.deepEqual(await policy(page), { when: [], onlyWithNews: false, until: null })
    assert.equal(await page.getByRole("checkbox").count(), 0, "options appear with the first criterion")
    await page.locator(".mission-scheduling").getByRole("img", { name: /any criterion occurs/ }).focus()
    await page.getByRole("tooltip").filter({ hasText: /any criterion occurs.*Create saves a paused Mission/ }).waitFor()
    await page.keyboard.press("Tab")
    await page.getByRole("tooltip").waitFor({ state: "detached" })
    await page.getByRole("button", { name: "Add a criterion", exact: true }).click()
    assert.equal(await label(page, "Criterion 1 type").inputValue(), "daily")
    assert.equal(await label(page, "Criterion 1 type").locator("option").count(), 10)
    assert.equal((await times(page)).length, 5)
    const checkbox = label(page, "Only if there is something new")
    assert.equal(await checkbox.isDisabled(), true, "only with news needs a schedule and an event")
    await page.getByRole("button", { name: "Add a criterion", exact: true }).click()
    await label(page, "Criterion 2 type").selectOption("files-changed")
    await page.getByRole("alert").waitFor()
    assert.equal(await label(page, "Criterion 2 file paths").getAttribute("aria-invalid"), "true")
    await label(page, "Criterion 2 file paths").fill("src/main.ts")
    assert.equal(await page.getByRole("alert").count(), 0)
    const either = missionLaunchPolicySchema.parse(await policy(page))
    assert.ok("when" in either)
    assert.deepEqual(either.when.map(item => item.kind), ["cron", "files-changed"]); assert.equal(either.onlyWithNews, false)
    assert.match(await page.locator(".mission-scheduling-preview h4").innerText(), /Next slots/)
    await checkbox.check()
    assert.equal((await policy(page)).onlyWithNews, true)
    assert.match(await page.locator(".mission-scheduling-preview h4").innerText(), /Next checks/)
    await page.getByRole("button", { name: "Remove criterion 1", exact: true }).click()
    assert.equal(await checkbox.isChecked(), false); assert.equal(await checkbox.isDisabled(), true)
    assert.equal((await policy(page)).onlyWithNews, false, "a stale checkbox never blocks an event-only policy")
    assert.equal(await schedule.locator(".mission-scheduling-preview").count(), 0, "events alone have no dated slots")
    assert.equal(await schedule.locator("p").count(), 0)
    assert.deepEqual(await schedule.locator("[aria-describedby]").evaluateAll(elements => elements.flatMap(element =>
      element.getAttribute("aria-describedby")!.split(/\s+/).filter(id => !document.getElementById(id)))), [])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("every invalid field exposes its exact translated error and keeps focus", async () => {
  const { page, errors } = await setup()
  try {
    const summary = page.locator(".mission-scheduling > summary")
    await summary.focus(); await page.keyboard.press("Enter")
    assert.equal(await page.locator(".mission-scheduling").getAttribute("open"), null)
    await page.keyboard.press("Space")
    assert.equal(await page.locator(".mission-scheduling").getAttribute("open"), "")
    for (const [kind, fields, name, extra] of [
      ["hours", { hours: "24" }, "Criterion 1 hours"], ["daily", { time: "" }, "Criterion 1 time"],
      ["monthly", { monthDay: "32" }, "Criterion 1 day of month"], ["cron", { expression: "invalid" }, "Criterion 1 cron expression"],
      ["daily", {}, "Saved time zone (IANA)", { zone: "invalid" }], ["daily", {}, "Until", { until: "2026-02-31T12:00" }],
      ["files-changed", { files: "../outside" }, "Criterion 1 file paths"], ["conversation-message", { source: "" }, "Criterion 1 source"],
    ] as [string, object, string, object?][]) {
      await rows(page, [[kind, fields]], { zone: "UTC", until: "", ...extra })
      const field = label(page, name)
      assert.equal(await field.getAttribute("aria-invalid"), "true", name)
      await field.focus()
      assert.equal(await field.evaluate(element => element === document.activeElement), true, name)
      assert.equal(await field.getAttribute("aria-describedby"), await page.getByRole("alert").getAttribute("id"), name)
    }
    await rows(page, [["daily"]], { zone: "UTC", until: "" })
    assert.equal(await page.getByRole("alert").count(), 0)
    assert.equal(await label(page, "Criterion 1 time").getAttribute("aria-invalid"), "false")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("typing keeps focus and rows; shortcuts write their cron; the list stops at sixteen criteria", async () => {
  const { page, errors } = await setup()
  try {
    const add = page.getByRole("button", { name: "Add a criterion", exact: true })
    for (let index = 0; index < 3; index++) await add.click()
    await label(page, "Criterion 2 type").selectOption("hours")
    await label(page, "Criterion 2 hours").selectOption("12")
    assert.deepEqual(await label(page, "Criterion 2 hours").locator("option").allInnerTexts(), ["1", "2", "3", "4", "6", "8", "12"],
      "only divisors of a day keep the same gap across midnight")
    await label(page, "Criterion 3 type").selectOption("weekly")
    await page.getByRole("group", { name: "Criterion 3 weekdays" }).getByLabel("Sat").check()
    const time = label(page, "Criterion 3 time")
    await time.click(); await page.keyboard.type("0630P")
    assert.equal(await time.evaluate(element => element === document.activeElement), true, "a controlled row never remounts while typing")
    await time.fill("18:30")
    const saved = missionLaunchPolicySchema.parse(await policy(page))
    assert.ok("when" in saved)
    assert.deepEqual(saved.when.map(item => item.kind === "cron" ? item.expression : item.kind), ["0 9 * * *", "0 */12 * * *", "30 18 * * 1,2,3,4,5,6"])
    await page.getByRole("button", { name: "Remove criterion 2", exact: true }).click()
    assert.equal(await label(page, "Criterion 2 type").inputValue(), "weekly")
    assert.equal(await label(page, "Criterion 2 time").inputValue(), "18:30")
    await label(page, "Criterion 2 type").selectOption("daily")
    await label(page, "Criterion 2 time").fill("09:00")
    await page.getByRole("alert").filter({ hasText: /duplicated/ }).waitFor()
    await label(page, "Criterion 2 time").fill("17:45")
    assert.deepEqual((await times(page)).slice(0, 2), ["2026-03-07T17:45:00.000Z", "2026-03-08T09:00:00.000Z"])
    for (let index = 2; index < 16; index++) await add.click()
    assert.equal(await add.isDisabled(), true)
    assert.equal(await page.locator(".mission-criterion").count(), 16)
    await rows(page, [...Array.from({ length: 8 }, (_, hour): [string, object] => ["daily", { time: `0${hour}:00` }]), ["files-changed", { files: "a.ts" }]])
    await page.getByRole("alert").filter({ hasText: /Too many criteria/ }).waitFor()
    await label(page, "Only if there is something new").check()
    assert.equal(await page.getByRole("alert").count(), 0, "eight schedules fit when only they wake")
    assert.equal(await label(page, "Criterion 1 time").evaluate(input => getComputedStyle(input).color === getComputedStyle(input.parentElement!).color), true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("monthly skip, exact native DST preview and the end date bound the shown slots", async () => {
  const { page, errors } = await setup()
  try {
    await rows(page, [["monthly", { monthDay: "31" }]])
    assert.doesNotMatch(await page.locator(".mission-scheduling").innerText(), /Months without this day are skipped/)
    await page.getByRole("img", { name: /Months without this day are skipped/ }).focus()
    await page.getByRole("tooltip").filter({ hasText: /Months without this day are skipped/ }).waitFor()
    assert.deepEqual((await times(page)).map(at => new Date(at!).getUTCMonth()), [2, 4, 6, 7, 9])
    await label(page, "Criterion 1 type").selectOption("daily")
    await label(page, "Criterion 1 time").fill("02:30")
    await label(page, "Saved time zone (IANA)").fill("America/New_York")
    assert.equal((await times(page))[0], "2026-03-08T07:30:00.000Z", "native cron advances the DST gap")
    await label(page, "Until").fill("2026-03-10T02:30")
    assert.equal((await times(page)).length, 3)
    assert.equal((await policy(page)).until, Date.parse("2026-03-10T06:30:00Z"))
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("each event row reads its own sources; an unavailable source keeps the draft and invalidates the policy", async () => {
  const { page, errors } = await setup()
  try {
    const sources = [["schedule-success", "msn_schedule"], ["branch-commits", "refs/heads/dev"], ["mission-completed", "msn_oneoff"], ["conversation-message", "ses_followed"]]
    await rows(page, sources.map(([kind]) => [kind]))
    assert.equal(await policy(page), undefined)
    for (const [index, [, source]] of sources.entries()) await label(page, `Criterion ${index + 1} source`).selectOption(source)
    const saved = missionLaunchPolicySchema.parse(await policy(page))
    assert.ok("when" in saved)
    assert.deepEqual(saved.when.map(item => item.kind), sources.map(([kind]) => kind))
    await page.evaluate(() => (window as any).schedulingFixture.sources({}))
    assert.equal(await label(page, "Criterion 4 source").inputValue(), "ses_followed")
    assert.match(await label(page, "Criterion 1 source").locator("option").first().innerText(), /could not be read/)
    assert.equal(await policy(page), undefined)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("H9 locks explain why; missing capability keeps a criterion-free Mission available", async () => {
  const { page, errors } = await setup()
  try {
    await rows(page, [["daily"]])
    for (const lock of ["uncertain", "passage", "launched-once", "terminal", "deleted"]) {
      await page.evaluate(lock => (window as any).schedulingFixture.lock(lock), lock)
      assert.equal(await label(page, "Criterion 1 type").isDisabled(), true)
      assert.equal(await page.getByRole("button", { name: "Add a criterion", exact: true }).isDisabled(), true)
      assert.ok((await page.getByRole("status").innerText()).length > 30)
    }
    await page.evaluate(() => { (window as any).schedulingFixture.lock(null); (window as any).schedulingFixture.capability("missing") })
    assert.equal(await policy(page), undefined)
    assert.equal(await page.getByRole("button", { name: "Add a criterion", exact: true }).isDisabled(), true)
    await page.getByRole("button", { name: "Remove criterion 1", exact: true }).click()
    assert.deepEqual(await policy(page), { when: [], onlyWithNews: false, until: null })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("French light and Hebrew RTL remain readable at narrow widths without overflow", async () => {
  for (const locale of ["fr", "he"]) {
    const { page, errors } = await setup(`?locale=${locale}&light`)
    try {
      await page.setViewportSize({ width: 320, height: 1000 })
      await rows(page, [["weekly"], ["branch-commits", { source: "refs/heads/dev" }], ["files-changed", { files: "src/a.ts" }]],
        { onlyWithNews: true, until: "2026-06-30T18:00" })
      await page.waitForFunction(() => document.documentElement.lang.startsWith(new URLSearchParams(location.search).get("locale")!))
      assert.equal(await page.locator("main").evaluate(element => element.scrollWidth <= element.clientWidth), true)
      assert.equal(await page.locator(".mission-scheduling-preview time").count(), 5)
      assert.equal(await page.locator("main").innerText().then(text => text.includes("missions.scheduling.")), false)
      await page.screenshot({ path: path.join(captures, `criteria-${locale}-light.png`), fullPage: true })
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  }
})

test("stored policies reopen exactly, legacy frequency + condition reads as criteria, retired options need explicit replacement", async () => {
  const { page, errors } = await setup()
  const load = (value: object) => page.evaluate(value => (window as any).schedulingFixture.load(value), value)
  try {
    const criteria = { when: [{ kind: "cron", expression: "15 09 * * MON,WED,FRI", zone: "UTC" }], onlyWithNews: false, until: null }
    await load(criteria)
    assert.equal(await label(page, "Criterion 1 type").inputValue(), "weekly")
    assert.deepEqual(await policy(page), criteria)
    await load({ when: [{ kind: "cron", expression: "*/15 9-17 * * MON-FRI", zone: "UTC" }], onlyWithNews: false, until: null })
    assert.equal(await label(page, "Criterion 1 cron expression").inputValue(), "*/15 9-17 * * MON-FRI")
    const legacy = { timing: { kind: "cron", expression: "0 9 * * *", zone: "UTC" },
      condition: { kind: "branch-commits", directory: "/fixture", ref: "refs/heads/dev" }, ends: { maxLaunches: null, afterMs: null, at: null } }
    await load(legacy)
    assert.equal(await label(page, "Criterion 1 type").inputValue(), "daily")
    assert.equal(await label(page, "Criterion 2 source").inputValue(), "refs/heads/dev")
    assert.equal(await label(page, "Only if there is something new").isChecked(), true)
    assert.deepEqual(await policy(page), legacy, "an unchanged reopen keeps the stored bytes")
    await label(page, "Only if there is something new").uncheck()
    assert.deepEqual(await policy(page), { when: [legacy.timing, legacy.condition], onlyWithNews: false, until: null })
    const retired = { timing: { kind: "every", intervalMs: 5_400_000 }, condition: null, ends: { maxLaunches: 3, at: null, afterMs: null } }
    await load(retired)
    assert.deepEqual(await policy(page), retired)
    assert.equal(await page.getByRole("button", { name: "Add a criterion", exact: true }).count(), 0)
    assert.match(await page.locator(".mission-scheduling pre").innerText(), /5400000/)
    await page.evaluate(() => (window as any).schedulingFixture.lock("passage"))
    assert.equal(await page.getByRole("button", { name: "Replace with a new scheduling policy", exact: true }).isDisabled(), true)
    await page.evaluate(() => (window as any).schedulingFixture.lock(null))
    await page.getByRole("button", { name: "Replace with a new scheduling policy", exact: true }).click()
    assert.deepEqual(await policy(page), { when: [], onlyWithNews: false, until: null })
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
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  }
  const { page } = await setup()
  try {
    await page.locator(".mission-scheduling > summary").click()
    await rows(page, [["hours", { hours: "0" }]])
    await page.getByRole("alert").waitFor()
    assert.equal(await page.locator(".mission-scheduling").getAttribute("open"), "")
    assert.equal(await policy(page), undefined)
  } finally { await page.close() }
})

test("the scheduling i links to the Keep OpenCode running row by its stable anchor without reading that setting", async () => {
  for (const locale of ["en", "fr"]) {
    const supervision: string[] = []
    const { page, errors } = await setup(locale === "fr" ? "?locale=fr" : "", page => page.on("request", request => {
      if (new URL(request.url()).pathname.startsWith("/api/opencode/supervision")) supervision.push(request.method()) }))
    try {
      await page.waitForFunction(locale => document.documentElement.lang.startsWith(locale), locale)
      await rows(page, [["daily"]])
      const sentence = locale === "fr" ? "Les programmations ne tournent que si OpenCode tourne." : "Schedules only run while OpenCode is running."
      const info = page.getByRole("button", { name: sentence, exact: true })
      await info.focus(); await page.keyboard.press("Enter")
      const popover = page.locator(".settings-info-link-content")
      await popover.waitFor()
      assert.equal((await popover.innerText()).startsWith(sentence), true)
      await page.screenshot({ path: path.join(captures, `runtime-info-${locale}.png`) })
      assert.deepEqual(supervision, [], "Missions never reads the supervision setting")
      const link = popover.getByRole("button")
      await page.waitForFunction(() => document.activeElement?.classList.contains("settings-info-link-action"))
      assert.equal(await link.evaluate(element => element === document.activeElement), true, "opening by keyboard moves focus to the link")
      await page.keyboard.press("Enter")
      const row = page.locator('[data-settings-row="service-supervision"]')
      await row.waitFor()
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-settings-row") === "service-supervision")
      assert.equal(await popover.count(), 0)
      await page.waitForFunction(() => true)
      assert.ok(supervision.length > 0 && supervision.every(method => method === "GET"), "only the opened setting reads its own state")
      await page.evaluate(() => (window as any).schedulingFixture.lock("passage"))
      assert.equal(await info.isDisabled(), false, "a lock never hides the information or its link")
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  }
})
