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
  const page = await browser.newPage({ viewport: { width: 440, height: 1000 }, locale: "en-US", timezoneId: "Europe/Paris" })
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
  await page.locator("section.mission-scheduling").waitFor()
  return { page, errors }
}
const policy = (page: Page) => page.evaluate(() => (window as any).schedulingFixture.policy())
const patch = (page: Page, value: object) => page.evaluate(value => (window as any).schedulingFixture.change(value), value)
/** Replace the criteria with fresh rows of the given kinds and fields. */
const rows = (page: Page, specs: [string, object?][], extra: object = {}) => page.evaluate(({ specs, extra }) => {
  const fixture = (window as any).schedulingFixture
  fixture.change({ criteria: specs.map(([kind, fields]) => fixture.row(kind, fields)), ...extra })
}, { specs, extra })
const label = (page: Page, name: string) => page.getByLabel(name, { exact: true })
const roleOf = (page: Page, number: number) => page.locator(".mission-criterion-slot").nth(number - 1).locator(".mission-criterion-connector")
const handle = (page: Page, number: number) => page.getByRole("button", { name: `Move criterion ${number}`, exact: true })
/** A real pointer drag on the grip, in small steps so the sortable activates and tracks. */
async function drag(page: Page, from: number, to: number) {
  const start = (await handle(page, from).boundingBox())!, end = (await page.getByRole("group", { name: `Criterion ${to}`, exact: true }).boundingBox())!
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await page.mouse.down()
  const y = end.y + end.height * (to > from ? 0.75 : 0.25)
  for (let step = 1; step <= 12; step++) await page.mouse.move(start.x + start.width / 2, start.y + (y - start.y) * step / 12)
  return async () => { await page.mouse.up() }
}

