import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { prepareGitPrototypeAssets } from "./fixtures/git-history-assets.mjs"
import path from "node:path"
import { fileURLToPath } from "node:url"

let browser: Browser, url: string
before(async () => {
  prepareGitPrototypeAssets()
  const fixture = await borrowFixture({ name: "mermaid", routes: [{ path: "/fixture", html:
    '<html><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mermaid.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })
async function open() {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  const errors: string[] = [], requests: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("request", request => requests.push(request.url()))
  const monacoPublic = fileURLToPath(new URL("../../src/renderer/public", import.meta.url))
  await page.context().route(new RegExp("^[^?#]*//[^/]+/monaco(/vs/|\\.worker\\.js)"), route =>
    route.fulfill({ path: path.join(monacoPublic, decodeURIComponent(new URL(route.request().url()).pathname)) }))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  return { page, errors, requests }
}
const setText = (page: Page, text: string) => page.evaluate(text => (window as any).fixture.setText(text), text)
const graph = "flowchart TD\n A[Start] --> B[Complete task]\n B --> C{Review passed?}\n C -->|Yes| D[Done]\n C -->|No| B"
const fenced = (source: string, language = "mermaid") => `\`\`\`${language}\n${source}\n\`\`\``
async function diagram(page: Page) {
  const image = page.locator(".mermaid-diagram img")
  await image.waitFor({ timeout: 20_000 })
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".mermaid-diagram img")].every(image => image.complete && image.naturalWidth > 0))
  return image
}

test("Tiny loads on demand, renders mermaid/mmd fences, and preserves source controls and theme", async () => {
  const { page, errors, requests } = await open()
  try {
    await setText(page, fenced("const ordinary = 1", "javascript"))
    await page.locator(".markdown-code-block").waitFor()
    assert.equal(await page.locator(".mermaid-renderer-frame").count(), 0)
    assert.equal(requests.some(url => url.includes("mermaid.tiny.js")), false)
    await setText(page, fenced(graph))
    const image = await diagram(page)
    const svg = decodeURIComponent((await image.getAttribute("src"))!)
    assert.ok(svg.includes("Review") && svg.includes("passed?"), "the complete node label survives line wrapping")
    assert.equal(await page.locator(".markdown-code-block > pre").isVisible(), false)
    await page.getByRole("button", { name: "Show source", exact: true }).click()
    assert.equal(await page.locator(".markdown-code-block > pre").isVisible(), true)
    assert.equal(await page.locator(".markdown-code-block code").textContent(), graph)
    assert.equal(await page.locator(".code-block-copy").count(), 1)
    assert.equal(await page.locator(".code-block-wrap").count(), 1)
    await page.getByRole("button", { name: "Show diagram", exact: true }).click()
    const light = await image.getAttribute("src")
    await page.evaluate(() => (window as any).fixture.setDark(true))
    await diagram(page)
    assert.notEqual(await page.locator(".mermaid-diagram img").getAttribute("src"), light)
    await setText(page, fenced("sequenceDiagram\n Alice->>Bob: Hello", "mmd"))
    await diagram(page)
    assert.equal(await page.locator(".mermaid-renderer-frame").count(), 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("streaming stays as source, unsupported/oversized diagrams retain source, and stale work cannot publish", async () => {
  const { page, errors } = await open()
  try {
    await page.evaluate(() => (window as any).fixture.setStreaming(true))
    await setText(page, fenced(graph))
    await page.locator(".code-block-diagram").waitFor()
    assert.equal(await page.locator(".mermaid-renderer-frame").count(), 0)
    assert.equal(await page.locator(".code-block-diagram").isDisabled(), true)
    await page.evaluate(() => (window as any).fixture.setStreaming(false))
    await diagram(page)
    await setText(page, fenced("mindmap\n root((Unsupported))\n  Child"))
    await page.locator(".mermaid-error").waitFor()
    assert.equal(await page.locator(".markdown-code-block > pre").isVisible(), true)
    await setText(page, fenced(graph))
    await setText(page, "**New unrelated text**")
    await page.getByText("New unrelated text", { exact: true }).waitFor()
    assert.equal(await page.locator(".mermaid-diagram").count(), 0)
    await page.evaluate(source => (window as any).fixture.file(source), "flowchart TD\n" + "%% comment\n".repeat(5000))
    await page.locator(".mermaid-error").waitFor()
    assert.equal(await page.locator(".workspace-mermaid pre").isVisible(), true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("rendering is opaque/network-disabled and diagram data never becomes active host HTML", async () => {
  const { page, errors, requests } = await open()
  try {
    await setText(page, fenced('flowchart LR\n A["<img src=https://mermaid-exfil.invalid/secret onerror=parent.pwned=1>"] --> B[Safe]\n click B "https://mermaid-exfil.invalid/click"'))
    await page.waitForFunction(() => Boolean(document.querySelector(".mermaid-error")) || [...document.querySelectorAll<HTMLImageElement>(".mermaid-diagram img")].some(image => image.complete && image.naturalWidth > 0))
    assert.equal(await page.evaluate(() => (window as any).pwned), undefined)
    assert.equal(requests.some(url => url.includes("mermaid-exfil.invalid")), false)
    assert.equal(await page.locator(".markdown-body img[src^='https:']").count(), 0)
    assert.equal(await page.locator(".markdown-body a[href*='mermaid-exfil']").count(), 0)
    assert.equal(await page.locator(".mermaid-renderer-frame").getAttribute("sandbox"), "allow-scripts")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("mmd files use the same renderer and retain the editable source/preview switch", async () => {
  const { page, errors } = await open()
  try {
    await page.evaluate(source => (window as any).fixture.file(source), graph)
    await diagram(page)
    assert.equal(await page.locator(".workspace-file-view").count(), 1)
    await page.getByRole("button", { name: "Show source", exact: true }).click()
    await page.locator(".monaco-editor").waitFor()
    await page.getByRole("button", { name: "Show diagram", exact: true }).click()
    await diagram(page)
    assert.equal(await page.evaluate(() => (window as any).fixture.reads()), 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("bounded or unfinished fences stay source-only until the whole fence is available", async () => {
  const { page, errors } = await open()
  try {
    await page.evaluate(() => (window as any).fixture.setLimit(150))
    const complete = "flowchart TD\n A[First] --> B[Middle]\n" + "%% filler comment\n".repeat(30) + " B --> C[Last]"
    await setText(page, fenced(complete))
    await page.locator(".markdown-code-block > pre").waitFor()
    assert.equal(await page.locator(".code-block-diagram").count(), 0)
    assert.equal(await page.locator(".mermaid-diagram img").count(), 0)
    await page.getByRole("button", { name: "Show all", exact: true }).click()
    const image = await diagram(page)
    assert.ok(decodeURIComponent((await image.getAttribute("src"))!).includes("Last"))
    await setText(page, "```mermaid\nflowchart TD\n A --> B")
    await page.locator(".markdown-code-block > pre").waitFor()
    assert.equal(await page.locator(".code-block-diagram").count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("raw HTML cannot manufacture a trusted Mermaid fence or hide its displayed source", async () => {
  const { page, errors } = await open()
  try {
    const forged = `<div id="forged" class="markdown-code-block" data-language="mermaid" data-code="${encodeURIComponent("flowchart TD\n A[FORGED] --> B[FALSE]")}"><div class="code-block-actions"></div><pre><code>ACTUAL SOURCE</code></pre></div>`
    await setText(page, forged + "\n\n" + fenced(graph))
    await diagram(page)
    assert.equal(await page.locator("#forged pre").isVisible(), true)
    assert.equal(await page.locator("#forged .code-block-diagram").count(), 0)
    assert.equal(await page.locator("#forged img").count(), 0)
    assert.equal(await page.locator(".mermaid-diagram img").count(), 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a truncated closing line cannot masquerade as a complete fence", async () => {
  const { page, errors } = await open()
  try {
    await page.evaluate(() => (window as any).fixture.setLimit(100))
    await setText(page, "```mermaid\nflowchart TD\n A --> B\n```" + " ".repeat(200) + "NOT A CLOSING FENCE\n B --> C")
    await page.locator(".markdown-code-block > pre").waitFor()
    assert.equal(await page.locator(".code-block-diagram").count(), 0)
    await page.getByRole("button", { name: "Show all", exact: true }).click()
    await page.getByText(/NOT A CLOSING FENCE/).waitFor()
    assert.equal(await page.locator(".code-block-diagram").count(), 0)
    assert.equal(await page.locator(".mermaid-diagram img").count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("initialization timeout includes a stalled Tiny import and ignores late completion", async () => {
  const { page, errors } = await open()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route("**/*mermaid.tiny*", async route => { await held; await route.continue() })
  try {
    await page.clock.install()
    const requested = page.waitForRequest(request => request.url().includes("mermaid.tiny"))
    // File preview mounts one renderer consumer. Markdown's deferred highlight
    // pass can remount a fence and start an independent initialization attempt.
    await page.evaluate(source => (window as any).fixture.file(source), graph)
    const request = await requested
    await page.clock.fastForward(10_100)
    await page.locator(".mermaid-error").waitFor()
    assert.equal(await page.locator(".workspace-mermaid pre").isVisible(), true)
    await page.evaluate(() => (window as any).fixture.setFileView(false))
    release()
    await page.evaluate(async url => { await import(url) }, request.url())
    assert.equal(await page.locator(".mermaid-renderer-frame").count(), 0, "a timed-out import must not create a late iframe")
    await page.evaluate(source => (window as any).fixture.file(source), graph)
    await page.clock.resume()
    await diagram(page)
    assert.deepEqual(errors, [])
  } finally { release(); await page.close() }
})
