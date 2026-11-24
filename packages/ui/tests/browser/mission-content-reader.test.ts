import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { createHash } from "node:crypto"
import { chromium, type Browser, type Page } from "playwright"
import type { MissionMap } from "../../../server/src/api-types"
import { armFixtureNavigationBudget } from "./mission-panel-route"
import { borrowFixture } from "./fixture-borrow"
import { panelMissions, missionContentFixture } from "./mission-content-fixture"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "mission-content-reader", routes: [{ path: "/mission-content-reader",
    html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/mission-content-reader.tsx\"></script></body></html>" }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

/** 3,000 lines between a head and a tail: about 240,000 characters, three content slices. */
const body = (letter: string, mark: string) => `HEAD_${mark}\n${`${letter.repeat(79)}\n`.repeat(3_000)}TAIL_${mark}`
const digest = (text: string) => createHash("sha256").update(text, "utf16le").digest("base64url")
function mission(id: string, objective: string, revision = 2): MissionMap {
  return { version: 1, id, projectID: "project", projectCanonical: "/fixture", objective, template: "custom", coordinatorSessionId: `coordinator-${id}`,
    status: "active", actors: [], tasks: [], reports: [], frontier: [], claims: [], revision, createdAt: 1, updatedAt: revision,
    history: [], historyTruncated: false } as MissionMap
}

interface ContentRead { missionID: string; field: string; offset: number; digest?: string }
/** The reader over `initial` maps, listed compact as the plugin's list returns them; content reads answer from the full maps. */
async function setup(initial: MissionMap[]) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 }, locale: "en-US" }), errors: string[] = []
  page.setDefaultTimeout(10_000)
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript("Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copiedText=text}}})")
  let values = initial, failing: ((read: ContentRead) => boolean) | undefined, unsupported = false
  const reads: ContentRead[] = [], held = new Map<string, Promise<void>>()
  await page.route("**/api/**", async route => {
    const request = route.request(), address = new URL(request.url())
    const content = missionContentFixture(request.url(), request.method(), values)
    if (content) {
      const [, missionID] = /\/missions\/([^/]+)\/content$/.exec(address.pathname)!
      const read = { missionID, field: address.searchParams.get("field")!, offset: Number(address.searchParams.get("offset")),
        ...(address.searchParams.get("digest") ? { digest: address.searchParams.get("digest")! } : {}) }
      reads.push(read)
      const wait = held.get(missionID)
      if (wait) { held.delete(missionID); await wait }
      if (failing?.(read)) return route.fulfill({ status: 503, json: { error: "Temporary read failure" } })
      if (unsupported) return route.fulfill({ json: { available: false, reason: "plugin-unavailable", missions: [] } })
      // A read the reader cancelled meanwhile is never answered.
      return route.fulfill({ json: content }).catch(() => undefined)
    }
    return route.fulfill({ json: address.pathname.endsWith("/missions")
      ? { available: true, projectID: "project", missions: panelMissions(values), generatedAt: 1, discardedEvents: 0, activity: { generatedAt: 1, missions: [] } } : {} })
  })
  await page.goto(url, { timeout: 30_000 })
  return {
    page, errors, reads,
    serve: (next: MissionMap[]) => { values = next },
    /** Content reads `predicate` names fail (503) until it is cleared. */
    fail: (predicate?: (read: ContentRead) => boolean) => { failing = predicate },
    /** Content reads answer as a plugin without them. */
    unsupported: (value: boolean) => { unsupported = value },
    /** The next content read of `missionID` waits until the returned release. */
    hold: (missionID: string) => { let release!: () => void; held.set(missionID, new Promise<void>(resolve => { release = resolve })); return () => release() },
  }
}
const show = (page: Page, missionId: string, kind = "overview", itemId?: string) =>
  page.evaluate(({ missionId, kind, itemId }) => (window as any).contentReader.show(missionId, kind, itemId), { missionId, kind, itemId })
const refresh = (page: Page) => page.evaluate(() => (window as any).contentReader.refresh())
const settle = (page: Page) => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)))
const section = (page: Page, label: string) => page.locator(".mission-reader article").filter({ has: page.getByRole("heading", { name: label, exact: true }) })
const objective = (page: Page) => page.locator(".mission-reader article").filter({ has: page.getByRole("heading", { name: "Objective", exact: true }) })
const shownText = (page: Page) => objective(page).locator(".markdown-body, pre").first().innerText()
const readerText = (page: Page) => page.locator(".mission-reader").innerText()
const objectiveReads = (reads: ContentRead[], missionID: string) => reads.filter(read => read.missionID === missionID && read.field === "objective")

