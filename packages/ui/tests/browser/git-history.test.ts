import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { prepareGitPrototypeAssets } from "./fixtures/git-history-assets.mjs"

let server: ViteDevServer, browser: Browser, url: string
test("large Changes inventories keep the reader controls responsive", async () => {
  const page = await browser.newPage({ viewport: { width: 2000, height: 1120 } })
  try {
    await page.goto(url)
    await page.getByRole("treeitem", { name: "package.json", exact: true }).waitFor()
    // Prepare the local Monaco chunk before timing inventory interactions;
    // Vite's first compilation is not the packaged renderer's input latency.
    await page.getByRole("button", { name: "Aperçu du fichier · package.json", exact: true }).click()
    await page.locator('.workspace-file-view .view-line').first().waitFor()
    await page.getByRole("button", { name: "Retour à la conversation", exact: true }).click()
    await page.evaluate(async () => {
      const apiPath = "/src/lib/api-client.ts"
      const { serverApi } = await import(apiPath)
      serverApi.fetchWorktreeGitStatus = async () => Array.from({ length: 1600 }, (_, index) => ({
        path: `packages/electron-app/electron/main/file-${index}.test.ts`, originalPath: null,
        stagedStatus: null, stagedAdditions: 0, stagedDeletions: 0,
        unstagedStatus: "deleted", unstagedAdditions: 0, unstagedDeletions: 350,
      }))
      ;(window as any).fixture.invalidate()
    })
    await page.getByRole("button", { name: "Changements", exact: true }).click()
    await page.locator('.git-panel-file-row').nth(1599).waitFor({ state: "attached", timeout: 15000 })
    await page.getByRole("button", { name: "Workspace", exact: true }).click({ timeout: 5000 })
    await page.getByRole("button", { name: "Aperçu du fichier · package.json", exact: true }).click({ timeout: 5000 })
    await page.locator('.workspace-file-view .view-line').first().waitFor({ timeout: 5000 })
  } finally { await page.close() }
})
test("Workspace editing saves the exact directory, retains drafts and checks external changes", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const edit = async (text: string) => page.evaluate(text => {
    const editor = (window as any).monaco.editor.getEditors().find((editor: any) => editor.getModel()?.uri.toString().includes("workspace-editor"))
    editor.getModel().setValue(text)
    editor.focus()
  }, text)
  try {
    await page.goto(url)
    const eye = () => page.getByRole("button", { name: "Aperçu du fichier · package.json", exact: true })
    const save = () => page.getByRole("button", { name: "Enregistrer (Ctrl+S)", exact: true })
    await eye().click()
    await page.locator('.workspace-file-view .view-line').first().waitFor()
    await edit('{"edited": "écriture"}')
    await page.evaluate(() => (window as any).fixture.invalidate())
    await eye().click()
    await eye().click()
    await page.locator('.workspace-file-view .view-line').filter({ hasText: 'écriture' }).waitFor()
    await save().click()
    await page.waitForFunction(() => (window as any).fixture.calls.some((call: any) => call.kind === "save" && call.message.includes("écriture") && call.slug === "/CodeNomad"))
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('[aria-label="Enregistrer (Ctrl+S)"]')?.disabled)
    await edit('{"local": true}')
    await page.evaluate(async () => {
      const apiPath = "/src/lib/api-client.ts"
      const { serverApi } = await import(apiPath)
      await serverApi.writeWorkspaceFile("git-prototype", "package.json", '{"agent": true}', { directory: "/CodeNomad" })
    })
    await save().click()
    await page.getByRole("button", { name: "Annuler", exact: true }).click()
    assert.equal(await page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.kind === "save").length), 2)
    await save().click()
    await page.getByRole("button", { name: "Écraser", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.calls.filter((call: any) => call.kind === "save").length === 3)
    await edit('{"keyboard": true}')
    await page.keyboard.press("Control+s")
    await page.waitForFunction(() => (window as any).fixture.calls.some((call: any) => call.kind === "save" && call.message.includes("keyboard")))
    await edit('{"discard": true}')
    await page.locator('.workspace-file-view').getByRole("button", { name: "Actualiser", exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: "Actualiser", exact: true }).click()
    await page.locator('.workspace-file-view .view-line').filter({ hasText: 'keyboard' }).waitFor()
    assert.equal(await save().isDisabled(), true)
  } finally { await page.close() }
})
test("a pending save retains an undo to the original text after closing the real reader", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  try {
    await page.goto(url)
    const eye = () => page.getByRole("button", { name: "Aperçu du fichier · package.json", exact: true })
    await eye().click()
    await page.locator('.workspace-file-view .view-line').first().waitFor()
    await page.evaluate(async () => {
      const apiPath = "/src/lib/api-client.ts"
      const { serverApi } = await import(apiPath)
      const write = serverApi.writeWorkspaceFile
      serverApi.writeWorkspaceFile = async (...args: Parameters<typeof write>) => {
        ;(window as any).writeStarted = true
        await new Promise<void>(resolve => { (window as any).releaseWrite = resolve })
        await write(...args)
        serverApi.writeWorkspaceFile = write
      }
      const editor = (window as any).monaco.editor.getEditors().find((e: any) => e.getModel()?.uri.toString().includes("workspace-editor"))
      ;(window as any).originalText = editor.getValue()
      editor.setValue('{"saved": true}')
    })
    await page.getByRole("button", { name: "Enregistrer (Ctrl+S)", exact: true }).click()
    await page.waitForFunction(() => (window as any).writeStarted)
    await page.evaluate(() => {
      const editor = (window as any).monaco.editor.getEditors().find((e: any) => e.getModel()?.uri.toString().includes("workspace-editor"))
      editor.setValue((window as any).originalText)
    })
    await eye().click()
    await page.evaluate(() => (window as any).releaseWrite())
    await page.waitForFunction(() => (window as any).fixture.calls.some((call: any) => call.kind === "save"))
    await eye().click()
    await page.locator('.workspace-file-view .view-line').first().waitFor()
    assert.equal(await page.evaluate(() => {
      const editor = (window as any).monaco.editor.getEditors().find((e: any) => e.getModel()?.uri.toString().includes("workspace-editor"))
      return editor.getValue() === (window as any).originalText
    }), true)
    assert.equal(await page.getByRole("button", { name: "Enregistrer (Ctrl+S)", exact: true }).isEnabled(), true)
  } finally { await page.close() }
})

