import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [shutdown.plugin, { name: "markdown-latest-instrumentation", enforce: "pre",
      configureServer(s) {
        s.middlewares.use("/fixture", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/markdown-latest-request.tsx"></script></body></html>'))
        })
      },
      async load(id) {
        if (process.env.CODENOMAD_MARKDOWN_BASELINE && id.replaceAll("\\", "/").endsWith("/src/components/markdown.tsx")) {
          return readFile(process.env.CODENOMAD_MARKDOWN_BASELINE, "utf8")
        }
      },
      transform(source, id) {
        if (!id.replaceAll("\\", "/").endsWith("/src/lib/markdown.ts")) return
        // Wrap, never replace, the real parser. Gates affect only module/result
        // delivery; every counted call executes the production renderMarkdown.
        assert.ok(source.includes("export async function renderMarkdown("))
        assert.ok(source.includes("export function hasPendingCodeHighlight(content: string): boolean {"))
        return source.replace("export async function renderMarkdown(", "async function actualRenderMarkdown(")
          .replace("export function hasPendingCodeHighlight(content: string): boolean {",
            "export function hasPendingCodeHighlight(content: string): boolean { (window as any).markdownAudit.pendingChecks++;") + `
          const audit = (window as any).markdownAudit;
          export async function renderMarkdown(...args: Parameters<typeof actualRenderMarkdown>) {
            audit.calls.push({ text: args[0], theme: currentTheme });
            const result = await actualRenderMarkdown(...args);
            if (audit.holdResults) await new Promise<void>(resolve => audit.results.push(resolve));
            return result;
          }
          audit.retry = triggerLanguageListeners;
          audit.moduleWaiting = true;
          await audit.moduleReady;
        `
      },
    }, solid()], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  shutdown.own(server)
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => {
  await browser?.close()
  await server?.close()
})

