import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string, cacheDirectory: string
before(async () => {
  cacheDirectory = await mkdtemp(join(tmpdir(), "codenomad-markdown-latest-"))
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cacheDirectory,
    plugins: [{ name: "markdown-latest-instrumentation", enforce: "pre",
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
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => {
  await browser?.close()
  await server?.close()
  if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true })
})

async function open(run: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] })
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

test("latest bounded render still copies the complete original source", async () => open(async page => {
  const source = `**Bounded latest** ${"original source ".repeat(1400)}END-SOURCE`
  await page.evaluate(text => { const f = (window as any).fixture; f.burst(32); f.update(text, 70); f.releaseModule() }, source)
  await page.locator(".markdown-body strong").waitFor()
  assert.equal((await calls(page)).length, 1)
  assert.equal((await calls(page))[0].text.length, 10_000)
  assert.ok(!(await page.locator(".markdown-body").textContent())!.includes("END-SOURCE"))
  await page.locator(".markdown-source-copy").click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), source)
}))
