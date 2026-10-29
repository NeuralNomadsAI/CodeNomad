import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, baseUrl: string
before(async () => {
  const fixture = await borrowFixture({ name: "history", routes: [
    { path: "/fixture", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/history.tsx"></script></body></html>' },
  ] })
  baseUrl = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

function ranked(query: string, older = false) {
  return { version: 1, status: "ranked", scanned: 16_384, candidates: 600, judged: 600, skipped: 0, prefilterBypassed: 0,
    examinedBefore: older ? 16_384 : 0, cursor: older ? null : "opaque-older-window",
    matchedSessions: 10, capped: true, exclusions: ["unknown_directory"], hits: Array.from({ length: 40 }, (_, n) => ({
      sessionID: `other-session-${n % 10 + 1}`, messageID: `${older ? "older-" : ""}unloaded-${n + 1}`, role: "assistant", partIndex: 0, kind: "text",
      excerpt: `${older ? "Older workspace" : "Workspace"} ${query} answer ${n + 1}`, createdAt: n,
    })) }
}

test("conversation pages stay literal; workspace is one ranked list with Unicode marks, notices and destination highlighting", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const errors: string[] = [], literal: any[] = [], rankedReads: any[] = []
  let release!: () => void
  const pause = new Promise<void>(done => { release = done })
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", async route => {
    const url = route.request().url()
    if (url.endsWith("/session-history/ranked")) {
      const input = route.request().postDataJSON(); rankedReads.push(input)
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(input.query === "unsupported" ? { status: "unsupported" } : ranked(input.query, Boolean(input.cursor))) })
    }
    if (!url.endsWith("/session-history/query")) return route.fulfill({ contentType: "application/json", body: "{}" })
    const input = route.request().postDataJSON(); literal.push(input)
    const n = Number(input.cursor ?? 0)
    const result = { status: "page", scanned: 32, tools: 0, reasoning: 0, skipped: 0, candidates: [], hits: [] as any[], cursor: null as string | null }
    if (input.query === "needle") {
      if (!input.cursor) result.cursor = "1"
      else {
        if (n === 2) await pause
        result.hits = [{ sessionID: input.sessionID, messageID: `unloaded-${n}`, role: "assistant", partIndex: 0, kind: "text", excerpt: `Old needle answer ${n}` }]
        result.cursor = n < 34 ? String(n + 1) : null
      }
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(result) })
  })
  try {
    await page.goto(baseUrl)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.open())
    const input = page.getByRole("searchbox"), scope = page.getByRole("combobox", { name: "Search scope" })
    await input.waitFor()
    await page.getByRole("checkbox", { name: "Include tools and thinking" }).check()
    await page.getByRole("checkbox", { name: "Include tools and thinking" }).uncheck()
    assert.equal(literal.length + rankedReads.length, 0)
    await input.fill("needle")
    await page.getByText("Old needle answer 1", { exact: true }).waitFor()
    await page.getByText("This page: 1 results · 64 messages scanned", { exact: true }).waitFor()
    assert(await page.getByRole("button", { name: "Next results" }).isDisabled())
    const focused = await page.locator(".history-search-result").first().elementHandle()
    assert(focused); await focused.focus(); release()
    await page.getByText("Old needle answer 32", { exact: true }).waitFor()
    assert(await focused.evaluate(element => element.isConnected && document.activeElement === element))
    await focused.dispose()
    await page.getByRole("button", { name: "Next results" }).click()
    await page.getByText("Old needle answer 34", { exact: true }).waitFor()
    await page.getByText("This page: 2 results · 64 messages scanned", { exact: true }).waitFor()
    assert.equal(await page.locator(".history-search-session").count(), 0)
    assert(literal.every(request => request.sessionID === "s" && request.purpose === "search"))
    assert.equal(rankedReads.length, 0)

    await scope.selectOption("workspace")
    await page.getByText("Workspace needle answer 40", { exact: true }).waitFor()
    assert.equal(rankedReads.length, 1)
    const literalCount = literal.length
    await input.fill("café ÉTÉ")
    await page.getByText("Workspace café ÉTÉ answer 40", { exact: true }).waitFor()
    assert.equal(rankedReads.length, 2)
    assert.equal(literal.length, literalCount)
    assert(rankedReads.every(request => request.version === 1 && request.limit === 40 && request.includeTechnical === false && !request.cursor && !request.sessionID))
    assert.equal(await page.locator(".history-search-result").count(), 40)
    assert.deepEqual(await page.locator(".history-search-result").evaluateAll(rows => rows.map(row => row.textContent?.match(/answer (\d+)/)?.[1])), Array.from({ length: 40 }, (_, n) => String(n + 1)))
    assert.equal(await page.getByRole("button", { name: "Next results", exact: true }).count(), 0)
    await page.getByText("Best results: 40 · 16384 messages scanned", { exact: true }).waitFor()
    await page.getByText("Most recent 16384 messages examined, newest first per project location.", { exact: true }).waitFor()
    await page.getByText("Partial ranking: results cover only this examined window.", { exact: true }).waitFor()
    await page.getByText("Some directories were excluded by project ownership checks.", { exact: true }).waitFor()
    assert.equal(await page.locator(".history-search-result mark").count(), 80)
    const headers = page.locator(".history-search-session")
    await page.getByText("Conversation 10", { exact: true }).first().waitFor()
    assert.equal(await headers.count(), 40, "repeated sessions keep their ranked positions")
    assert.match(await headers.nth(0).innerText(), /Conversation 1\s*dev/)
    assert.match(await headers.nth(1).innerText(), /Conversation 2\s*feature\/search/)
    assert.match(await headers.nth(10).innerText(), /Conversation 1/)
    assert.equal((await headers.nth(2).innerText()).trim(), "Session unavailable")
    assert.doesNotMatch(await page.locator(".history-search-results").innerText(), /unloaded-|other-session-/)
    const labels = await page.evaluate(() => (window as any).fixture.sessionReads())
    assert.equal(labels.reads.length, 10); assert(labels.peak <= 4)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.snapshot()), { ids: ["resident"], loads: 0, previewReads: [] })

    await page.getByRole("button", { name: "Search further back", exact: true }).click()
    await page.getByText("Older workspace café ÉTÉ answer 40", { exact: true }).waitFor()
    assert.equal(rankedReads.at(-1).cursor, "opaque-older-window")
    assert.equal(rankedReads.at(-1).query, "café ÉTÉ")
    assert.equal(await page.getByText("Workspace café ÉTÉ answer 1", { exact: true }).count(), 0)
    await page.getByText("Messages 16385 to 32768 examined, newest first per project location. Results cover this window only.", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "Search further back", exact: true }).count(), 0)
    await input.fill("fresh")
    await page.getByText("Workspace fresh answer 40", { exact: true }).waitFor()
    assert.equal(rankedReads.at(-1).cursor, undefined)
    await page.getByText("Most recent 16384 messages examined, newest first per project location.", { exact: true }).waitFor()

    await input.fill("unsupported")
    await page.getByText("Ranked project search is unavailable in this runtime. Use conversation search.", { exact: true }).waitFor()
    assert.equal(literal.length, literalCount, "unsupported never falls back to literal workspace traversal")
    await scope.selectOption("session")
    await input.fill("needle")
    await page.getByText("Old needle answer 32", { exact: true }).waitFor()
    assert.equal(await page.locator(".history-ranked-note").count(), 0)
    await scope.selectOption("workspace")
    await input.fill("café ÉTÉ")
    await page.getByText("Workspace café ÉTÉ answer 20", { exact: true }).waitFor()
    await page.getByText("Workspace café ÉTÉ answer 2", { exact: true }).click()
    const preview = page.locator(".history-message-preview")
    const previewText = preview.locator("pre")
    await previewText.filter({ hasText: "Full selected historical message" }).waitFor()
    assert.equal(await previewText.textContent(), "Full selected historical message\nCaFé éTé")
    assert.deepEqual(await previewText.locator("mark.session-search-match").allTextContents(), ["CaFé", "éTé"])
    assert.equal(await page.evaluate(() => (window as any).fixture.showDestinationPreview()), "preview")
    await preview.getByRole("button", { name: "Open in session" }).click()
    await page.waitForFunction(() => (window as any).fixture.opened().active === "other-session-2")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.opened()), { active: "other-session-2", anchor: "unloaded-2", surface: "chat" })
    await page.getByText("Full café ÉTÉ destination", { exact: true }).waitFor()
    await page.waitForFunction(() => [...((CSS as any).highlights?.get("codenomad-search") ?? [])].map((range: Range) => range.toString()).includes("ÉTÉ"))
    assert.deepEqual(await page.evaluate(() => [...((CSS as any).highlights?.get("codenomad-search") ?? [])].map((range: Range) => range.toString())), ["café", "ÉTÉ"])
    assert.equal(await page.getByRole("searchbox").count(), 0)
    assert.deepEqual(errors, [])
  } catch (error) { console.error({ errors, literal, rankedReads, body: await page.locator("body").innerText() }); throw error }
  finally { release(); await page.close() }
})