async function open(run: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ locale: "en-US", permissions: ["clipboard-read", "clipboard-write"] })
  const page = await context.newPage(), errors: string[] = []
  page.setDefaultTimeout(15_000)
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/*", route => {
    const request = new URL(route.request().url())
    if (request.origin !== new URL(url).origin) return route.abort("blockedbyclient")
    if (request.pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" })
    return route.continue()
  })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" })
    await page.waitForFunction(() => (window as any).fixture?.audit.moduleWaiting)
    await run(page)
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error("markdown-latest-fixture", errors)
    throw error
  } finally { await context.close() }
}
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
const calls = (page: Page) => page.evaluate(() => (window as any).fixture.audit.calls)

for (const sameKey of [false, true]) {
  test(`cold queued ${sameKey ? "same-key" : "versioned"} burst parses only the latest invocation`, async () => open(async page => {
    await page.evaluate(same => (window as any).fixture.burst(32, same), sameKey)
    assert.equal(await page.locator(".markdown-body").textContent(), sameKey ? "**Initial**" : "**Burst 32**", "fallback stays visible during module load")
    assert.deepEqual(await calls(page), [])
    await page.evaluate(() => (window as any).fixture.releaseModule())
    await page.locator(".markdown-body strong").waitFor()
    await settle(page)
    const observed = await calls(page)
    console.log("markdown-cold-burst", { sameKey, requests: 33, realParses: observed.length })
    assert.equal(observed.length, 1)
    assert.deepEqual(observed, [{ text: sameKey ? "**Initial**" : "**Burst 32**", theme: "light" }])
    assert.equal((await page.evaluate(() => (window as any).fixture.cached())).html, await page.locator(".markdown-body").innerHTML())
  }))
}

test("disposal during module load prevents every queued parse and cache write", async () => open(async page => {
  await page.evaluate(() => { const f = (window as any).fixture; f.burst(32); f.dispose(); f.releaseModule() })
  await settle(page)
  assert.deepEqual(await calls(page), [])
  assert.equal(await page.evaluate(() => (window as any).fixture.cached()), undefined)
  assert.equal(await page.locator(".markdown-body").count(), 0)
}))

test("warm bursts coalesce and cache hits invalidate already parsed same-key work", async () => open(async page => {
  await page.evaluate(() => (window as any).fixture.releaseModule())
  await page.locator(".markdown-body strong").waitFor()
  await page.evaluate(() => { const f = (window as any).fixture; f.audit.calls = []; f.burst(32) })
  await settle(page)
  console.log("markdown-warm-burst", { requests: 32, realParses: (await calls(page)).length })
  assert.equal((await calls(page)).length, 1)
  assert.deepEqual(await calls(page), [{ text: "**Burst 32**", theme: "light" }])
  await page.evaluate(() => (window as any).fixture.burst(1, true))
  await settle(page)
  assert.equal((await calls(page)).length, 1, "published global cache must satisfy same-key refreshes without another parse")
  await page.evaluate(() => { const f = (window as any).fixture; f.setDisableHighlight(false); f.audit.holdResults = true; f.update("**Held**", 33) })
  await page.waitForFunction(() => (window as any).fixture.audit.results.length === 1)
  await page.evaluate(() => { const f = (window as any).fixture; f.cacheLocal(); f.releaseResult() })
  await settle(page)
  assert.equal(await page.locator(".markdown-body strong").textContent(), "Local cache")
  assert.equal(await page.evaluate(() => (window as any).fixture.audit.pendingChecks), 0, "stale parsed work must skip the extra highlight lexer pass")
}))

test("same-key language retries fence older result delivery, and disposal fences the last result", async () => open(async page => {
  await page.evaluate(() => (window as any).fixture.releaseModule())
  await page.locator(".markdown-body strong").waitFor()
  await page.evaluate(() => { const f = (window as any).fixture; f.audit.holdResults = true; f.setDisableHighlight(false) })
  await page.waitForFunction(() => (window as any).fixture.audit.results.length === 1)
  await page.evaluate(() => { const a = (window as any).fixture.audit; a.retry(); a.retry(); a.retry() })
  await page.waitForFunction(() => (window as any).fixture.audit.results.length >= 2)
  assert.equal(await page.evaluate(() => (window as any).fixture.audit.results.length), 2, "same-key retries waiting on a warm module must coalesce too")
  await page.evaluate(() => (window as any).fixture.releaseResult(1))
  await settle(page)
  assert.equal(await page.evaluate(() => (window as any).fixture.audit.pendingChecks), 1)
  const notifications = await page.evaluate(() => (window as any).fixture.notifications())
  await page.evaluate(() => (window as any).fixture.releaseResult())
  await settle(page)
  assert.equal(await page.evaluate(() => (window as any).fixture.audit.pendingChecks), 1)
  assert.equal(await page.evaluate(() => (window as any).fixture.notifications()), notifications)
  await page.evaluate(() => { const f = (window as any).fixture; f.clearCache(); f.update("**Disposed result**", 50) })
  await page.waitForFunction(() => (window as any).fixture.audit.results.length === 1)
  await page.evaluate(() => { const f = (window as any).fixture; f.dispose(); f.releaseResult() })
  await settle(page)
  assert.equal(await page.evaluate(() => (window as any).fixture.audit.pendingChecks), 1)
  assert.equal(await page.evaluate(() => (window as any).fixture.cached()), undefined)
}))

test("real language completion and theme retries retain highlighted code, wrap and copy", async () => open(async page => {
  await page.evaluate(() => (window as any).fixture.releaseModule())
  await page.locator(".markdown-body strong").waitFor()
  await page.evaluate(() => { const f = (window as any).fixture; f.setDisableHighlight(false); f.update("```typescript\nconst latest = 851\n```", 60) })
  await page.locator(".markdown-body .shiki span").first().waitFor()
  const button = page.locator(".code-block-wrap")
  await button.click()
  assert.equal(await button.getAttribute("aria-pressed"), "false")
  await page.evaluate(() => { const f = (window as any).fixture; f.setDark(true); f.setDark(false); f.setDark(true) })
  await page.locator(".shiki.github-dark").waitFor()
  assert.equal(await button.getAttribute("aria-pressed"), "false")
  await page.locator(".code-block-copy").click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "const latest = 851")
  assert.ok((await page.evaluate(() => (window as any).fixture.cached()))?.html.includes("github-dark"))
}))

test("latest bounded render reveals the rest in place, keeping the rendered prefix until the full render lands", async () => open(async page => {
  const source = `**Bounded latest** ${"original source ".repeat(4000)}END-SOURCE`
  await page.evaluate(text => { const f = (window as any).fixture; f.burst(32); f.update(text, 70); f.releaseModule() }, source)
  await page.locator(".markdown-body strong").waitFor()
  assert.equal((await calls(page)).length, 1)
  assert.equal((await calls(page))[0].text.length, 50_000, "prose renders up to the Markdown bound")
  assert.ok(!(await page.locator(".markdown-body").textContent())!.includes("END-SOURCE"))
  assert.equal(await page.locator(".markdown-source-copy").count(), 0, "the copy-only workaround is gone")
  const notice = page.locator(".message-hidden-text")
  assert.match((await notice.textContent())!, /14,029 more characters hidden to keep this message responsive/)
  assert.equal(await page.evaluate(() => (window as any).fixture.cached()), undefined, "a bounded window never caches as the whole part version")

  await page.evaluate(() => { (window as any).fixture.audit.holdResults = true })
  const button = notice.getByRole("button", { name: "Show all", exact: true })
  assert.equal(await button.getAttribute("aria-describedby"), await notice.locator(".message-hidden-text-label").getAttribute("id"))
  await button.focus()
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => (window as any).fixture.audit.results.length === 1)
  await notice.waitFor({ state: "detached" })
  assert.equal(await page.locator(".markdown-body strong").count(), 1, "the rendered prefix stays instead of a plain-text fallback")
  assert.ok(!(await page.locator(".markdown-body").textContent())!.includes("END-SOURCE"))
  await page.evaluate(() => (window as any).fixture.releaseResult())
  await page.waitForFunction(() => document.querySelector(".markdown-body")?.textContent?.includes("END-SOURCE"))
  assert.equal((await calls(page)).at(-1).text, source)
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("markdown-body")), true, "focus moves to the revealed text")
  const cached = await page.evaluate(() => (window as any).fixture.cached())
  assert.equal(cached?.html, await page.locator(".markdown-body").innerHTML())
  assert.equal(cached?.text, undefined, "cache entries hold no slice of the source text")
}))

// CODENOMAD_MARKDOWN_BASELINE=<markdown.tsx> measures an earlier component; assertions then only log.
const baseline = Boolean(process.env.CODENOMAD_MARKDOWN_BASELINE)
const streamingProse = (length: number) => Array.from({ length: Math.ceil(length / 120) }, (_, index) =>
  `Paragraph ${index}: the **reply** keeps \`streaming\` with a [link](https://example.com) and detail.\n\n- item ${index}\n\n`).join("").slice(0, length)
const streamingCode = (length: number) => `Intro\n\n\`\`\`typescript\n${Array.from({ length: Math.ceil(length / 70) }, (_, index) =>
  `export const value${index} = compute(${index}, "text") // comment ${index}\n`).join("")}`.slice(0, length)

/** Streams `count` chunks of 80 characters 50 ms apart onto `base`; returns renders and main-thread time. */
async function streamChunks(page: Page, base: string, count = 10) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Performance.enable")
  const taskSeconds = async () => (await cdp.send("Performance.getMetrics")).metrics.find(metric => metric.name === "TaskDuration")!.value
  const rendersBefore = (await calls(page)).length
  const before = await taskSeconds()
  const final = await page.evaluate(async ({ base, count }) => {
    let text = base
    for (let index = 0; index < count; index++) {
      text += `CHUNK${String(index).padStart(2, "0")} `.padEnd(80, "z")
      ;(window as any).fixture.update(text, 1000 + index)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    await new Promise(resolve => setTimeout(resolve, 400))
    return text
  }, { base, count })
  const taskMs = (await taskSeconds() - before) * 1000
  const observed = await calls(page)
  return { final, renders: observed.length - rendersBefore, lastRendered: observed.at(-1)?.text as string, taskMs, perChunkMs: taskMs / count }
}

