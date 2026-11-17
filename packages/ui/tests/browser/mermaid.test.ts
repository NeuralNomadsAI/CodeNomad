import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { prepareGitPrototypeAssets } from "./fixtures/git-history-assets.mjs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { contrastRatio } from "../../src/lib/color-contrast"

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
async function changedDiagram(page: Page, previous: string | null) {
  await page.waitForFunction(previous => {
    const image = document.querySelector<HTMLImageElement>(".mermaid-diagram img")
    return image?.complete && image.naturalWidth > 0 && image.getAttribute("src") !== previous
  }, previous)
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
    await page.evaluate(async () => {
      ;(window as any).fixture.setDark(true)
      const { serverApi } = await import("/src/lib/api-client.ts" as string)
      serverApi.patchStateOwner = async (_owner: string, patch: unknown) => patch
      await (await import("/src/stores/preferences.tsx" as string)).setThemePreference("dark")
    })
    await changedDiagram(page, light)
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

test("displayed fences and files follow contrast, palette revisions and forced colors", async () => {
  const { page, errors } = await open()
  try {
    await page.emulateMedia({ contrast: "no-preference", forcedColors: "none" })
    await setText(page, fenced(graph))
    const image = await diagram(page)
    const normal = await image.getAttribute("src")
    const button = page.locator(".code-block-diagram")
    await button.focus()
    const focusedControl = await button.elementHandle()
    await page.emulateMedia({ contrast: "more" })
    await changedDiagram(page, normal)
    await diagram(page)
    await page.waitForFunction(element => !element.isConnected, focusedControl)
    await page.waitForFunction(() => document.activeElement === document.querySelector(".code-block-diagram"))
    assert.equal(await button.evaluate(element => document.activeElement === element), true, "contrast retains the focused Markdown diagram control")
    const high = await image.getAttribute("src")
    const colors = await page.evaluate(async () => {
      const { resolveCssColor } = await import("/src/lib/css-color.ts" as string)
      return { text: resolveCssColor("--text-primary", "foreground"), border: resolveCssColor("--accent-text", "foreground") }
    })
    assert.ok(decodeURIComponent(high!).toUpperCase().includes(colors.text.toUpperCase()), "SVG labels use strengthened palette ink")
    assert.match(decodeURIComponent(high!), new RegExp(`stroke:\\s*${colors.border}`, "i"), "SVG borders follow the palette")
    await button.click()
    await page.evaluate(async () => {
      const { serverApi } = await import("/src/lib/api-client.ts" as string)
      serverApi.patchStateOwner = async (_owner: string, patch: unknown) => patch
      const preferences = await import("/src/stores/preferences.tsx" as string)
      await preferences.setThemePreference("dark")
      await preferences.setColorSchemePreference({ id: "fjord", appearance: "dark" })
    })
    await changedDiagram(page, high)
    assert.equal(await page.locator(".markdown-code-block > pre").isVisible(), true, "palette refresh retains source choice")
    await button.click()
    const palette = await image.getAttribute("src")
    await page.emulateMedia({ forcedColors: "active" })
    await changedDiagram(page, palette)
    await diagram(page)
    const forced = await image.getAttribute("src")
    const systemText = await page.evaluate(async () => (await import("/src/lib/css-color.ts" as string)).resolveCssColor("--text-primary", "foreground"))
    assert.ok(decodeURIComponent(forced!).toUpperCase().includes(systemText.toUpperCase()), "image SVG uses system ink")
    assert.match(decodeURIComponent(forced!), new RegExp(`stroke:\\s*${systemText}`, "i"), "image SVG borders use system ink")
    await page.emulateMedia({ forcedColors: "none", contrast: "no-preference" })
    await changedDiagram(page, forced)
    await diagram(page)
    // The standalone file viewer uses the same reactive renderer.
    await page.evaluate(source => (window as any).fixture.file(source), "sequenceDiagram\n Alice->>Bob: Keep this label")
    const fileImage = await diagram(page)
    const fileNormal = await fileImage.getAttribute("src")
    const fileButton = page.getByRole("button", { name: "Show source", exact: true })
    await fileButton.focus()
    const originalButton = await fileButton.elementHandle()
    await page.emulateMedia({ contrast: "more" })
    await changedDiagram(page, fileNormal)
    await diagram(page)
    assert.equal(await originalButton!.evaluate(element => element.isConnected && document.activeElement === element), true,
      "a diagram refresh preserves the file viewer's focused control")
    assert.equal(await page.evaluate(() => (window as any).fixture.reads()), 1, "contrast never reloads file contents")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("late contrast renders retain the last image and cannot overwrite a newer forced-colors render", async () => {
  const { page, errors } = await open()
  try {
    await page.emulateMedia({ contrast: "no-preference", forcedColors: "none" })
    await page.evaluate(source => (window as any).fixture.file(source), graph)
    const image = await diagram(page)
    const normal = await image.getAttribute("src")
    await page.evaluate(`(() => {
      const original = MessagePort.prototype.postMessage
      let held
      const publications = []
      const observer = new MutationObserver(() => {
        const src = document.querySelector(".mermaid-diagram img")?.getAttribute("src")
        if (src && publications.at(-1) !== src) publications.push(src)
      })
      observer.observe(document.querySelector(".mermaid-diagram"), { subtree: true, attributes: true, attributeFilter: ["src"], childList: true })
      MessagePort.prototype.postMessage = function (data, ...args) {
        if (data?.code && !held) {
          held = () => { MessagePort.prototype.postMessage = original; original.call(this, data, ...args) }
          window.heldMermaid = true
          return
        }
        return original.call(this, data, ...args)
      }
      window.mermaidRace = { release: () => held?.(), publications }
    })()`)
    await page.emulateMedia({ contrast: "more" })
    await page.waitForFunction(() => (window as any).heldMermaid)
    assert.equal(await image.getAttribute("src"), normal, "passive refresh keeps the last successful image")
    assert.equal(await page.locator(".mermaid-loading").count(), 0)
    await page.emulateMedia({ forcedColors: "active" })
    await page.waitForFunction(() => document.documentElement.dataset.contrast !== "more")
    const text = await page.evaluate(async () => (await import("/src/lib/css-color.ts" as string)).resolveCssColor("--text-primary", "foreground"))
    await page.evaluate(() => (window as any).mermaidRace.release())
    await changedDiagram(page, normal)
    const publications = await page.evaluate(() => (window as any).mermaidRace.publications as string[])
    assert.equal(publications.length, 1, "only the latest theme generation publishes")
    assert.ok(decodeURIComponent(publications[0]).toUpperCase().includes(text.toUpperCase()))
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("Gantt task states keep readable palette and system ink in the rendered SVG", async () => {
  const { page, errors } = await open()
  // An image document keeps its concrete SVG colors. Inspect its actual CSS in
  // a separate document without host styles or forced-color substitution.
  const svgPage = await browser.newPage({ forcedColors: "none" })
  const rows: { palette: string; mode: string; state: string; ratio: number; border: number }[] = []
  try {
    for (const [palette, appearance] of [["parchment", "light"], ["linen", "light"], ["clay", "dark"], ["fjord", "dark"]] as const) {
      await page.evaluate(async ({ palette, appearance }) => {
        const { serverApi } = await import("/src/lib/api-client.ts" as string)
        serverApi.patchStateOwner = async (_owner: string, patch: unknown) => patch
        const preferences = await import("/src/stores/preferences.tsx" as string)
        await preferences.setThemePreference(appearance)
        await preferences.setColorSchemePreference({ id: palette, appearance })
        ;(window as any).fixture.setDark(appearance === "dark")
      }, { palette, appearance })
      for (const mode of ["normal", "high", "forced"] as const) {
        await page.emulateMedia({
          colorScheme: appearance, contrast: mode === "normal" ? "no-preference" : "more",
          forcedColors: mode === "forced" ? "active" : "none",
        })
        await page.waitForFunction(mode => (document.documentElement.dataset.contrast === "more") === (mode === "high"), mode)
        // Unique source identity also fences any palette/media render still queued.
        await setText(page, fenced(`gantt
 title ${palette} ${mode}
 dateFormat YYYY-MM-DD
 todayMarker off
 section Tasks
 Normal :normal, 2026-01-01, 30d
 Done :done, completed, 2026-01-01, 30d
 Critical :crit, critical, 2026-01-01, 30d
 Done critical :done, crit, donecritical, 2026-01-01, 30d`))
        await diagram(page)
        await page.waitForFunction(title => decodeURIComponent(document.querySelector<HTMLImageElement>(".mermaid-diagram img")?.src ?? "").includes(title), `${palette} ${mode}`)
        const src = await page.locator(".mermaid-diagram img").getAttribute("src")
        await svgPage.setContent(decodeURIComponent(src!.slice(src!.indexOf(",") + 1)))
        const colors = await svgPage.evaluate(() => {
          return ["normal", "completed", "critical", "donecritical"].map(state => {
            const bar = document.querySelector<SVGGraphicsElement>(`#diagram-${state}`)!
            const text = document.querySelector<SVGGraphicsElement>(`#diagram-${state}-text`)!
            const style = getComputedStyle(bar), ink = getComputedStyle(text)
            const barBox = bar.getBBox(), textBox = text.getBBox()
            return {
              state, fill: style.fill, stroke: style.stroke, text: ink.fill,
              opacity: [style.opacity, style.fillOpacity, ink.opacity, ink.fillOpacity],
              inside: textBox.x >= barBox.x && textBox.x + textBox.width <= barBox.x + barBox.width,
            }
          })
        })
        const hex = (color: string) => "#" + color.match(/\d+/g)!.slice(0, 3)
          .map(channel => Number(channel).toString(16).padStart(2, "0")).join("").toUpperCase()
        for (const color of colors) {
          assert.equal(color.inside, true, `${palette}/${mode}/${color.state}: label is inside its measured bar`)
          assert.deepEqual(color.opacity, ["1", "1", "1", "1"], "no unmeasured task paint opacity")
          rows.push({ palette, mode, state: color.state, ratio: contrastRatio(hex(color.text), hex(color.fill)), border: contrastRatio(hex(color.stroke), hex(color.fill)) })
        }
      }
    }
    console.table(rows.map(row => ({ ...row, ratio: row.ratio.toFixed(2), border: row.border.toFixed(2) })))
    for (const row of rows) {
      assert.ok(row.ratio >= (row.mode === "normal" ? 4.5 : 7), `${row.palette}/${row.mode}/${row.state}: ${row.ratio.toFixed(2)}:1`)
      if (row.mode !== "normal") assert.ok(row.border >= 3, `${row.palette}/${row.mode}/${row.state} border: ${row.border.toFixed(2)}:1`)
    }
    assert.deepEqual(errors, [])
  } finally { await svgPage.close(); await page.close() }
})