test("the eye-opened Changes reader follows staging without changing the selected row", async () => {
  const page = await browser.newPage({ viewport: { width: 1800, height: 960 } })
  try {
    await page.goto(url)
    await page.evaluate(async () => {
      const apiPath = "/src/lib/api-client.ts"
      const { serverApi } = await import(apiPath)
      const status = serverApi.fetchWorktreeGitStatus, stage = serverApi.stageWorktreeGitPaths
      let staged = false
      serverApi.fetchWorktreeGitStatus = async (...args: Parameters<typeof status>) => (await status(...args)).map(entry =>
        staged && entry.path.endsWith("git-history.css") ? { ...entry, stagedStatus: "modified", unstagedStatus: null } : entry)
      serverApi.stageWorktreeGitPaths = async (...args: Parameters<typeof stage>) => { const result = await stage(...args); staged = true; return result }
    })
    await page.getByRole("button", { name: "Changements", exact: true }).click()
    const selected = page.locator('.git-panel-file-row').filter({ hasText: "src/components/git-panel.tsx" })
    await selected.locator('.git-panel-file-main').click()
    const eye = page.getByRole("button", { name: "Aperçu du fichier · src/styles/panels/git-history.css", exact: true })
    await eye.click()
    await page.locator('.git-diff-content .line-insert').first().waitFor()
    await page.getByRole("button", { name: "Indexer le fichier · src/styles/panels/git-history.css", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.target()?.scope === "staged")
    assert.equal(await selected.locator('.git-panel-file-main').getAttribute("aria-current"), "true")
    assert.equal(await eye.getAttribute("aria-pressed"), "true")
    assert.equal(await page.evaluate(() => (window as any).fixture.target().path), "src/styles/panels/git-history.css")
  } finally { await page.close() }
})

test("returning to an invalidated worktree lazily refreshes cached Workspace rows", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  try {
    await page.goto(url)
    await page.getByRole("treeitem", { name: "package.json", exact: true }).waitFor()
    const selector = page.getByRole("combobox", { name: "Worktree à consulter" })
    await selector.selectOption("review")
    await page.waitForFunction(() => (window as any).fixture.calls.some((call: any) => call.kind === "files" && call.slug.endsWith("/review")))
    await page.evaluate(async () => {
      const apiPath = "/src/lib/api-client.ts"
      const { serverApi } = await import(apiPath)
      const list = serverApi.listWorkspaceFiles
      serverApi.listWorkspaceFiles = async (...args: Parameters<typeof list>) => {
        const entries = await list(...args)
        return args[2] === "/CodeNomad" && args[1] === "."
          ? entries.map(entry => entry.path === "package.json" ? { ...entry, name: "new.json", path: "new.json" } : entry) : entries
      }
      ;(window as any).fixture.invalidate()
    })
    await page.waitForFunction(() => (window as any).fixture.calls.filter((call: any) => call.kind === "files" && call.slug.endsWith("/review")).length >= 2)
    await selector.selectOption("root")
    await page.getByRole("treeitem", { name: "new.json", exact: true }).waitFor()
    assert.equal(await page.getByRole("treeitem", { name: "package.json", exact: true }).count(), 0)
  } finally { await page.close() }
})