async function startStream(page: Page, base: string) {
  await page.evaluate(() => (window as any).fixture.releaseModule())
  await page.locator(".markdown-body strong").waitFor()
  // A first highlighted render loads the languages, as a completed reply above would.
  await page.evaluate(base => { const f = (window as any).fixture; f.setDisableHighlight(false); f.update(base, 999) }, base)
  await page.waitForFunction(() => document.querySelector(".markdown-body")?.getAttribute("data-markdown-highlight") === "true")
  await page.waitForTimeout(500)
  await page.evaluate(() => (window as any).fixture.setStreaming(true))
  await page.waitForTimeout(400)
}

for (const [kind, length] of [["prose", 9_000], ["code", 9_000]] as const) {
  test(`a short streaming ${kind} reply still renders every chunk, highlighted`, async () => open(async page => {
    const base = kind === "prose" ? streamingProse(length) : streamingCode(length)
    await startStream(page, base)
    const result = await streamChunks(page, base, 5)
    console.log("markdown-streaming", { kind, length, baseline, renders: result.renders, taskMs: Math.round(result.taskMs), perChunkMs: Math.round(result.perChunkMs) })
    assert.equal(result.lastRendered, result.final)
    if (baseline) return
    assert.equal(result.renders, 5, "every chunk renders at once")
    assert.equal(await page.locator(".markdown-body").getAttribute("data-markdown-highlight"), "true")
  }))
}