test("older-window requests reset and cancel on query, scope, technical, close and session deactivation", async () => {
  const page = await browser.newPage(), held = new Map<string, () => void>(), reads: any[] = []
  await page.route("**/api/**", async route => {
    if (!route.request().url().endsWith("/session-history/ranked")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "page", scanned: 0, tools: 0, reasoning: 0, skipped: 0, candidates: [], hits: [], cursor: null }) })
    const input = route.request().postDataJSON(); reads.push(input)
    if (input.cursor) await new Promise<void>(resolve => held.set(input.query, resolve))
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(ranked(input.query, Boolean(input.cursor))) }).catch(() => {})
  })
  try {
    await page.goto(baseUrl); await page.waitForFunction(() => Boolean((window as any).fixture))
    for (const reason of ["query", "scope", "technical", "close", "inactive"]) {
      await page.evaluate(() => { (window as any).fixture.activate(); (window as any).fixture.open() })
      const input = page.getByRole("searchbox"), scope = page.getByRole("combobox", { name: "Search scope" })
      await input.fill(""); await scope.selectOption("workspace")
      await page.getByRole("checkbox", { name: "Include tools and thinking" }).uncheck()
      const query = `older-${reason}`
      await input.fill(query)
      await page.getByText(`Workspace ${query} answer 40`, { exact: true }).waitFor()
      assert.equal(reads.at(-1).cursor, undefined)
      const dispatched = page.waitForRequest(request => request.url().endsWith("/session-history/ranked") && Boolean(request.postDataJSON().cursor))
      await page.getByRole("button", { name: "Search further back", exact: true }).click(); await dispatched
      const aborted = page.waitForEvent("requestfailed", { predicate: request => request.url().endsWith("/session-history/ranked") && request.postDataJSON().query === query && Boolean(request.postDataJSON().cursor) })
      if (reason === "query") await input.fill("fresh")
      if (reason === "scope") await scope.selectOption("session")
      if (reason === "technical") await page.getByRole("checkbox", { name: "Include tools and thinking" }).check()
      if (reason === "close") await page.getByRole("button", { name: "Close search", exact: true }).click()
      if (reason === "inactive") await page.evaluate(() => (window as any).fixture.deactivate())
      await aborted; held.get(query)?.()
      assert.equal(await page.getByText(`Older workspace ${query} answer 1`, { exact: true }).count(), 0)
      if (reason === "technical") {
        await page.getByText(`Workspace ${query} answer 40`, { exact: true }).waitFor()
        assert.equal(reads.at(-1).cursor, undefined); assert.equal(reads.at(-1).includeTechnical, true)
      }
    }
    await page.evaluate(() => { (window as any).fixture.activate(); (window as any).fixture.open() })
    assert.equal(await page.getByRole("searchbox").inputValue(), "", "leaving the session resets search")
    await page.getByRole("searchbox").fill("older-inactive")
    await page.getByText("Workspace older-inactive answer 40", { exact: true }).waitFor()
    assert.equal(reads.at(-1).cursor, undefined)
  } finally { held.forEach(release => release()); await page.close() }
})