before(async () => {
  prepareGitPrototypeAssets()
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    publicDir: fileURLToPath(new URL("../../src/renderer/public", import.meta.url)),
    plugins: [solid(), { name: "git-history-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/git-history.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

test("Changes restores independent disclosures and Git actions above the staged files", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Changements", exact: true }).click()
    const staged = page.locator('.git-drop-zone').nth(0)
    const unstaged = page.locator('.git-drop-zone').nth(1)
    const stagedHeader = staged.getByRole("button", { name: /Changements indexés/ })
    const unstagedHeader = unstaged.locator('.git-change-section-header')
    const input = staged.getByRole("textbox", { name: "Saisissez le message du commit" })
    await input.waitFor()
    assert.equal(await stagedHeader.getAttribute("aria-expanded"), "true")
    assert.equal(await unstagedHeader.getAttribute("aria-expanded"), "true")
    assert.equal(await page.locator('details.git-panel-actions').count(), 0)
    assert.equal(await staged.getByRole("group", { name: "Actions Git" }).evaluate(element =>
      Boolean(element.compareDocumentPosition(element.parentElement!.querySelector('.git-panel-file-row')!) & Node.DOCUMENT_POSITION_FOLLOWING)), true)
    const submit = staged.getByRole("button", { name: "Valider", exact: true })
    assert.equal(await submit.isDisabled(), true)
    await input.fill("Rétablir les sections Git")
    assert.equal(await submit.isEnabled(), true)
    const reads = await page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.kind === "status").length)
    await stagedHeader.click()
    assert.equal(await input.isVisible(), false)
    assert.equal(await unstaged.locator('.git-panel-file-row').isVisible(), true)
    await unstagedHeader.focus()
    await page.keyboard.press("Enter")
    assert.equal(await unstagedHeader.getAttribute("aria-expanded"), "false")
    assert.equal(await unstaged.locator('.git-panel-file-row').isVisible(), false)
    assert.equal(await page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.kind === "status").length), reads)
    await page.getByRole("button", { name: "Workspace", exact: true }).click()
    await page.getByRole("button", { name: "Changements", exact: true }).click()
    assert.equal(await stagedHeader.getAttribute("aria-expanded"), "false")
    assert.equal(await unstagedHeader.getAttribute("aria-expanded"), "false")
    await page.getByRole("button", { name: "Actualiser", exact: true }).click()
    await page.waitForFunction(reads => (window as any).fixture.calls.filter((call: any) => call.kind === "status").length > reads, reads)
    assert.equal(await stagedHeader.getAttribute("aria-expanded"), "false")
    await stagedHeader.click()
    assert.equal(await input.inputValue(), "Rétablir les sections Git")
    await submit.click()
    await page.waitForFunction(() => (window as any).fixture.calls.some((call: any) => call.kind === "submit" && call.message === "Rétablir les sections Git"))
    await stagedHeader.click()
    await unstagedHeader.click()
    // A collapsed section keeps its header as a real pointer drop target.
    const source = await unstaged.locator('.git-panel-file-main').boundingBox()
    const target = await stagedHeader.boundingBox()
    assert.ok(source && target)
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2 - 10, { steps: 4 })
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 })
    await page.mouse.up()
    await page.waitForFunction(() => (window as any).fixture.calls.some((call: any) => call.kind === "stage" && call.path === "src/styles/panels/git-history.css"))
    await stagedHeader.click()
    await staged.getByRole("button", { name: "Retirer de l'index · src/components/git-panel.tsx", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.calls.some((call: any) => call.kind === "unstage"))
  } finally { await page.close() }
})

