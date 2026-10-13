import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { prepareGitPrototypeAssets } from "./fixtures/git-history-assets.mjs"
import { createFixtureCache } from "./fixture-cache"

// The real Files panel over the synthetic git-history fixture (`?uninitialized`).
let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  prepareGitPrototypeAssets()
  cache = await createFixtureCache()
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    cacheDir: cache.cacheDir,
    publicDir: fileURLToPath(new URL("../../src/renderer/public", import.meta.url)),
    plugins: [solid(), { name: "git-init-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/git-history.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture?uninitialized`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close(); await cache?.dispose() })

const calls = (page: Page, kind: string) => page.evaluate(kind => (window as any).fixture.calls.filter((call: any) => call.kind === kind), kind)

async function openUninitializedChanges(page: Page) {
  await page.goto(url)
  await page.getByRole("treeitem", { name: "package.json", exact: true }).waitFor()
  await page.getByRole("button", { name: "Changements", exact: true }).click()
  await page.getByText("Ce dossier n'est pas un dépôt Git.", { exact: true }).waitFor()
}

test("a plain folder's Changes offer Initialize Git, then open on the new repository without reload", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await openUninitializedChanges(page)
    assert.equal((await calls(page, "status")).length, 0, "no Git reads for a known non-repository")
    // Commits shows the same non-blocking action.
    await page.getByRole("button", { name: "Commits", exact: true }).click()
    await page.getByRole("button", { name: "Initialiser Git", exact: true }).waitFor()
    assert.equal((await calls(page, "history")).length, 0)
    await page.getByRole("button", { name: "Changements", exact: true }).click()

    const projectReads = (await calls(page, "project")).length
    await page.getByRole("button", { name: "Initialiser Git", exact: true }).click()
    await page.locator(".git-panel-file-row").first().waitFor()
    assert.deepEqual(await calls(page, "git-init"), [{ kind: "git-init", path: "/CodeNomad" }])
    assert.ok((await calls(page, "status")).length >= 1)
    assert.ok((await calls(page, "project")).length > projectReads, "the native project identity is reloaded after initialization")
    assert.equal(await page.getByText("Ce dossier n'est pas un dépôt Git.", { exact: true }).count(), 0)
    await page.getByText("Dépôt Git initialisé", { exact: true }).waitFor()
    assert.equal(await page.locator(".git-panel-branch strong").textContent(), "feat/git-history")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("an unsupported runtime keeps the empty state and is reported once, without replay", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  try {
    await openUninitializedChanges(page)
    await page.evaluate(async () => {
      const { serverApi } = await import("/src/lib/api-client.ts" as string)
      const { HttpResponseError } = await import("/src/lib/retryable-file-search.ts" as string)
      serverApi.initializeWorkspaceGit = async (_id: string, directory: string) => {
        ;(window as any).fixture.calls.push({ kind: "git-init", path: directory })
        throw new HttpResponseError("VCS provider does not support initialization", 501, null, "git_init_unsupported")
      }
    })
    const worktreeReads = (await calls(page, "worktrees")).length
    await page.getByRole("button", { name: "Initialiser Git", exact: true }).click()
    await page.getByText("Cette version d'OpenCode ne peut pas initialiser de dépôt Git ici.", { exact: true }).waitFor()
    await page.waitForFunction(reads => (window as any).fixture.calls.filter((call: any) => call.kind === "worktrees").length > reads, worktreeReads)
    await page.getByRole("button", { name: "Initialiser Git", exact: true }).and(page.locator(":enabled")).waitFor()
    assert.equal((await calls(page, "git-init")).length, 1)
    assert.equal((await calls(page, "status")).length, 0)
    await page.getByText("Ce dossier n'est pas un dépôt Git.", { exact: true }).waitFor()
  } finally { await page.close() }
})