test("ranked requests cancel on query/scope change, dismissal and inactive views; late results stay hidden", async () => {
  const page = await browser.newPage()
  const held = new Map<string, () => void>(), started = new Map<string, () => void>(), reads: string[] = [], failures: string[] = []
  page.on("requestfailed", request => { if (request.url().endsWith("/session-history/ranked")) failures.push(request.postDataJSON().query) })
  await page.route("**/api/**", async route => {
    if (!route.request().url().endsWith("/session-history/ranked")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "page", scanned: 0, tools: 0, reasoning: 0, skipped: 0, candidates: [], hits: [], cursor: null }) })
    const input = route.request().postDataJSON(); reads.push(input.query)
    if (input.query.startsWith("held-")) await new Promise<void>(resolve => { held.set(input.query, resolve); started.get(input.query)?.() })
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(ranked(input.query)) }).catch(() => {})
  })
  try {
    await page.goto(baseUrl); await page.waitForFunction(() => Boolean((window as any).fixture))
    for (const reason of ["query", "scope", "close", "inactive"]) {
      await page.evaluate(() => (window as any).fixture.open())
      await page.getByRole("searchbox").fill("")
      await page.getByRole("combobox", { name: "Search scope" }).selectOption("workspace")
      const dispatched = new Promise<void>(resolve => started.set(`held-${reason}`, resolve))
      await page.getByRole("searchbox").fill(`held-${reason}`)
      await dispatched
      const aborted = page.waitForEvent("requestfailed", { predicate: request => request.url().endsWith("/session-history/ranked") && request.postDataJSON().query === `held-${reason}` })
      if (reason === "query") await page.getByRole("searchbox").fill("fresh")
      if (reason === "scope") await page.getByRole("combobox", { name: "Search scope" }).selectOption("session")
      if (reason === "close") await page.getByRole("button", { name: "Close search", exact: true }).click()
      if (reason === "inactive") await page.evaluate(() => (window as any).fixture.deactivate())
      await aborted
      held.get(`held-${reason}`)?.()
      assert.equal(await page.getByText(`Workspace held-${reason} answer 1`, { exact: true }).count(), 0)
    }
    assert.deepEqual(failures.filter(query => query.startsWith("held-")), ["held-query", "held-scope", "held-close", "held-inactive"])
  } finally { held.forEach(release => release()); await page.close() }
})