test("Workspace actions measure the whole row and share the subtle rollover across Files modes", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0" })
  try {
    await page.addInitScript(() => {
      ;(window as any).__CODENOMAD_RUNTIME_HOST__ = "electron"
      ;(window as any).__CODENOMAD_WINDOW_CONTEXT__ = "local"
    })
    await page.goto(url)
    const row = page.locator('[role="treeitem"][data-path="README.md"]')
    const actions = row.locator('.file-row-actions')
    const setWidth = async (width: number) => {
      await page.locator('aside').evaluate((element, width) => {
        element.style.width = `${width}px`; element.style.minWidth = "0"; element.style.maxWidth = "none"
      }, width)
    }
    await setWidth(500)
    await row.hover()
    await page.waitForFunction(() => document.querySelector('[data-path="README.md"] .file-row-actions')?.getAttribute('data-compact') === "false")
    assert.equal(await actions.locator('.file-row-inline-actions button:visible').count(), 3)
    assert.equal(await actions.locator('.file-row-pinned-actions button:visible').count(), 1)
    assert.equal(await actions.locator('.action-overflow-trigger').isVisible(), false)
    const rollover = await row.evaluate(element => getComputedStyle(element).backgroundImage)
    assert.match(rollover, /linear-gradient/)
    await row.focus()
    const selectedBackground = await row.evaluate(element => getComputedStyle(element).backgroundColor)
    await page.mouse.move(10, 10)
    assert.equal(await row.evaluate(element => getComputedStyle(element).backgroundColor), selectedBackground)
    await actions.locator('.file-row-inline-actions button').first().hover()
    assert.equal(await actions.locator('.file-row-inline-actions button').first().evaluate(element => getComputedStyle(element).backgroundImage), rollover)
    await setWidth(160)
    const menu = actions.locator('.action-overflow-trigger')
    await menu.waitFor()
    assert.equal(await actions.locator('.file-row-inline-actions').evaluate(element => (element as HTMLElement).inert), true)
    await menu.click()
    await page.getByRole("menu").waitFor()
    await setWidth(500)
    assert.equal(await actions.getAttribute("data-compact"), "true", "open menu remains mounted after resize")
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => document.querySelector('[data-path="README.md"] .file-row-actions')?.getAttribute('data-compact') === "false")
    assert.equal(await actions.locator('.file-row-inline-actions').evaluate(element => (element as HTMLElement).inert), false)
    await page.evaluate(() => { document.documentElement.dir = "rtl"; document.body.style.zoom = "1.25" })
    await row.hover()
    assert.equal(await actions.getAttribute("data-compact"), "false")
    await page.getByRole("button", { name: "Changements", exact: true }).click()
    const file = page.locator('.git-panel-file-row').first()
    await file.hover()
    assert.equal(await file.evaluate(element => getComputedStyle(element).backgroundImage), rollover)
    if (process.env.CODENOMAD_GIT_CAPTURE) await page.screenshot({ path: `${process.env.CODENOMAD_GIT_CAPTURE}/changes-restored.png` })
  } finally { await page.close() }
})

test("clicked previews bypass blocked background scans and follow the live palette", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  try {
    await page.goto(url)
    await page.getByRole("treeitem", { name: "package.json", exact: true }).waitFor()
    await page.evaluate(async () => {
      const queuePath = "/src/lib/background-read-queue.ts"
      const { backgroundReads } = await import(queuePath)
      const releases: Array<() => void> = []
      for (let i = 0; i < 2; i++) void backgroundReads.run(new AbortController().signal,
        () => new Promise<void>(resolve => releases.push(resolve)))
      ;(window as any).releaseScans = () => releases.forEach(release => release())
    })
    const start = performance.now()
    await page.getByRole("button", { name: "Aperçu du fichier · package.json", exact: true }).click()
    await page.locator(".workspace-file-view .view-line").first().waitFor({ timeout: 5000 })
    console.log(`Cold file reader with blocked scans: ${Math.round(performance.now() - start)}ms`)
    await page.evaluate(() => (window as any).releaseScans())
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--surface-base", "#24313f")
      document.documentElement.style.setProperty("--status-success", "#68ac93")
    })
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".monaco-editor-background")!).backgroundColor === "rgb(36, 49, 63)")
    await page.getByRole("button", { name: /Changements/, exact: true }).click()
    assert.equal(await page.getByRole("button", { name: "Changements", exact: true }).innerText(), "Changements")
    await page.locator(".git-panel-count").waitFor()
    assert.equal(await page.locator(".git-panel-switch button").nth(1).evaluate(el => getComputedStyle(el).borderInlineStartWidth), "1px")
    assert.equal(await page.locator(".git-panel").evaluate(el => {
      const sample = document.createElement("span")
      sample.style.backgroundColor = "var(--surface-secondary)"
      el.append(sample)
      const matches = getComputedStyle(el).backgroundColor === getComputedStyle(sample).backgroundColor
      sample.remove()
      return matches
    }), true)
    await page.getByRole("button", { name: "Aperçu du fichier · src/styles/panels/git-history.css", exact: true }).click()
    await page.locator(".line-insert").first().waitFor()
    const inserted = await page.locator(".line-insert").first().evaluate(el => getComputedStyle(el).backgroundColor)
    assert.match(inserted, /104, 172, 147/)
    if (process.env.CODENOMAD_GIT_CAPTURE) await page.screenshot({ path: `${process.env.CODENOMAD_GIT_CAPTURE}/palette-diff.png` })
  } finally { await page.close() }
})

