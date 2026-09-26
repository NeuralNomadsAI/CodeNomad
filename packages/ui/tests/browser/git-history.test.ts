import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { prepareGitPrototypeAssets } from "./fixtures/git-history-assets.mjs"

let server: ViteDevServer, browser: Browser, url: string
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
    await page.getByRole("button", { name: /src\/components\/git-panel.tsx/ }).click()
    await page.locator(".git-diff-view .monaco-diff-editor").waitFor()
    await page.locator(".git-diff-view .line-insert").first().waitFor()
    assert.ok(await page.locator("main .git-diff-view").isVisible())
    if (process.env.CODENOMAD_GIT_CAPTURE) await page.screenshot({ path: `${process.env.CODENOMAD_GIT_CAPTURE}/commit-diff.png` })
    await page.getByRole("button", { name: "Retour à la conversation" }).click()
    assert.equal(await page.getByRole("textbox", { name: "Brouillon" }).inputValue(), "Ne pas perdre ce brouillon")
    await page.getByRole("button", { name: /Changements/ }).click()
    await page.getByRole("button", { name: /src\/styles\/panels\/git-history.css/ }).click()
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
    await page.getByRole("treeitem", { name: "update-winget.yml", exact: true }).click()
    await page.locator(".workspace-file-view .view-lines").filter({ hasText: "Update Winget" }).waitFor()
    assert.equal(await page.evaluate(() => (window as any).monaco.editor.getEditors().filter((editor: any) => editor.getModel()?.uri.toString().includes("workspace-readonly")).every((editor: any) => editor.getRawOptions().readOnly)), true)
    if (process.env.CODENOMAD_GIT_CAPTURE) await page.screenshot({ path: `${process.env.CODENOMAD_GIT_CAPTURE}/workspace-source.png` })
    await page.getByRole("button", { name: /Changements/ }).click()
    await page.getByRole("button", { name: "Workspace", exact: true }).click()
    assert.ok(await page.getByRole("treeitem", { name: "update-winget.yml", exact: true }).isVisible())
    await page.getByRole("treeitem", { name: "README.md", exact: true }).click()
    await page.locator(".workspace-markdown").getByRole("heading", { name: "CodeNomad", exact: true }).waitFor()
    await page.getByRole("treeitem", { name: "dev-docs", exact: true }).click()
    await page.getByRole("treeitem", { name: "ui-harmonization-demo", exact: true }).click()
    await page.getByRole("treeitem", { name: "palette.svg", exact: true }).click()
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
    await page.getByRole("treeitem", { name: "README.md", exact: true }).click()
    await page.locator(".workspace-markdown h1").waitFor()
    assert.equal(await composer.inputValue(), "Mon brouillon dans le vrai composeur")
    await page.getByRole("button", { name: "Retour à la conversation" }).click()
    assert.equal(await composer.inputValue(), "Mon brouillon dans le vrai composeur")
    await page.evaluate(() => (window as any).fixture.holdFile())
    await page.getByRole("treeitem", { name: "README.md", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.calls.filter((call: any) => call.kind === "file").length >= 2)
    await page.evaluate(() => { (window as any).fixture.switchSession("other"); (window as any).fixture.releaseFile() })
    await page.waitForFunction(() => !document.querySelector(".workspace-file-view"))
    assert.equal(await composer.inputValue(), "")
    await page.evaluate(() => (window as any).fixture.switchSession("session"))
    assert.equal(await composer.inputValue(), "Mon brouillon dans le vrai composeur")
    await page.getByRole("treeitem", { name: "README.md", exact: true }).click()
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