for (const kind of ["prose", "code"] as const) {
  test(`a long streaming ${kind} reply coalesces unhighlighted re-renders and renders the final text at once`, async () => open(async page => {
    const base = kind === "prose" ? streamingProse(45_000) : streamingCode(45_000)
    await startStream(page, base)
    const result = await streamChunks(page, base)
    console.log("markdown-streaming", { kind, length: 45_000, baseline, renders: result.renders, taskMs: Math.round(result.taskMs), perChunkMs: Math.round(result.perChunkMs) })
    assert.equal(result.lastRendered, result.final, "the latest text renders after the last chunk")
    await page.waitForFunction(() => document.querySelector(".markdown-body")?.textContent?.includes("CHUNK09"))
    if (baseline) return
    // 10 chunks over ~0.5 s: a leading render, then at most one per 200 ms (4, with slack for timer jitter).
    assert.ok(result.renders <= 5, `10 chunks 50 ms apart render at most once per 200 ms: ${result.renders}`)
    assert.equal(await page.locator(".markdown-body").getAttribute("data-markdown-highlight"), "false", "no highlighting while a long reply streams")
    const rendersBefore = (await calls(page)).length
    const final = `${result.final}FINAL-CHUNK`
    const completion = await page.evaluate(async text => {
      const f = (window as any).fixture, before = f.audit.calls.length
      // Leave one last chunk queued, then complete in the same task. With the module
      // already warm, completion starts the real parser in a microtask, before timers.
      f.update(text, 2000)
      const queued = f.audit.calls.length - before
      f.setStreaming(false)
      await Promise.resolve()
      return { queued, started: f.audit.calls.slice(before) }
    }, final)
    assert.equal(completion.queued, 0, "the last streaming chunk waits for the coalescing timer")
    assert.deepEqual(completion.started, [{ text: final, theme: "light" }], "completion flushes the latest text before any timer can run")
    await page.waitForFunction(() => document.querySelector(".markdown-body")?.getAttribute("data-markdown-highlight") === "true")
    await settle(page)
    assert.equal((await calls(page)).length, rendersBefore + 1)
    assert.equal((await calls(page)).at(-1).text, final)
    assert.ok((await page.locator(".markdown-body").textContent())?.includes("FINAL-CHUNK"), "the final highlighted content is displayed")
  }))
}
