import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "project-git-lifecycle", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/project-git-lifecycle.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function setup(page: Page, blocked?: Promise<void>) {
  const requests: string[] = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route(/\/(?:api|workspaces)\//, async route => {
    const path = new URL(route.request().url()).pathname
    requests.push(path)
    if (path.endsWith("/git-status") || path.endsWith("/vcs/status")) await blocked
    const json = path.endsWith("/git-status") ? [{ path: "file.txt", originalPath: null,
      stagedStatus: null, stagedAdditions: 0, stagedDeletions: 0, unstagedStatus: "modified", unstagedAdditions: 1, unstagedDeletions: 0 }]
      : path.endsWith("/git-diff") ? { before: "old\n", after: "new\n", isBinary: false }
      : { data: [] }
    await route.fulfill({ json }).catch(() => {})
  })
  await page.goto(url)
  await page.locator('[data-project="first"]').waitFor()
  return { requests, errors }
}

test("metadata and restored tabs preserve shells, Git reads and commit drafts", async () => {
  const page = await browser.newPage()
  try {
    const { requests, errors } = await setup(page)
    await page.waitForFunction(() => document.querySelector('[data-project="first"] [data-diff]')?.textContent === "new\n")
    await page.getByRole("textbox", { name: "Commit first", exact: true }).fill("unfinished commit")
    const firstReads = requests.filter(path => path.endsWith("/git-status")).length
    await page.evaluate(() => {
      const f = (window as any).fixture
      for (let i = 0; i < 8; i++) { f.add(`other-${i}`); f.update("first", `name-${i}`) }
    })
    assert.equal(await page.locator('[data-project="first"] [data-name]').textContent(), "name-7")
    assert.equal(await page.getByRole("textbox", { name: "Commit first", exact: true }).inputValue(), "unfinished commit")
    assert.equal(await page.evaluate(() => (window as any).fixture.mounts.first), 1)
    assert.equal(requests.filter(path => path.endsWith("/git-status")).length, firstReads)
    assert.ok(!requests.some(path => path.includes("other-")), "hidden projects must not fetch Git")
    await page.evaluate(() => (window as any).fixture.select("other-0"))
    await page.waitForFunction(() => document.querySelector('[data-project="other-0"] [data-diff]')?.textContent === "new\n")
    await page.evaluate(() => (window as any).fixture.select("first"))
    await page.waitForFunction(() => document.querySelector('[data-project="first"]')?.getAttribute("data-loading") === "false")
    assert.equal(await page.getByRole("textbox", { name: "Commit first", exact: true }).inputValue(), "unfinished commit")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a disposed panel cannot queue a trailing Git refresh or diff after a slow status response", async () => {
  const page = await browser.newPage()
  await page.clock.install()
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  try {
    const statusRequested = page.waitForRequest(request => request.url().endsWith("/git-status"))
    const { requests, errors } = await setup(page, blocked)
    await statusRequested
    await page.evaluate(() => (window as any).fixture.invalidate("first"))
    await page.clock.fastForward(150)
    await page.evaluate(() => (window as any).fixture.close("first"))
    release()
    await page.waitForFunction(() => (window as any).fixture.disposals.first === 1)
    assert.equal(requests.filter(path => path.endsWith("/git-status")).length, 1)
    assert.ok(!requests.some(path => path.endsWith("/git-diff")))
    assert.deepEqual(errors, [])
  } finally { release(); await page.close() }
})

test("queued hidden-project Git reads are cancelled before dispatch", async () => {
  const page = await browser.newPage()
  try {
    const { requests, errors } = await setup(page)
    await page.waitForFunction(() => document.querySelector('[data-project="first"] [data-diff]')?.textContent === "new\n")
    await page.evaluate(() => { const f = (window as any).fixture; f.occupy(); f.add("second"); f.select("second") })
    await page.evaluate(() => { const f = (window as any).fixture; f.select("first"); f.release() })
    await page.waitForFunction(() => document.querySelector('[data-project="first"]')?.getAttribute("data-loading") === "false")
    assert.ok(!requests.some(path => path.includes("/second/")))
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const mode of ["deadline", "deactivate"] as const) test(`SDK status releases its real transport and slot on ${mode}`, async () => {
  const page = await browser.newPage()
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  try {
    await setup(page)
    await page.waitForFunction(() => document.querySelector('[data-project="first"] [data-diff]')?.textContent === "new\n")
    await page.route("**/api/vcs/status*", async route => { await blocked; await route.fulfill({ json: [] }).catch(() => {}) })
    const requested = page.waitForRequest(r => r.url().includes("/api/vcs/status"))
    const aborted = page.waitForEvent("requestfailed", { predicate: r => r.url().includes("/api/vcs/status"), timeout: 10000 })
    await page.evaluate(() => { (window as any).refresh = (window as any).fixture.panels.first.refreshGitStatus() })
    await requested
    if (mode === "deactivate") await page.evaluate(() => (window as any).fixture.deactivate())
    await aborted
    await page.evaluate(() => (window as any).refresh)
    // Both slots must be reusable while the obsolete upstream remains blocked.
    await page.evaluate(() => { const f = (window as any).fixture; f.add("second"); f.select("second") })
    await page.waitForFunction(() => document.querySelector('[data-project="second"] [data-diff]')?.textContent === "new\n")
  } finally { release(); await page.close() }
})

test("explicit refresh cannot launch a new diff after deactivation aborts its status", async () => {
  const page = await browser.newPage()
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  try {
    const { requests } = await setup(page)
    await page.waitForFunction(() => document.querySelector('[data-project="first"] [data-diff]')?.textContent === "new\n")
    const diffs = requests.filter(path => path.endsWith("/git-diff")).length
    await page.route("**/git-status", async route => { await blocked; await route.fulfill({ json: [] }).catch(() => {}) })
    const requested = page.waitForRequest(r => r.url().endsWith("/git-status"))
    await page.evaluate(() => { (window as any).refresh = (window as any).fixture.panels.first.refreshGitStatus() })
    await requested
    await page.evaluate(() => (window as any).fixture.deactivate())
    await page.evaluate(() => (window as any).refresh)
    assert.equal(requests.filter(path => path.endsWith("/git-diff")).length, diffs)
  } finally { release(); await page.close() }
})

test("a late commit cannot clear a new worktree draft or refresh its Git selection", async () => {
  const page = await browser.newPage()
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  try {
    const { requests } = await setup(page)
    await page.waitForFunction(() => document.querySelector('[data-project="first"] [data-diff]')?.textContent === "new\n")
    const diffs = requests.filter(path => path.endsWith("/git-diff")).length
    await page.route("**/git-commit", async route => { await blocked; await route.fulfill({ json: { ok: true } }) })
    const requested = page.waitForRequest(r => r.url().endsWith("/git-commit"))
    await page.evaluate(() => { const f = (window as any).fixture; f.panels.first.setGitCommitMessage("old draft"); (window as any).commit = f.panels.first.submitGitCommit() })
    assert.ok((await requested).url().includes("/root/"))
    await page.evaluate(() => { const f = (window as any).fixture; f.worktree.first("other"); f.panels.first.setGitCommitMessage("new draft") })
    release()
    await page.evaluate(() => (window as any).commit)
    assert.equal(await page.getByRole("textbox", { name: "Commit first", exact: true }).inputValue(), "new draft")
    assert.equal(requests.filter(path => path.endsWith("/git-diff")).length, diffs)
  } finally { release(); await page.close() }
})