test("a reader reads a multi-slice body in full only as its pages need, and a stale answer is fenced across a mission switch", { timeout: 60_000 }, async () => {
  const a = body("q", "A"), b = body("z", "B")
  const f = await setup([mission("a", a), mission("b", b)])
  try {
    await show(f.page, "a")
    await objective(f.page).getByText("HEAD_A").waitFor()
    assert.deepEqual(objectiveReads(f.reads, "a").map(read => read.offset), [0], "the first page needs only the first slice")
    const pages = objective(f.page).getByRole("spinbutton")
    assert.equal(await pages.getAttribute("max"), String(Math.ceil(a.length / 9_000)), "the page count is the whole body's")
    await pages.fill(await pages.getAttribute("max") as string)
    await objective(f.page).getByText("TAIL_A").waitFor()
    const slices = objectiveReads(f.reads, "a")
    assert.equal(slices.length, 3, "the last page reads the remaining slices, one at a time")
    assert.deepEqual(slices.slice(1).map(read => read.digest), [digest(a), digest(a)], "every later slice is pinned to the first slice's digest")
    assert.ok(slices[1].offset > 0 && slices[2].offset > slices[1].offset)
    await objective(f.page).getByRole("button", { name: "Copy" }).click()
    assert.equal(await f.page.evaluate(() => (window as any).copiedText), a, "Copy copies the whole body")

    // B's first slice is held: the reader shows that B is loading, never A's body in its place.
    const releaseB = f.hold("b")
    await show(f.page, "b")
    await objective(f.page).getByRole("status").waitFor()
    assert.ok(!(await readerText(f.page)).includes("HEAD_A") && !(await readerText(f.page)).includes("TAIL_A"), "no other mission's body")
    // Back to A before B answers: A's body shows at once from the cache, and B's late answer never lands.
    const before = f.reads.length
    await show(f.page, "a")
    await objective(f.page).getByText("HEAD_A").waitFor()
    assert.equal(f.reads.length, before, "an unchanged body shown again is not read again")
    releaseB()
    await f.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)))
    assert.ok((await shownText(f.page)).includes("HEAD_A") && !(await readerText(f.page)).includes("HEAD_B"))
    await show(f.page, "b")
    await objective(f.page).getByText("HEAD_B").waitFor()
    assert.ok(!(await readerText(f.page)).includes("HEAD_A"))
    // Nothing polls.
    const settled = f.reads.length
    await f.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 800)))
    assert.equal(f.reads.length, settled)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("a body changed between slices is never shown mixed: the reader shows the new value whole from its start", { timeout: 60_000 }, async () => {
  const first = body("q", "V1"), second = body("z", "V2")
  const f = await setup([mission("a", first)])
  try {
    await show(f.page, "a")
    await objective(f.page).getByText("HEAD_V1").waitFor()
    // Every text the section shows from now on, recorded as it renders.
    await f.page.evaluate(() => {
      const shown: string[] = (window as any).shownTexts = []
      new MutationObserver(() => {
        for (const article of document.querySelectorAll(".mission-reader article")) {
          if (article.querySelector("h3")?.textContent === "Objective") shown.push(article.querySelector(".markdown-body, pre")?.textContent ?? "")
        }
      }).observe(document.querySelector(".mission-reader")!, { subtree: true, childList: true, characterData: true })
    })
    // The value changes without the map knowing yet; the reader turns to the page across the first slice's end.
    f.serve([mission("a", second, 3)])
    const boundary = objectiveReads(f.reads, "a").length
    await objective(f.page).getByRole("spinbutton").fill("12")
    await objective(f.page).getByText("HEAD_V2").waitFor()
    const reads = objectiveReads(f.reads, "a").slice(boundary)
    assert.deepEqual(reads.map(read => [read.offset > 0, read.digest === undefined ? "first" : read.digest === digest(first) ? "old" : "new"]),
      [[true, "old"], [false, "first"], [true, "new"]], "the old continuation is refused and the new value read from its start")
    await objective(f.page).getByRole("spinbutton").fill("12")
    await f.page.waitForFunction(() => !document.querySelector(".mission-reader")?.textContent?.includes("HEAD_V2"))
    const page12 = await shownText(f.page)
    assert.ok(page12.includes("z") && !page12.includes("q"), "the page across the slice boundary is the new value's own")
    const shown = await f.page.evaluate(() => (window as any).shownTexts as string[])
    assert.ok(shown.length > 0)
    for (const text of shown) assert.ok(!(text.includes("q") && text.includes("z")), "no page ever joined two values")
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

const UNREADABLE = "This content could not be read."
const copiedText = (page: Page) => page.evaluate(() => (window as any).copiedText as string | undefined)

test("a failed continuation shows its error and Retry beside the page; a failed Copy ends, and a second Copy copies the whole body", { timeout: 60_000 }, async () => {
  // Escaped characters take six serialized characters each: this legal objective spans two slices.
  const escaped = `HEAD_COPY\n${`${"\u0001".repeat(79)}\n`.repeat(249)}TAIL_COPY`
  const f = await setup([mission("a", escaped)])
  try {
    f.fail(read => read.offset > 0)
    await show(f.page, "a")
    await objective(f.page).getByText("HEAD_COPY").waitFor()
    await objective(f.page).getByRole("button", { name: "Copy", exact: true }).click()
    await objective(f.page).getByText(UNREADABLE).waitFor()
    assert.ok((await shownText(f.page)).includes("HEAD_COPY"), "the last good page stays")
    await objective(f.page).locator(".window-toolbar").getByText("Failed", { exact: true }).waitFor()
    assert.equal(await objective(f.page).getByRole("button", { name: "Try again", exact: true }).count(), 1)
    assert.equal(await copiedText(f.page), undefined)
    // The failed Copy ended: a second click reads the rest and copies it.
    f.fail(undefined)
    const before = f.reads.length
    await objective(f.page).getByRole("button", { name: "Copy", exact: true }).click()
    await f.page.waitForFunction(() => (window as any).copiedText?.endsWith("TAIL_COPY"))
    assert.equal(await copiedText(f.page), escaped)
    assert.ok(f.reads.length > before)
    assert.equal(await objective(f.page).getByText(UNREADABLE).count(), 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("a refresh that fails keeps the last good page with its error, and Retry reads the newer body", { timeout: 60_000 }, async () => {
  const f = await setup([mission("a", "first objective")])
  try {
    await show(f.page, "a")
    await objective(f.page).getByText("first objective", { exact: true }).waitFor()
    f.serve([mission("a", "second objective", 3)]); f.fail(() => true)
    await refresh(f.page)
    await objective(f.page).getByText(UNREADABLE).waitFor()
    assert.equal(await objective(f.page).getByText("first objective", { exact: true }).count(), 1, "the retained page stays mounted")
    f.fail(undefined)
    await objective(f.page).getByRole("button", { name: "Try again", exact: true }).click()
    await objective(f.page).getByText("second objective", { exact: true }).waitFor()
    assert.equal(await objective(f.page).getByText(UNREADABLE).count(), 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("a plugin without content reads fails each section with Retry beside its last good page, never a map value; Retry reads once it answers", { timeout: 60_000 }, async () => {
  const report = (summary: string, evidence: string) => ({ id: "report", taskKey: "", sessionId: "coordinator-a", outcome: "completed" as const,
    summary, evidence: [evidence], next: [], createdAt: 1, delivery: "coordinator-readout" as const })
  const f = await setup([{ ...mission("a", "objective"), reports: [report("old summary", "old evidence")] }])
  try {
    await show(f.page, "a", "report", "report")
    await section(f.page, "Summary").getByText("old summary", { exact: true }).waitFor()
    await section(f.page, "Evidence").getByText("old evidence", { exact: true }).waitFor()
    f.serve([{ ...mission("a", "objective", 3), reports: [report("new summary", "new evidence")] }]); f.unsupported(true)
    await refresh(f.page)
    for (const label of ["Summary", "Evidence"]) await section(f.page, label).getByText(UNREADABLE).waitFor()
    await settle(f.page)
    assert.deepEqual([await section(f.page, "Summary").getByText("old summary", { exact: true }).count(),
      await f.page.locator(".mission-reader").getByText("new summary", { exact: true }).count()], [1, 0], "the last good page stays; the compact map holds no value to show")
    f.unsupported(false)
    for (const [label, text] of [["Summary", "new summary"], ["Evidence", "new evidence"]]) {
      await section(f.page, label).getByRole("button", { name: "Try again", exact: true }).click()
      await section(f.page, label).getByText(text, { exact: true }).waitFor()
    }
    assert.equal(await f.page.locator(".mission-reader").getByText(UNREADABLE).count(), 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("unrelated revisions read no unchanged body; a changed one is read once", { timeout: 60_000 }, async () => {
  const base = { ...mission("a", "objective text"), notes: "notes text" }
  const f = await setup([base])
  try {
    await show(f.page, "a")
    await section(f.page, "Notes").getByText("notes text", { exact: true }).waitFor()
    await objective(f.page).getByText("objective text", { exact: true }).waitFor()
    const settled = f.reads.length
    for (let revision = 3; revision <= 8; revision++) {
      f.serve([{ ...base, revision, updatedAt: revision }])
      await refresh(f.page)
      await settle(f.page)
    }
    assert.equal(f.reads.length, settled, "six unrelated revisions, no body read")
    f.serve([{ ...base, notes: "edited notes", revision: 9, updatedAt: 9 }])
    await refresh(f.page)
    await section(f.page, "Notes").getByText("edited notes", { exact: true }).waitFor()
    await settle(f.page)
    assert.deepEqual(f.reads.slice(settled).map(read => read.field), ["notes"], "only the changed body")
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})
