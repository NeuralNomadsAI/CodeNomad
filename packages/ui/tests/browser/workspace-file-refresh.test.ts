import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, writeFile, rename, unlink, symlink, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { chromium } from "playwright"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import { FileSystemBrowser } from "../../../server/src/filesystem/browser"
import { WorkspaceFileWatches } from "../../../server/src/workspaces/file-watches"
import { EventBus } from "../../../server/src/events/bus"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"

test("actual file creation, rename and deletion refresh the Workspace tree through host events without F5", { timeout: 90_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-workspace-refresh-"))
  await mkdir(path.join(root, "src"))
  await writeFile(path.join(root, "initial.txt"), "initial")
  await writeFile(path.join(root, "src", "initial.ts"), "initial")
  const bus = new EventBus(), reads: string[] = []
  const watches = new WorkspaceFileWatches((workspaceId, changes) => bus.publish({ type: "workspace.filesChanged", workspaceId, changes }), error => { throw error })
  const files = new FileSystemBrowser({ rootDir: root })
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "workspace-refresh-fixture", configureServer(s) {
      s.middlewares.use("/workspace-refresh", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/workspace-refresh", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/workspace-file-refresh.tsx"></script></body></html>'))
      })
      s.middlewares.use("/api/events", (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
        res.write(": connected\n\n")
        const stop = bus.onEvent(event => res.write(`data: ${JSON.stringify(event)}\n\n`))
        res.on("close", stop)
      })
      s.middlewares.use("/api/workspaces/fixture/files", async (req, res) => {
        const relative = new URL(req.url!, "http://fixture").searchParams.get("path") ?? "."
        reads.push(relative)
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify(await files.list(relative, { observeDirectory: target => watches.observe("fixture", root, target, () => true) })))
      })
      s.middlewares.use("/api/", (_req, res) => { res.setHeader("Content-Type", "application/json"); res.end("{}") })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server)
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  t.after(async () => {
    await browser.close()
    watches.close()
    await server.close()
    await rm(root, { recursive: true, force: true })
  })
  await server.listen()
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/workspace-refresh?${new URLSearchParams({ directory: root })}`)
  const row = (file: string) => page.locator(`[role="treeitem"][data-path="${file}"]`)
  await row("initial.txt").waitFor({ timeout: 10_000 }).catch(async () => {
    throw new Error(JSON.stringify({ errors, reads, body: await page.locator("body").innerText() }))
  })
  // Let the tree's initial cache-first/trailing demand settle before measuring idle.
  await page.waitForTimeout(250)
  assert.equal(await page.evaluate(() => (window as any).workspaceRefreshFixture.version()), 0,
    "reading a directory does not itself generate a host invalidation")
  const idleReads = reads.length
  await page.waitForTimeout(350)
  assert.equal(reads.length, idleReads, "listing and observing a directory never trigger a polling/feedback loop")
  await writeFile(path.join(root, "new.txt"), "created outside CodeNomad")
  await row("new.txt").waitFor()
  await row("src").click()
  await row("src/initial.ts").waitFor()
  await writeFile(path.join(root, "src", "nested.ts"), "created in expanded folder")
  await row("src/nested.ts").waitFor()
  await rename(path.join(root, "new.txt"), path.join(root, "renamed.txt"))
  await row("renamed.txt").waitFor()
  await row("new.txt").waitFor({ state: "detached" })
  await unlink(path.join(root, "renamed.txt"))
  await row("renamed.txt").waitFor({ state: "detached" })

  await row("src").click()
  await page.waitForFunction(() => !(window as any).workspaceRefreshFixture.busy().size)
  const beforeCollapsed = reads.filter(directory => directory === "src").length
  const version = await page.evaluate(() => (window as any).workspaceRefreshFixture.version())
  await writeFile(path.join(root, "src", "collapsed.ts"), "collapsed")
  await page.waitForFunction(previous => (window as any).workspaceRefreshFixture.version() > previous, version)
  await page.waitForTimeout(220)
  assert.equal(reads.filter(directory => directory === "src").length, beforeCollapsed, "collapsed children never rescan in the background")
  await row("src").click()
  await row("src/collapsed.ts").waitFor()

  await page.waitForFunction(() => !(window as any).workspaceRefreshFixture.busy().size)
  await page.evaluate(() => (window as any).workspaceRefreshFixture.activate(false))
  const beforeHidden = reads.length
  const hiddenVersion = await page.evaluate(() => (window as any).workspaceRefreshFixture.version())
  await writeFile(path.join(root, "hidden.txt"), "while panel inactive")
  await page.waitForFunction(previous => (window as any).workspaceRefreshFixture.version() > previous, hiddenVersion)
  await page.waitForTimeout(220)
  assert.equal(reads.length, beforeHidden, "an inactive panel only invalidates its snapshot")
  await page.evaluate(() => (window as any).workspaceRefreshFixture.activate(true))
  await row("hidden.txt").waitFor()

  // Parent-only notifications must detect a replaced open child and rebind it.
  await mkdir(path.join(root, "target"))
  await writeFile(path.join(root, "target", "old.txt"), "old inode")
  await row("target").waitFor()
  await row("target").click()
  await row("target/old.txt").waitFor()
  await rename(path.join(root, "target"), path.join(root, "moved"))
  await mkdir(path.join(root, "target"))
  await writeFile(path.join(root, "target", "new.txt"), "replacement inode")
  await row("target/new.txt").waitFor()
  await row("target/old.txt").waitFor({ state: "detached" })
  await writeFile(path.join(root, "target", "later.txt"), "new observation is live")
  await row("target/later.txt").waitFor()

  for (const alias of ["alias", "other-alias"]) {
    await symlink(path.join(root, "target"), path.join(root, alias), process.platform === "win32" ? "junction" : "dir")
  }
  for (const alias of ["alias", "other-alias"]) {
    await row(alias).waitFor()
    await row(alias).click()
    await row(`${alias}/new.txt`).waitFor()
  }
  await writeFile(path.join(root, "target", "aliased.txt"), "one mutation, multiple logical subscribers")
  await row("alias/aliased.txt").waitFor()
  await row("other-alias/aliased.txt").waitFor()
  assert.deepEqual(errors, [])
})