for (const failure of ["http400", "unsupported_storage", "unsupported", "restart_required"]) test(`expired older search restarts explicitly from newest (${failure})`, async () => {
  const page = await browser.newPage(), reads: any[] = []
  let expired = false
  await page.route("**/api/**", async route => {
    if (!route.request().url().endsWith("/session-history/ranked")) return route.fulfill({ contentType: "application/json", body: "{}" })
    const input = route.request().postDataJSON(); reads.push(input)
    if (input.cursor) {
      expired = true
      return route.fulfill({ status: failure === "http400" ? 400 : 200, contentType: "application/json", body: JSON.stringify(
        failure === "http400" ? { error: "Invalid ranked history cursor" }
          : failure === "unsupported_storage" ? { status: "blocked", reason: "unsupported_storage" } : { status: failure }) })
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(ranked(expired ? "recovered" : input.query)) })
  })
  try {
    await page.goto(baseUrl); await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.open())
    await page.getByRole("combobox", { name: "Search scope" }).selectOption("workspace")
    await page.getByRole("searchbox").fill("needle")
    await page.getByText("Workspace needle answer 40", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Search further back", exact: true }).click()
    const fresh = page.getByRole("button", { name: "Start fresh search", exact: true })
    await fresh.waitFor({ timeout: 2000 })
    await page.getByText("This search window expired or history changed. Start a fresh search from the newest messages.", { exact: true }).waitFor()
    assert.equal(reads.length, 2, "expiration never starts an automatic search")
    assert.equal(await page.locator(".message-search-popover").getByRole("button", { name: "Retry", exact: true }).count(), 0)
    await fresh.click()
    await page.getByText("Workspace recovered answer 40", { exact: true }).waitFor()
    assert.equal(reads.at(-1).cursor, undefined); assert.equal(reads.at(-1).query, "needle")
    await page.getByText("Most recent 16384 messages examined, newest first per project location.", { exact: true }).waitFor()
    assert.equal(await fresh.count(), 0)
  } finally { await page.close() }
})

test("ordinary older-search failures retry the same continuation", async () => {
  const page = await browser.newPage(), reads: any[] = []
  let failed = false
  await page.route("**/api/**", async route => {
    if (!route.request().url().endsWith("/session-history/ranked")) return route.fulfill({ contentType: "application/json", body: "{}" })
    const input = route.request().postDataJSON(); reads.push(input)
    if (input.cursor && !failed) { failed = true; return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Busy"}' }) }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(ranked(input.query, Boolean(input.cursor))) })
  })
  try {
    await page.goto(baseUrl); await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.open())
    await page.getByRole("combobox", { name: "Search scope" }).selectOption("workspace")
    await page.getByRole("searchbox").fill("needle")
    await page.getByText("Workspace needle answer 40", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Search further back", exact: true }).click()
    await page.locator(".message-search-popover").getByRole("button", { name: "Retry", exact: true }).click()
    await page.getByText("Older workspace needle answer 40", { exact: true }).waitFor()
    assert.equal(reads.length, 3); assert.equal(reads[2].cursor, reads[1].cursor)
    assert.equal(await page.getByRole("button", { name: "Start fresh search", exact: true }).count(), 0)
  } finally { await page.close() }
})