test("the shared eye toggles previews independently from row selection, including Git images", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  try {
    await page.goto(`${url}?images=1`)
    await page.getByRole("treeitem", { name: "image.png", exact: true }).click()
    assert.equal(await page.locator('.workspace-file-view').count(), 0, "row click selects without opening a reader")
    const eye = () => page.getByRole("button", { name: "Aperçu du fichier · image.png", exact: true })
    await eye().click()
    await page.waitForFunction(() => { const img = document.querySelector<HTMLImageElement>('.workspace-image img'); return img?.complete && img.naturalWidth > 0 })
    assert.equal(await eye().getAttribute("aria-pressed"), "true")
    const activeColor = await eye().evaluate(element => getComputedStyle(element).backgroundColor)
    assert.notEqual(activeColor, "rgba(0, 0, 0, 0)")
    await eye().click()
    assert.equal(await page.locator('.workspace-file-view').count(), 0)
    assert.equal(await eye().getAttribute("aria-pressed"), "false")
    await page.getByRole("button", { name: "Changements", exact: true }).click()
    await page.locator('.git-panel-file-main[title="image.png"]').click()
    assert.equal(await page.locator('.git-diff-view').count(), 0)
    await eye().click()
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.git-image-diff img')].length === 2
      && [...document.querySelectorAll<HTMLImageElement>('.git-image-diff img')].every(img => img.complete && img.naturalWidth > 0))
    assert.equal(await eye().getAttribute("aria-pressed"), "true")
    assert.equal(await eye().evaluate(element => getComputedStyle(element).backgroundColor), activeColor)
    const selectedRow = page.locator('.git-panel-file-row', { has: page.locator('.git-panel-file-main[title="image.png"]') })
    assert.ok((await selectedRow.getAttribute('class'))?.includes('git-panel-file-selected'))
    assert.equal(await selectedRow.locator('.git-panel-file-main').evaluate(element => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)", "selection background belongs to the full row, beneath its buttons")
    await page.getByRole("button", { name: "Retour à la conversation" }).click()
    assert.equal(await eye().getAttribute("aria-pressed"), "false")
    await page.getByRole("button", { name: "Commits", exact: true }).click()
    await page.getByRole("button", { name: /Make Git history the starting point/ }).click()
    await page.locator('.git-commit-files .git-panel-file-main[title="image.png"]').click()
    assert.equal(await page.locator('.git-image-diff').count(), 0)
    await eye().click()
    await page.locator('.git-image-diff img').first().waitFor()
    assert.equal(await eye().getAttribute("aria-pressed"), "true")
    assert.equal(await page.evaluate(() => (window as any).fixture.target().commit), "1".repeat(40))
    if (process.env.CODENOMAD_GIT_CAPTURE) await page.screenshot({ path: `${process.env.CODENOMAD_GIT_CAPTURE}/git-image-preview.png` })
    await eye().click()
    assert.equal(await page.locator('.git-image-diff').count(), 0)
  } finally { await page.close() }
})

test("reopening an ancestor revalidates its expanded descendants without reading collapsed folders", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(url)
    await page.getByRole("treeitem", { name: "src", exact: true }).click()
    await page.getByRole("treeitem", { name: "components", exact: true }).click()
    await page.getByRole("treeitem", { name: "git-panel.tsx", exact: true }).waitFor()
    await page.getByRole("treeitem", { name: "src", exact: true }).click()
    await page.evaluate(async () => {
      const modulePath = "/src/lib/api-client.ts"
      const { serverApi } = await import(modulePath)
      const read = serverApi.listWorkspaceFiles
      serverApi.listWorkspaceFiles = async (...args: any[]) => {
        const entries = await read(...args)
        return args[1] === "src/components"
          ? [{ name: "new.ts", path: "src/components/new.ts", type: "file" }] : entries
      }
      ;(window as any).fixture.invalidate()
    })
    await page.waitForFunction(() => (window as any).fixture.calls.filter((call: any) => call.kind === "files" && call.path === ".").length >= 2)
    await page.getByRole("treeitem", { name: "src", exact: true }).click()
    await page.getByRole("treeitem", { name: "new.ts", exact: true }).waitFor()
    assert.equal(await page.getByRole("treeitem", { name: "git-panel.tsx", exact: true }).count(), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.calls.some((call: any) => call.kind === "files" && call.path === "src/styles")), false)
  } finally { await page.close() }
})