test("the first criterion defaults to once; Add appends a daily card; connectors follow their kinds", async () => {
  const { page, errors } = await setup()
  try {
    const schedule = page.locator(".mission-scheduling")
    assert.equal(await schedule.locator("p:not(.sr-only)").count(), 0)
    assert.deepEqual(await policy(page), { when: [{ kind: "now" }] })
    assert.equal(await label(page, "Criterion 1 type").inputValue(), "now")
    assert.equal(await schedule.locator("details, summary").count(), 0, "scheduling is always expanded")
    assert.equal(await page.getByRole("checkbox").count(), 0)
    const help = page.locator(".mission-scheduling-when-head").getByRole("link")
    assert.equal(await help.count(), 1)
    await page.getByRole("button", { name: "Add a criterion", exact: true }).click()
    assert.equal(await label(page, "Criterion 1 type").inputValue(), "now")
    assert.equal(await label(page, "Criterion 2 type").inputValue(), "daily")
    assert.deepEqual(await policy(page), { when: [{ kind: "now" }, { kind: "cron", expression: "0 9 * * *", zone: "UTC" }] })
    assert.equal(await roleOf(page, 2).innerText(), "or")
    await page.getByRole("button", { name: "Remove criterion 2", exact: true }).click()
    await label(page, "Criterion 1 type").selectOption("daily")
    assert.equal(await label(page, "Criterion 1 type").inputValue(), "daily")
    assert.equal(await label(page, "Criterion 1 type").locator("option").count(), 11)
    assert.equal(await roleOf(page, 1).count(), 0, "Launch when titles the first card")
    assert.equal(await handle(page, 1).isDisabled(), true, "a single card has nothing to reorder")
    assert.equal(await schedule.locator("time, ol, input[type=datetime-local], [aria-pressed]").count(), 0, "no preview, end date or role switch")
    await page.getByRole("button", { name: "Add a criterion", exact: true }).click()
    assert.equal(await label(page, "Criterion 2 type").inputValue(), "daily")
    await label(page, "Criterion 2 type").selectOption("files-changed")
    await page.getByRole("alert").waitFor()
    await label(page, "Criterion 2 file paths").fill("src/main.ts")
    assert.equal(await page.getByRole("alert").count(), 0)
    const daily = { kind: "cron", expression: "0 9 * * *", zone: "UTC" }, files = { kind: "files-changed", paths: ["src/main.ts"] }
    assert.deepEqual(await policy(page), { when: [daily, files] })
    assert.equal(await roleOf(page, 2).innerText(), "if", "an event after a schedule is its condition")
    // Keyboard: Alt+Up on the grip moves the event first: files, else 09:00.
    await handle(page, 2).focus(); await page.keyboard.press("Alt+ArrowUp")
    assert.deepEqual(await policy(page), { when: [files, daily] })
    assert.equal(await label(page, "Criterion 1 type").inputValue(), "files-changed")
    assert.equal(await roleOf(page, 2).innerText(), "else")
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Move criterion 1")
    assert.equal(await schedule.locator("[aria-live]").innerText(), "Moved to position 1 of 2: Launch when.")
    await page.keyboard.press("Alt+ArrowUp")
    assert.deepEqual(await policy(page), { when: [files, daily] }, "nothing moves past the top")
    // Pointer: drag the event after the schedule again; it becomes its condition.
    const heights = () => schedule.locator(".mission-criterion-slot").evaluateAll(slots => slots.map(slot => slot.getBoundingClientRect().height))
    const before = await heights()
    const drop = await drag(page, 1, 2)
    assert.deepEqual(await heights(), before, "connectors changing while dragging never reflow the cards")
    assert.equal(await schedule.locator(".mission-criterion-drop").count(), 1, "the drop target is shown while dragging")
    assert.deepEqual(await schedule.locator(".mission-criterion-connector").allInnerTexts(), ["if"], "the connectors follow the projected order while dragging")
    await drop()
    assert.deepEqual(await policy(page), { when: [daily, files] })
    assert.equal(await roleOf(page, 2).innerText(), "if")
    assert.equal(await schedule.locator(".mission-criterion-dragging, .mission-criterion-drop").count(), 0)
    assert.deepEqual(await schedule.locator("[aria-describedby]").evaluateAll(elements => elements.flatMap(element =>
      element.getAttribute("aria-describedby")!.split(/\s+/).filter(id => !document.getElementById(id)))), [])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("dragging and keyboard moves keep every card mounted, its typed values and the grip's focus", async () => {
  const { page, errors } = await setup()
  try {
    await rows(page, [["daily", { time: "07:30" }], ["branch-commits", { source: "refs/heads/dev" }], ["files-changed", { files: "a.ts" }]])
    const nodes = await page.locator(".mission-criterion").elementHandles()
    await handle(page, 3).focus(); await page.keyboard.press("Alt+ArrowUp"); await page.keyboard.press("Alt+ArrowUp")
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Move criterion 1")
    assert.deepEqual(await page.locator(".mission-criterion-connector").allInnerTexts(), ["else", "if"], "files, else 07:30 if commits")
    const after = await page.locator(".mission-criterion").elementHandles()
    for (const node of nodes) assert.ok(await Promise.all(after.map(item => item.evaluate((element, other) => element === other, node))).then(found => found.includes(true)),
      "no card remounts")
    assert.equal(await label(page, "Criterion 2 time").inputValue(), "07:30")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("every invalid field exposes its exact translated error and keeps focus", async () => {
  const { page, errors } = await setup()
  try {
    assert.equal(await page.locator(".mission-scheduling summary").count(), 0)
    for (const [kind, fields, name, extra] of [
      ["hours", { hours: "24" }, "Criterion 1 hours"], ["daily", { time: "" }, "Criterion 1 time"],
      ["monthly", { monthDay: "32" }, "Criterion 1 day of month"], ["cron", { expression: "invalid" }, "Criterion 1 cron expression"],
      ["daily", {}, "Saved time zone (IANA)", { zone: "invalid" }],
      ["files-changed", { files: "../outside" }, "Criterion 1 file paths"], ["conversation-message", { source: "" }, "Criterion 1 source"],
    ] as [string, object, string, object?][]) {
      await rows(page, [[kind, fields]], { zone: "UTC", ...extra })
      const field = label(page, name)
      assert.equal(await field.getAttribute("aria-invalid"), "true", name)
      await field.focus()
      assert.equal(await field.evaluate(element => element === document.activeElement), true, name)
      assert.equal(await field.getAttribute("aria-describedby"), await page.getByRole("alert").getAttribute("id"), name)
    }
    await rows(page, [["daily"]], { zone: "UTC" })
    assert.equal(await page.getByRole("alert").count(), 0)
    assert.equal(await label(page, "Criterion 1 time").getAttribute("aria-invalid"), "false")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("typing keeps focus and rows; shortcuts write their cron; the list stops at sixteen criteria", async () => {
  const { page, errors } = await setup()
  try {
    const add = page.getByRole("button", { name: "Add a criterion", exact: true })
    await label(page, "Criterion 1 type").selectOption("daily")
    for (let index = 0; index < 2; index++) await add.click()
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
    assert.equal(await page.getByRole("alert").count(), 0)
    for (let index = 2; index < 16; index++) await add.click()
    assert.equal(await add.isDisabled(), true)
    assert.equal(await page.locator(".mission-criterion").count(), 16)
    const eight = Array.from({ length: 8 }, (_, hour): [string, object] => ["daily", { time: `0${hour}:00` }])
    await rows(page, [["files-changed", { files: "a.ts" }], ...eight])
    await page.getByRole("alert").filter({ hasText: /Too many criteria/ }).waitFor()
    await rows(page, [...eight, ["files-changed", { files: "a.ts" }]])
    assert.equal(await page.getByRole("alert").count(), 0, "eight schedules fit when events are conditions")
    assert.equal(await label(page, "Criterion 1 time").evaluate(input => getComputedStyle(input).color === getComputedStyle(input.parentElement!).color), true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("the monthly skip is explained on demand and a calendar without a future slot is refused", async () => {
  const { page, errors } = await setup()
  try {
    await rows(page, [["monthly", { monthDay: "31" }]])
    assert.doesNotMatch(await page.locator(".mission-scheduling").innerText(), /Months without this day are skipped/)
    await page.getByRole("img", { name: /Months without this day are skipped/ }).focus()
    await page.getByRole("tooltip").filter({ hasText: /Months without this day are skipped/ }).waitFor()
    assert.ok(await policy(page))
    await rows(page, [["cron", { expression: "0 9 30 2 *" }]])
    await page.getByRole("alert").filter({ hasText: /^This calendar has no future slot\.$/ }).waitFor()
    assert.equal(await label(page, "Criterion 1 cron expression").getAttribute("aria-invalid"), "true")
    assert.equal(await policy(page), undefined)
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
    await rows(page, [["daily"], ["files-changed", { files: "a.ts" }]])
    for (const lock of ["uncertain", "passage", "launched-once", "terminal", "deleted"]) {
      await page.evaluate(lock => (window as any).schedulingFixture.lock(lock), lock)
      assert.equal(await label(page, "Criterion 1 type").isDisabled(), true)
      assert.equal(await handle(page, 2).isDisabled(), true)
      assert.equal(await page.getByRole("button", { name: "Add a criterion", exact: true }).isDisabled(), true)
      assert.ok((await page.getByRole("status").innerText()).length > 30)
    }
    await page.evaluate(() => { (window as any).schedulingFixture.lock(null); (window as any).schedulingFixture.capability("missing") })
    assert.equal(await policy(page), undefined)
    assert.equal(await page.getByRole("button", { name: "Add a criterion", exact: true }).isDisabled(), true)
    await page.getByRole("button", { name: "Remove criterion 2", exact: true }).click()
    await page.getByRole("button", { name: "Remove criterion 1", exact: true }).click()
    assert.deepEqual(await policy(page), { when: [] })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("monthly and time pairs wrap before their controls collapse at 220px and stay horizontal when wide", async () => {
  for (const locale of ["en", "fr", "he"]) {
    const { page, errors } = await setup(`?locale=${locale}`)
    try {
      await page.waitForFunction(locale => document.documentElement.lang.startsWith(locale), locale)
      await rows(page, [["monthly"], ["daily"], ["weekly"], ["files-changed", { files: "src/a.ts" }],
        ["cron", { expression: "*/15 * * * *" }], ["hours", { hours: "6" }]])
      await page.locator("main").evaluate(element => element.style.width = "100%")
      for (const width of [220, 640]) {
        await page.setViewportSize({ width, height: 1200 })
        const boxes = await page.locator('.mission-scheduling label:has(> :is(input:not([type="checkbox"]), textarea, select))').evaluateAll(labels => labels.map(label => {
          const text = label.querySelector(":scope > span"), input = label.querySelector(":scope > :is(input, textarea, select)")!
          const range = document.createRange()
          range.setStart(label, 0); range.setEndBefore(input)
          return { label: label.getBoundingClientRect().toJSON(), text: (text?.getBoundingClientRect() ?? range.getBoundingClientRect()).toJSON(),
            input: input.getBoundingClientRect().toJSON(), row: label.parentElement!.getBoundingClientRect().toJSON(),
            textFits: text ? text.scrollWidth <= text.clientWidth : label.scrollWidth <= label.clientWidth,
            rtl: getComputedStyle(label).direction === "rtl", name: input.getAttribute("aria-label") ?? "zone" }
        }))
        assert.equal(boxes.length, 8, "month day, monthly/daily/weekly time, files, cron, hours and saved zone are all measured")
        for (const box of boxes) {
          const context = `${locale} ${width}px ${JSON.stringify(box)}`
          assert.ok(box.input.width >= 100, context)
          assert.ok(box.input.height >= 24, context)
          assert.ok(box.label.left >= box.row.left && box.label.right <= box.row.right, context)
          assert.ok(box.input.left >= box.label.left && box.input.right <= box.label.right, context)
          assert.ok(box.input.left >= 0 && box.input.right <= width, context)
          assert.ok(box.text.top < box.input.bottom && box.input.top < box.text.bottom, "each label and field stays horizontal: " + context)
          assert.ok(box.rtl ? box.input.right < box.text.left : box.text.right < box.input.left, context)
          assert.equal(box.textFits, true, context)
        }
        assert.ok(width === 220 ? boxes[0].label.bottom < boxes[1].label.top : boxes[0].input.top === boxes[1].input.top,
          `${locale}: monthly pairs wrap only at the narrow width`)
        const overflow = await page.locator("main .window-body").evaluate(element => {
          const bounds = element.getBoundingClientRect()
          return { width: element.clientWidth, scrollWidth: element.scrollWidth, outside: [...element.querySelectorAll("label, input, textarea, select")]
            .filter(child => child.getBoundingClientRect().left < bounds.left || child.getBoundingClientRect().right > bounds.right)
            .map(child => ({ tag: child.tagName, name: child.getAttribute("aria-label"), box: child.getBoundingClientRect().toJSON() })) }
        })
        assert.ok(overflow.scrollWidth <= overflow.width, JSON.stringify(overflow))
        assert.equal(await page.locator('.mission-scheduling input[type="checkbox"]').count(), 7)
        assert.equal(await page.locator('.mission-scheduling input[type="checkbox"]').evaluateAll(inputs => inputs.every(input =>
          getComputedStyle(input).minInlineSize === "0px" && input.getBoundingClientRect().width < 32)), true, "weekday checkboxes keep their native size")
        const month = page.locator('input[type="number"]')
        await month.click(); await month.press("ControlOrMeta+A"); await month.pressSequentially("23")
        assert.equal(await month.inputValue(), "23")
        await month.press("Tab")
        const time = page.locator('input[type="time"]').first()
        assert.equal(await time.evaluate(element => element === document.activeElement), true)
        await time.press("Home"); await time.press("ArrowUp")
        assert.equal(await time.inputValue(), width === 220 ? "10:00" : "11:00", "keyboard changes the native time field")
        const saved = await policy(page)
        assert.equal(saved.when[0].expression, width === 220 ? "0 10 23 * *" : "0 11 23 * *")
        const files = page.locator(".mission-criterion textarea"), cron = page.locator('.mission-criterion input[maxlength="512"]')
        await files.click(); await files.press("ControlOrMeta+A"); await files.pressSequentially("src/edited.ts")
        await cron.click(); await cron.press("ControlOrMeta+A"); await cron.pressSequentially("*/20 * * * *")
        const hours = page.locator(".mission-criterion > label > select")
        await hours.focus(); await page.keyboard.press("Space"); await page.keyboard.press("Home")
        await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter")
        assert.equal(await files.inputValue(), "src/edited.ts")
        assert.equal(await cron.inputValue(), "*/20 * * * *")
        assert.equal(await hours.inputValue(), "2")
        const zone = page.locator(".mission-scheduling input[list]")
        await zone.click(); await zone.press("ControlOrMeta+A"); await zone.pressSequentially("Europe/Paris")
        assert.equal(await zone.inputValue(), "Europe/Paris")
        assert.equal(await zone.evaluate(element => element === document.activeElement), true)
        assert.ok(await policy(page), "all edited sibling controls still produce a valid policy")
        console.log(`scheduling boxes ${locale} ${width}px: ${JSON.stringify(boxes.map(({ name, input }) => ({ name, ...input })))}`)
      }
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  }
})

test("French light and Hebrew RTL remain readable at narrow widths without overflow", async () => {
  for (const locale of ["fr", "he"]) {
    const { page, errors } = await setup(`?locale=${locale}&light`)
    try {
      await page.setViewportSize({ width: 320, height: 1000 })
      await rows(page, [["branch-commits", { source: "refs/heads/dev" }], ["weekly"], ["files-changed", { files: "src/a.ts" }]])
      await page.waitForFunction(() => document.documentElement.lang.startsWith(new URLSearchParams(location.search).get("locale")!))
      assert.equal(await page.locator("main").evaluate(element => element.scrollWidth <= element.clientWidth), true)
      assert.equal(await page.locator("main").innerText().then(text => text.includes("missions.scheduling.")), false)
      await page.screenshot({ path: path.join(captures, `criteria-${locale}-light.png`), fullPage: true })
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  }
})

test("stored policies reopen in order, legacy frequency + condition reads as a schedule then a condition, retired options need explicit replacement", async () => {
  const { page, errors } = await setup()
  const load = (value: object) => page.evaluate(value => (window as any).schedulingFixture.load(value), value)
  try {
    const criteria = { when: [{ kind: "cron", expression: "15 09 * * MON,WED,FRI", zone: "UTC" }] }
    await load(criteria)
    assert.equal(await label(page, "Criterion 1 type").inputValue(), "weekly")
    assert.deepEqual(await policy(page), criteria)
    await load({ when: [{ kind: "cron", expression: "*/15 9-17 * * MON-FRI", zone: "UTC" }] })
    assert.equal(await label(page, "Criterion 1 cron expression").inputValue(), "*/15 9-17 * * MON-FRI")
    const legacy = { timing: { kind: "cron", expression: "0 9 * * *", zone: "UTC" },
      condition: { kind: "branch-commits", directory: "/fixture", ref: "refs/heads/dev" }, ends: { maxLaunches: null, afterMs: null, at: Date.parse("2027-01-01T00:00:00Z") } }
    await load(legacy)
    assert.equal(await label(page, "Criterion 1 type").inputValue(), "daily")
    assert.equal(await label(page, "Criterion 2 source").inputValue(), "refs/heads/dev")
    assert.equal(await roleOf(page, 2).innerText(), "if")
    assert.deepEqual(await policy(page), legacy, "an unchanged reopen keeps the stored bytes, end date included")
    await handle(page, 2).focus(); await page.keyboard.press("Alt+ArrowUp")
    assert.deepEqual(await policy(page), { when: [legacy.condition, legacy.timing] }, "an edit saves criteria without the end date")
    await load({ timing: { kind: "immediate" }, condition: legacy.condition, ends: { maxLaunches: null, afterMs: null, at: null } })
    assert.equal(await label(page, "Criterion 1 type").inputValue(), "branch-commits", "a condition alone reads as the trigger")
    const retired = { timing: { kind: "every", intervalMs: 5_400_000 }, condition: null, ends: { maxLaunches: 3, at: null, afterMs: null } }
    await load(retired)
    assert.deepEqual(await policy(page), retired)
    assert.equal(await page.getByRole("button", { name: "Add a criterion", exact: true }).count(), 0)
    assert.match(await page.locator(".mission-scheduling pre").innerText(), /5400000/)
    await page.evaluate(() => (window as any).schedulingFixture.lock("passage"))
    assert.equal(await page.getByRole("button", { name: "Replace with a new scheduling policy", exact: true }).isDisabled(), true)
    await page.evaluate(() => (window as any).schedulingFixture.lock(null))
    await page.getByRole("button", { name: "Replace with a new scheduling policy", exact: true }).click()
    assert.deepEqual(await policy(page), { when: [{ kind: "now" }] })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("retained policy explanation and exact JSON fit French/Hebrew narrow light views; invalid fields stay visible", async () => {
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
    await rows(page, [["hours", { hours: "0" }]])
    await page.getByRole("alert").waitFor()
    assert.equal(await label(page, "Criterion 1 hours").isVisible(), true)
    assert.equal(await policy(page), undefined)
  } finally { await page.close() }
})

test("scheduling help opens the localized guide by keyboard without reading the OpenCode login-start setting", async () => {
  for (const locale of ["en", "fr"]) {
    const supervision: string[] = []
    const { page, errors } = await setup(locale === "fr" ? "?locale=fr" : "", page => page.on("request", request => {
      if (new URL(request.url()).pathname.startsWith("/api/opencode/login-start")) supervision.push(request.method()) }))
    try {
      await page.waitForFunction(locale => document.documentElement.lang.startsWith(locale), locale)
      await rows(page, [["daily"]])
      await page.evaluate(() => {
        ;(window as any).schedulingOpens = []
        window.open = url => { (window as any).schedulingOpens.push(String(url)); return null }
      })
      const info = page.locator(".mission-scheduling-when-head").getByRole("link")
      await info.focus(); await page.keyboard.press("Enter")
      await page.waitForFunction(() => (window as any).schedulingOpens.length === 1)
      const opened = await page.evaluate(() => (window as any).schedulingOpens as string[])
      assert.match(opened[0], new RegExp(`/${locale}/missions\\.html#native-scheduling$`))
      await page.screenshot({ path: path.join(captures, `runtime-info-${locale}.png`) })
      assert.deepEqual(supervision, [], "help never reads the login-start setting")
      await page.evaluate(() => (window as any).schedulingFixture.lock("passage"))
      assert.equal(await info.isVisible(), true, "a lock keeps help available")
      await info.focus(); await page.keyboard.press("Enter")
      await page.waitForFunction(() => (window as any).schedulingOpens.length === 2)
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  }
})

test("the saved zone defaults to the system zone and is shown only once it differs, then stays while typing", async () => {
  const { page, errors } = await setup("?zone=system")
  try {
    const zone = label(page, "Saved time zone (IANA)")
    await rows(page, [["daily"]])
    assert.equal((await policy(page)).when[0].zone, "Europe/Paris", "the system zone is the default")
    assert.equal(await zone.count(), 0, "the system zone needs no field")
    await patch(page, { zone: "America/New_York" })
    await zone.waitFor()
    const suggestions = await zone.evaluate(input => [...((input as HTMLInputElement).list?.options ?? [])].map(option => option.value))
    assert.ok(suggestions.includes("Europe/Paris") && suggestions.includes("America/New_York"), "native time-zone suggestions")
    await zone.fill("Europe/Paris")
    assert.equal(await zone.evaluate(element => element === document.activeElement), true, "typing the system zone never hides the field")
    assert.equal((await policy(page)).when[0].zone, "Europe/Paris")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