test("the shared branch label follows current inventory while history is inactive", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Commits", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.calls.some((call: any) => call.kind === "history"))
    await page.getByRole("button", { name: /Changements/ }).click()
    await page.evaluate(async () => {
      const apiPath = "/src/lib/api-client.ts", storePath = "/src/stores/worktrees.ts"
      const { serverApi } = await import(apiPath), { reloadWorktrees } = await import(storePath)
      const previous = await serverApi.fetchWorktrees("git-prototype")
      serverApi.fetchWorktrees = async () => ({ ...previous, worktrees: previous.worktrees.map((entry: any) => ({ ...entry, branch: "new-current-branch" })) })
      await reloadWorktrees("git-prototype")
    })
    await page.waitForFunction(() => document.querySelector(".git-panel-context")?.textContent?.includes("new-current-branch"))
    assert.equal(await page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.kind === "history").length), 1)
  } finally { await page.close() }
})

test("history and local changes open the central diff and preserve the conversation draft", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.route("https://cdn.jsdelivr.net/**", route => route.abort())
    await page.goto(url)
    const history = page.getByRole("button", { name: "Commits", exact: true })
    await history.waitFor()
    assert.equal(await page.getByRole("button", { name: "Workspace", exact: true }).getAttribute("aria-pressed"), "true")
    await history.click()
    await page.getByRole("textbox", { name: "Brouillon" }).fill("Ne pas perdre ce brouillon")
    if (process.env.CODENOMAD_GIT_CAPTURE) await page.screenshot({ path: `${process.env.CODENOMAD_GIT_CAPTURE}/history.png` })
    await page.getByRole("button", { name: /Make Git history the starting point/ }).click()
    await page.getByRole("button", { name: "Aperçu du fichier · src/components/git-panel.tsx", exact: true }).click()
    await page.locator(".git-diff-view .monaco-diff-editor").waitFor()
    await page.locator(".git-diff-view .line-insert").first().waitFor()
    assert.ok(await page.locator("main .git-diff-view").isVisible())
    if (process.env.CODENOMAD_GIT_CAPTURE) await page.screenshot({ path: `${process.env.CODENOMAD_GIT_CAPTURE}/commit-diff.png` })
    await page.getByRole("button", { name: "Retour à la conversation" }).click()
    assert.equal(await page.getByRole("textbox", { name: "Brouillon" }).inputValue(), "Ne pas perdre ce brouillon")
    await page.getByRole("button", { name: /Changements/ }).click()
    await page.getByRole("button", { name: "Aperçu du fichier · src/styles/panels/git-history.css", exact: true }).click()
    await page.locator(".git-diff-view .monaco-diff-editor").waitFor()
    await page.locator(".git-diff-view .line-insert").first().waitFor()
    assert.equal(await page.evaluate(() => (window as any).fixture.target().scope), "unstaged")
    assert.equal(await page.evaluate(() => (window as any).fixture.target().commit), undefined)
    if (process.env.CODENOMAD_GIT_CAPTURE) await page.screenshot({ path: `${process.env.CODENOMAD_GIT_CAPTURE}/local-diff.png` })
    await page.getByRole("button", { name: "Commits", exact: true }).first().click()
    assert.ok(await page.locator(".git-commit-summary").isVisible(), "switching views retains the selected commit")
    await page.getByRole("combobox", { name: "Worktree à consulter" }).selectOption("review")
    await page.waitForFunction(() => !document.querySelector(".git-diff-view"))
    assert.ok(await page.getByRole("button", { name: /Merge pull request/ }).isVisible())
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a slow commit cannot replace the history after browsing another worktree", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Commits", exact: true }).click()
    await page.getByRole("button", { name: /Make Git history/ }).waitFor()
    await page.evaluate(() => (window as any).fixture.holdCommit())
    await page.getByRole("button", { name: /Make Git history/ }).click()
    await page.getByRole("combobox", { name: "Worktree à consulter" }).selectOption("review")
    await page.evaluate(() => (window as any).fixture.releaseCommit())
    await page.getByRole("button", { name: /Merge pull request/ }).waitFor()
    assert.equal(await page.locator(".git-commit-summary").count(), 0)
  } finally { await page.close() }
})

test("Workspace retains its expanded tree across modes and previews source, Markdown and images above the draft", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.route("https://cdn.jsdelivr.net/**", route => route.abort())
    await page.goto(url)
    await page.getByRole("textbox", { name: "Brouillon" }).fill("Brouillon conservé")
    await page.getByRole("treeitem", { name: ".github", exact: true }).click()
    await page.getByRole("treeitem", { name: "workflows", exact: true }).click()
    await page.getByRole("button", { name: "Aperçu du fichier · .github/workflows/update-winget.yml", exact: true }).click()
    await page.locator(".workspace-file-view .view-lines").filter({ hasText: "Update Winget" }).waitFor()
    assert.equal(await page.evaluate(() => (window as any).monaco.editor.getEditors().filter((editor: any) => editor.getModel()?.uri.toString().includes("workspace-editor")).every((editor: any) => !editor.getRawOptions().readOnly)), true)
    if (process.env.CODENOMAD_GIT_CAPTURE) await page.screenshot({ path: `${process.env.CODENOMAD_GIT_CAPTURE}/workspace-source.png` })
    await page.getByRole("button", { name: /Changements/ }).click()
    await page.getByRole("button", { name: "Workspace", exact: true }).click()
    assert.ok(await page.getByRole("treeitem", { name: "update-winget.yml", exact: true }).isVisible())
    await page.getByRole("button", { name: "Aperçu du fichier · README.md", exact: true }).click()
    await page.locator(".workspace-markdown").getByRole("heading", { name: "CodeNomad", exact: true }).waitFor()
    await page.getByRole("treeitem", { name: "dev-docs", exact: true }).click()
    await page.getByRole("treeitem", { name: "ui-harmonization-demo", exact: true }).click()
    await page.getByRole("button", { name: "Aperçu du fichier · dev-docs/ui-harmonization-demo/palette.svg", exact: true }).click()
    await page.waitForFunction(() => { const img = document.querySelector<HTMLImageElement>(".workspace-image img"); return img?.complete && img.naturalWidth > 0 })
    assert.equal(await page.getByRole("textbox", { name: "Brouillon" }).inputValue(), "Brouillon conservé")
    if (process.env.CODENOMAD_GIT_CAPTURE) await page.screenshot({ path: `${process.env.CODENOMAD_GIT_CAPTURE}/workspace-image.png` })
    await page.getByRole("button", { name: "Retour à la conversation" }).click()
    assert.equal(await page.locator(".workspace-file-view").count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("real SessionView keeps its composer while file previews are fenced by session and worktree", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(`${url}?session=1`)
    const composer = page.locator(".session-view textarea:visible").first()
    await composer.fill("Mon brouillon dans le vrai composeur")
    await page.getByRole("button", { name: "Aperçu du fichier · README.md", exact: true }).click()
    await page.locator(".workspace-markdown h1").waitFor()
    assert.equal(await composer.inputValue(), "Mon brouillon dans le vrai composeur")
    await page.getByRole("button", { name: "Retour à la conversation" }).click()
    assert.equal(await composer.inputValue(), "Mon brouillon dans le vrai composeur")
    await page.evaluate(() => (window as any).fixture.holdFile())
    await page.getByRole("button", { name: "Aperçu du fichier · README.md", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.calls.filter((call: any) => call.kind === "file").length >= 2)
    await page.evaluate(() => { (window as any).fixture.switchSession("other"); (window as any).fixture.releaseFile() })
    await page.waitForFunction(() => !document.querySelector(".workspace-file-view"))
    assert.equal(await composer.inputValue(), "")
    await page.evaluate(() => (window as any).fixture.switchSession("session"))
    assert.equal(await composer.inputValue(), "Mon brouillon dans le vrai composeur")
    await page.getByRole("button", { name: "Aperçu du fichier · README.md", exact: true }).click()
    await page.locator(".workspace-markdown h1").waitFor()
    const before = await page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.kind === "file").length)
    await page.evaluate(() => (window as any).fixture.invalidate())
    await page.waitForFunction(before => (window as any).fixture.calls.filter((call: any) => call.kind === "file").length > before, before)
    await page.getByRole("combobox", { name: "Worktree à consulter" }).selectOption("review")
    assert.equal(await page.locator(".workspace-file-view").count(), 0)
    assert.equal(await composer.inputValue(), "Mon brouillon dans le vrai composeur")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("central diff inserts local lines and revision-qualified history into the real session composer", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.stack ?? error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(`${url}?session=1`)
    const composer = page.locator(".session-view textarea.prompt-input")
    await composer.fill("Conserver ce brouillon")
    await page.getByRole("button", { name: /Changements/ }).click()
    await page.getByRole("button", { name: "Aperçu du fichier · src/components/git-panel.tsx", exact: true }).click()
    const modifiedLine = page.locator(".git-diff-view .editor.modified .view-line").filter({ hasText: 'title: "Git"' })
    await modifiedLine.click()
    await page.keyboard.press("Home")
    await page.keyboard.press("Shift+End")
    const insert = page.getByRole("button", { name: "Ajouter au prompt", exact: true })
    await insert.click()
    assert.match(await composer.inputValue(), /Conserver ce brouillon/)
    assert.match(await composer.inputValue(), /Git Diff: Worktree: \/CodeNomad : File: src\/components\/git-panel.tsx : 3-3/)
    assert.equal(await composer.evaluate(element => element === document.activeElement), true)

    // Native editor keyboard selection must keep the full range, not just the hovered line.
    await page.getByRole("button", { name: "Aperçu du fichier · src/styles/panels/git-history.css", exact: true }).click()
    await modifiedLine.click()
    await page.keyboard.press("Control+Home")
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("Shift+ArrowDown")
    await page.keyboard.press("Shift+ArrowDown")
    await insert.click()
    assert.match(await composer.inputValue(), /Git Diff: Worktree: \/CodeNomad : File: src\/styles\/panels\/git-history.css : 3-5/)

    await page.getByRole("button", { name: "Commits", exact: true }).first().click()
    await page.getByRole("button", { name: /Make Git history the starting point/ }).click()
    await page.getByRole("button", { name: "Aperçu du fichier · src/components/git-panel.tsx", exact: true }).click()
    await modifiedLine.click()
    await page.keyboard.press("Home")
    await page.keyboard.press("Shift+End")
    await insert.click()
    assert.ok((await composer.inputValue()).includes(`Git Diff: Commit: ${"1".repeat(40)} : Worktree: /CodeNomad : File: src/components/git-panel.tsx : 3-3`))
    // The inventory's native service path is the prompt authority, not the
    // Windows filesystem translation used by the preview reader for WSL.
    await page.evaluate(async () => {
      const apiPath = "/src/lib/api-client.ts", storePath = "/src/stores/worktrees.ts"
      const { serverApi } = await import(apiPath), { reloadWorktrees } = await import(storePath)
      const previous = await serverApi.fetchWorktrees("git-prototype")
      serverApi.fetchWorktrees = async () => ({ ...previous, worktrees: previous.worktrees.map((entry: any) => entry.slug === "review"
        ? { ...entry, directory: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\review", serviceDirectory: "/home/dev/review" } : entry) })
      await reloadWorktrees("git-prototype")
    })
    await page.getByRole("combobox", { name: "Worktree à consulter" }).selectOption("review")
    await page.getByRole("button", { name: /Changements/ }).click()
    await page.getByRole("button", { name: "Aperçu du fichier · src/components/git-panel.tsx", exact: true }).click()
    await modifiedLine.click()
    await page.keyboard.press("Home")
    await page.keyboard.press("Shift+End")
    await insert.click()
    const draft = await composer.inputValue()
    assert.ok(draft.includes("Git Diff: Worktree: /home/dev/review : File: src/components/git-panel.tsx : 3-3"))
    assert.equal(draft.includes("wsl.localhost"), false)
    assert.equal(await page.evaluate(async () => {
      const storePath = "/src/stores/session-state.ts"
      const { sessions } = await import(storePath)
      return sessions().get("git-prototype").get("session").location.directory
    }), "/CodeNomad")
    await page.getByRole("button", { name: "Retour à la conversation" }).click()
    assert.equal(await composer.inputValue(), draft)
    await page.evaluate(() => (window as any).fixture.switchSession("other"))
    assert.equal(await composer.inputValue(), "")
    await page.evaluate(() => (window as any).fixture.switchSession("session"))
    assert.equal(await composer.inputValue(), draft)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("Workspace keyboard focus survives lazy expansion and refresh, including RTL", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 800 } })
  try {
    await page.goto(url)
    const folder = page.getByRole("treeitem", { name: ".github", exact: true })
    await folder.focus()
    await page.keyboard.press("ArrowRight")
    await page.getByRole("treeitem", { name: "workflows", exact: true }).waitFor()
    assert.equal(await folder.evaluate(element => element === document.activeElement), true)
    await page.keyboard.press("ArrowRight")
    assert.equal(await page.getByRole("treeitem", { name: "workflows", exact: true }).evaluate(element => element === document.activeElement), true)
    await page.evaluate(() => (window as any).fixture.invalidate())
    await page.waitForFunction(() => (window as any).fixture.calls.filter((call: any) => call.kind === "files" && call.path === ".github").length >= 2)
    assert.equal(await page.getByRole("treeitem", { name: "workflows", exact: true }).evaluate(element => element === document.activeElement), true)
    await page.evaluate(() => { document.documentElement.dir = "rtl" })
    await page.keyboard.press("ArrowRight")
    assert.equal(await folder.evaluate(element => element === document.activeElement), true)
    await page.keyboard.press("ArrowRight")
    assert.equal(await folder.getAttribute("aria-expanded"), "false")
  } finally { await page.close() }
})
