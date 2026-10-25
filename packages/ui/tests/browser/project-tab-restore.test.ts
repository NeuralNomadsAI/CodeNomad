import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [shutdown.plugin, solid(), { name: "project-tab-restore", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/project-tab-restore.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  shutdown.own(server)
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await server?.close() })

for (const host of ["electron", "tauri"] as const) for (const mode of ["normal", "user", "timeout", "catalog", "foreground", "foreground-user", "foreground-existing", "foreground-git", "foreground-inventory", "foreground-catalog", "foreground-history", "foreground-slow", "foreground-runtime-update", "foreground-runtime-continue", "foreground-runtime-user", "foreground-runtime-closed", "foreground-runtime-failure", "foreground-runtime-settings", "foreground-runtime-disposed", "foreground-runtime-discovered", "foreground-runtime-late", "foreground-runtime-refused-again", "foreground-runtime-manual-pending", "foreground-runtime-manual-same", "foreground-runtime-concurrent-continue"] as const) {
const userSelection = mode === "user" || mode === "foreground-user"
test(`${host} restores the active project and saved session identity before hydration (${mode})`, async () => {
  const page = await browser.newPage()
  if (mode === "timeout" || mode === "catalog") await page.clock.install()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: `{
    window.__CODENOMAD_RUNTIME_HOST__ = ${JSON.stringify(host)}
    window.__CODENOMAD_WINDOW_CONTEXT__ = 'local'
    window.EventSource = class extends EventTarget { close() {} }
    const snapshot = { version: 1, revision: 1, savedAt: 1, layout: {}, session: {
      activeTabIndex: 1, tabs: ['D:/first', 'D:/second'].map(folder => ({
        kind: 'workspace', folder, occurrence: 0, activeSessionId: 'saved-session', activeParentSessionId: 'saved-session',
         drafts: {}, attachments: {}, unseenIdleSince: {}, generationRecovery: {},
         scrollSnapshots: ${JSON.stringify(mode)}.startsWith('foreground-') && ${JSON.stringify(mode)} !== 'foreground-user' && !${JSON.stringify(mode)}.match(/existing|git|inventory/) ? { 'saved-session': ${JSON.stringify(mode)} === 'foreground-history'
           ? { scrollTop: 1200, atBottom: false, anchorKey: 'message-0120', anchorOffset: 4, followModeType: 'escaped', updatedAt: 5, windowIsLatest: false, windowCursor: 'saved-cursor', newerCursors: [null] }
           : { scrollTop: 9000, atBottom: true, anchorKey: 'message-0200', anchorOffset: 0, followModeType: 'following', updatedAt: 5, windowIsLatest: true, newerCursors: [] } } : {},
         ...(${JSON.stringify(mode)}.endsWith('catalog') || ${JSON.stringify(mode)} === 'foreground-history' ? {
           expandedSessionIds: ['saved-session', 'child'],
           sessionCatalog: ['saved-session', 'child', 'grandchild', 'other-worktree'].map((id, i) => ({
             id, title: 'Cached ' + id, parentId: i === 1 ? 'saved-session' : i === 2 ? 'child' : null,
             projectID: 'project', location: { directory: folder + (i === 3 ? '/linked' : '') },
             time: { created: 1, updated: 1 }, agent: 'build', model: { providerId: 'p', modelId: 'm' }, cost: 0,
             tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
           })),
         } : {}),
      }))
     } }
     const catalogMode = ${JSON.stringify(mode)}.endsWith('catalog') || ${JSON.stringify(mode)} === 'foreground-history'
     const persisted = catalogMode ? JSON.parse(sessionStorage.getItem('catalog-state') || 'null') : null
     const load = () => ({ isPrimary: true, restoreEnabled: true, snapshot: persisted?.snapshot || snapshot,
       ...(catalogMode ? { partitionProtocolVersion: 1 } : {}) })
     const commit = value => { window.committedState = value; sessionStorage.setItem('catalog-state', JSON.stringify(value)); return true }
     window.electronAPI = {
      claimClientStateAccess: async () => true,
       loadClientState: async () => load(),
       loadClientStatePartition: async (_token, key) => persisted?.partitions[key] ?? null,
       commitClientStatePartitions: async (_token, value) => commit(value),
      saveClientState: async (_token, value) => { window.savedSnapshot = value; return true },
    }
    if (${JSON.stringify(host)} === 'tauri') {
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args) => {
           if (command === 'client_state_load') return load()
           if (command === 'client_state_load_partition') return persisted?.partitions[args.key] ?? null
           if (command === 'client_state_commit_partitions') return commit(args.payload)
          if (command === 'client_state_save') window.savedSnapshot = args.snapshot
          return true
        },
      }
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    }
  }` })
  let releaseSessions!: () => void
  let sessionsReady = new Promise<void>(resolve => { releaseSessions = resolve })
  const foreground = mode.startsWith("foreground")
  let releaseSecondary!: () => void
  const secondaryReady = new Promise<void>(resolve => { releaseSecondary = resolve })
  let released = false
  const blocked: string[] = []
  const requested: string[] = []
  const cursors: string[] = []
  let includeLinked = true
  const runtimeRecovery = mode.includes("runtime-")
  let runtimeReady = !runtimeRecovery
  const creations: string[] = []
  let restarts = 0
  let releaseInitial!: () => void
  const initialReady = new Promise<void>(resolve => { releaseInitial = resolve })
  let allowRetry = false
  const manualPending = mode === "foreground-runtime-manual-pending" || mode === "foreground-runtime-manual-same"
  const holdRetry = manualPending || mode === "foreground-runtime-concurrent-continue"
  let releaseRetry!: () => void, markRetryStarted!: () => void
  const retryReady = new Promise<void>(resolve => { releaseRetry = resolve })
  const retryStarted = new Promise<void>(resolve => { markRetryStarted = resolve })
  const projects: any[] = mode === "foreground-existing"
    ? ["first", "second", ...Array.from({ length: 6 }, (_, i) => `extra-${i}`)].map(id => ({
        id, path: `D:/${id}`, status: "ready", port: 1234, proxyPath: `/workspaces/${id}/instance`,
        binaryId: "fixture", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      })) : []
  await page.route(/\/(?:api|workspaces)\//, async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    requested.push(path)
    if (!path.startsWith("/api/") && !path.startsWith("/workspaces/")) return route.continue()
    let body: unknown = {}
    if (path === "/api/opencode/update" || path === "/api/opencode/service") {
      if (path.endsWith("/service")) { restarts++; runtimeReady = true }
      body = { state: "ready", serviceState: runtimeReady ? "ready" : "incompatible", minimumVersion: "2.0.27" }
    } else if (path === "/api/workspaces") {
      if (request.method() === "POST") {
        const input = request.postDataJSON()
        creations.push(input.path)
        if (!runtimeReady) {
          if (mode === "foreground-runtime-late" && input.path.endsWith("first")) await initialReady
          return route.fulfill({ status: mode === "foreground-runtime-failure" && input.path.endsWith("first") ? 503 : 426,
            json: { error: "opencode_update_required" } })
        }
        if (["foreground-runtime-refused-again", "foreground-runtime-concurrent-continue"].includes(mode) && input.path.endsWith("second") && !allowRetry) {
          return route.fulfill({ status: 426, json: { error: "opencode_update_required" } })
        }
        const heldFirst = holdRetry && input.path.endsWith("first") && creations.filter(folder => folder === input.path).length === 2
        if (heldFirst) { markRetryStarted(); await retryReady }
        const id = heldFirst && mode === "foreground-runtime-manual-pending" ? "first-restored" : input.path.endsWith("first") ? "first" : "second"
        body = { id, path: input.path, status: "ready", port: 1234, proxyPath: `/workspaces/${id}/instance`,
          binaryId: "fixture", binaryLabel: "fixture", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), requestId: input.requestId }
        projects.push(body)
      } else body = projects
    } else if (mode === "foreground-inventory" && /\/(?:worktrees|location|session)$/.test(path)) {
      const id = path.split("/")[path.startsWith("/api/") ? 3 : 2]
      const directory = `D:/${id}`
      const session = (sessionID: string, folder: string) => ({ id: sessionID, title: sessionID, projectID: id,
        location: { directory: folder }, time: { created: 1, updated: 1 } })
      const query = new URL(request.url()).searchParams
      if (query.has("cursor")) cursors.push(query.get("cursor")!)
      body = path.endsWith("/worktrees") ? { isGitRepo: true, worktrees: [
        { slug: "root", directory, serviceDirectory: directory, kind: "root" },
        ...(includeLinked || id !== "second" ? [{ slug: "linked", directory: `${directory}/linked`, serviceDirectory: `${directory}/linked`, kind: "worktree" }] : []),
      ] } : path.endsWith("/location") ? { directory, project: { id } }
        : query.has("project") ? { data: [session("saved-session", directory), session("linked-session", `${directory}/linked`),
            session("foreign-session", "D:/unowned")], cursor: { next: `${id}-next` } }
        : query.has("cursor") ? { data: [session("older-session", `${directory}/linked`)], cursor: {} }
        : { data: [session("saved-session", directory)], cursor: {} }
    } else if (foreground && (path.endsWith("/creation/release") || path.endsWith("/worktrees")
      || path.endsWith("/git-status") || path.endsWith("/vcs/status")
      || (mode === "foreground-existing" && path.endsWith("/api/session"))
      || /\/api\/(location|agent|provider|model|command|shell|session\/active)$/.test(path))) {
      blocked.push(path)
      await secondaryReady
      body = path.endsWith("/worktrees") ? { isGitRepo: false, worktrees: [] } : { data: [] }
    } else if (path.endsWith("/worktrees")) body = { worktrees: [] }
    else if (path.includes("/instance/api/")) {
      if (foreground && path.endsWith("/saved-session")) {
        body = { data: { id: "saved-session", title: "Saved conversation", projectID: "global", location: { directory: `D:/${path.split("/")[2]}` },
          time: { created: 1, updated: 1 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } }
      } else if (foreground && path.endsWith("/saved-session/message")) {
        // Workspace updates keep arriving while a slow selected transcript is read.
        if (mode === "foreground-slow") for (let i = 0; i < 3; i++) {
          await page.evaluate(() => (window as any).touchWorkspaces())
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        assert.equal(new URL(request.url()).searchParams.get("limit"), "200")
        body = { data: Array.from({ length: 200 }, (_, i) => ({ id: `message-${String(200-i).padStart(4, "0")}`,
          type: "assistant", agent: "build", model: { providerID: "fixture", id: "fixture" }, time: { created: 201-i },
          content: [{ type: "text", text: "Saved transcript visible before secondary hydration" }] })), cursor: {} }
      } else if (foreground) body = { data: [], cursor: {} }
      else if (path.includes("/session")) {
        await sessionsReady
        if (mode === "catalog") return route.fulfill({ status: 503, json: { error: "Inventory temporarily unavailable" } })
        if (path.endsWith("/saved-session")) return route.fulfill({ status: 404, json: { message: "Session no longer exists" } })
      }
      if (!foreground) body = []
    }
    await route.fulfill({ json: body })
  })
  try {
    await page.goto(`${url}${foreground || mode === "catalog" ? `?${mode}` : ""}`)
    if (runtimeRecovery) {
      if (mode !== "foreground-runtime-late") await page.locator('[data-restoring="false"]').waitFor()
      await page.waitForFunction(() => (window as any).runtimeRecovery?.canContinueOpenCodeSetup())
      assert.equal(await page.getByRole("tab").count(), 0)
      assert.deepEqual([...creations].sort(), ["D:/first", "D:/second"])
      released = true
      releaseSecondary()
      // A ready status alone must not replay a refused workspace creation.
      runtimeReady = true
      await page.evaluate(() => (window as any).runtimeRecovery.refreshOpenCodeSetup())
      assert.equal(creations.length, 2)
      if (mode === "foreground-runtime-disposed") {
        await page.evaluate(() => (window as any).disposeRestoreFixture())
        assert.equal(await page.evaluate(() => (window as any).runtimeRecovery.canContinueOpenCodeSetup()), false)
        await page.evaluate(() => (window as any).runtimeRecovery.continueOpenCodeSetup())
        assert.equal(creations.length, 2, "disposed startup cannot reopen projects")
        assert.deepEqual(errors, [])
        return
      }
      if (mode === "foreground-runtime-settings") {
        await page.evaluate(() => (window as any).runtimeRecovery.runOpenCodeSetup("restart", { resumeWorkspace: false }))
        assert.equal(creations.length, 2, "settings maintenance does not resume dismissed restoration")
        assert.equal(await page.evaluate(() => (window as any).runtimeRecovery.canContinueOpenCodeSetup()), true)
      }
      if (mode === "foreground-runtime-discovered") {
        const workspace = { id: "first", path: "D:/first", status: "ready", port: 1234, proxyPath: "/workspaces/first/instance",
          binaryId: "fixture", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }
        projects.push(workspace)
        await page.evaluate(workspace => (window as any).runtimeRecovery.discover(workspace), workspace)
        assert.equal(await page.getByRole("tab").count(), 0, "discovery does not open a tab in this window")
      }
      if (mode === "foreground-runtime-user") await page.evaluate(() => (window as any).runtimeRecovery.retryFirst())
      if (mode === "foreground-runtime-closed") {
        await page.evaluate(() => (window as any).runtimeRecovery.openFirst())
        await page.getByRole("tab", { name: "D:/first", exact: true }).waitFor()
        await page.evaluate(() => (window as any).runtimeRecovery.closeFirst())
      }
      if (mode === "foreground-runtime-update") {
        runtimeReady = false
        await page.evaluate(() => (window as any).runtimeRecovery.runOpenCodeSetup("restart"))
        assert.equal(restarts, 1)
      } else if (holdRetry) {
        await page.evaluate(() => { (window as any).recovering = (window as any).runtimeRecovery.continueOpenCodeSetup() })
        await retryStarted
        if (manualPending) await page.evaluate(() => (window as any).runtimeRecovery.openFirst())
        else {
          await page.waitForFunction(() => (window as any).runtimeRecovery.canContinueOpenCodeSetup())
          allowRetry = true
          await page.evaluate(() => { (window as any).nextRecovery = (window as any).runtimeRecovery.continueOpenCodeSetup() })
          await page.waitForFunction(() => !(window as any).runtimeRecovery.canContinueOpenCodeSetup())
        }
        releaseRetry()
        await page.evaluate(async () => { await (window as any).recovering; await (window as any).nextRecovery })
      } else if (mode === "foreground-runtime-late") {
        await page.evaluate(() => { (window as any).recovering = (window as any).runtimeRecovery.continueOpenCodeSetup() })
        await page.waitForFunction(() => !(window as any).runtimeRecovery.canContinueOpenCodeSetup())
        releaseInitial()
        await page.evaluate(() => (window as any).recovering)
      } else await page.evaluate(() => (window as any).runtimeRecovery.continueOpenCodeSetup())
      if (mode === "foreground-runtime-refused-again") {
        assert.equal(await page.getByRole("tab").count(), 1)
        assert.equal(await page.evaluate(() => (window as any).runtimeRecovery.canContinueOpenCodeSetup()), true,
          "a fresh refusal from the retry must keep its own continuation")
        allowRetry = true
        await page.evaluate(() => (window as any).runtimeRecovery.continueOpenCodeSetup())
      }
      const second = page.getByRole("tab", { name: "D:/second", exact: true })
      await second.waitFor()
      if (mode === "foreground-runtime-user" || manualPending) assert.equal(await page.getByRole("tab", { name: "D:/first", exact: true }).getAttribute("aria-selected"), "true")
      else if (mode !== "foreground-runtime-closed") assert.equal(await second.getAttribute("aria-selected"), "true")
      assert.equal(await page.getByRole("tab").count(), ["foreground-runtime-closed", "foreground-runtime-failure"].includes(mode) ? 1 : 2)
      assert.equal(creations.filter(folder => folder === "D:/second").length, ["foreground-runtime-refused-again", "foreground-runtime-concurrent-continue"].includes(mode) ? 3 : 2)
      assert.equal(creations.filter(folder => folder === "D:/first").length, manualPending ? 3 : ["foreground-runtime-failure", "foreground-runtime-discovered"].includes(mode) ? 1 : 2,
        "never duplicate a manually reopened tab or replay a non-426 failure")
      if (mode !== "foreground-runtime-closed") await page.getByText("Saved transcript visible before secondary hydration", { exact: true }).first().waitFor()
      const count = creations.length
      assert.equal(await page.evaluate(() => (window as any).runtimeRecovery.canContinueOpenCodeSetup()), false,
        "successful restoration must remove even a late initial recovery offer")
      await page.evaluate(() => (window as any).runtimeRecovery.continueOpenCodeSetup())
      assert.equal(creations.length, count, "recovery is consumed once")
      assert.deepEqual(errors, [])
      return
    }
    const selected = page.getByRole("tab", { name: "D:/second", exact: true })
    await selected.waitFor()
    assert.equal(await selected.getAttribute("aria-selected"), "true", "project selection must not wait for its conversation requests")
    assert.equal(await selected.getAttribute("data-session-selection"), "saved-session", "saved session identity must not wait for HTTP hydration")
    if (mode === "catalog") {
      assert.equal(await page.evaluate(() => (window as any).catalogRows("second").length), 4, "metadata must be seeded before network hydration")
      assert.deepEqual(await page.evaluate(() => (window as any).sessionListIds("second")), ["saved-session", "other-worktree"])
      for (const id of ["saved-session", "child", "grandchild", "other-worktree"]) {
        await page.locator(`[data-session-id="${id}"]`).waitFor()
        assert.equal(await page.getByText(`Cached ${id}`, { exact: true }).isVisible(), true)
      }
      await page.clock.fastForward(301_000)
      assert.equal(await page.locator('[data-session-id="grandchild"]').isVisible(), true,
        "five minutes of stalled requests must not hide the saved hierarchy")
      assert.equal(await selected.getAttribute("data-session-selection"), "saved-session")
      assert.equal(released, false)
    }
    if (foreground) {
      await page.getByText("Saved transcript visible before secondary hydration", { exact: true }).first().waitFor()
      assert.equal(requested.filter(path => path === "/workspaces/second/instance/api/session/saved-session/message").length, 1,
        "restoring other workspaces must not restart and requeue the selected transcript read")
      assert.equal(await page.evaluate(() => (window as any).messageCount()), 200)
      assert.equal(released, false)
      if (mode === "foreground-inventory") {
        await page.waitForFunction(() => (window as any).sessionListIds("second").includes("linked-session"))
        assert.equal(await page.evaluate(() => (window as any).sessionListIds("second").includes("foreign-session")), false)
        assert.deepEqual(cursors, [], "recent worktree rows publish before historical cursor traversal can dispatch")
        assert.equal(requested.some(path => path === "/workspaces/first/instance/api/location"), false,
          "hidden project dependencies remain queued while both secondary slots are occupied")
        await page.getByRole("tab", { name: "D:/first", exact: true }).click()
        await page.waitForFunction(() => (window as any).sessionListIds("first").includes("linked-session"))
        assert.equal(released, false, "selection promotes metadata, membership and the first project page without releasing secondary reads")
        await page.getByRole("tab", { name: "D:/second", exact: true }).click()
        includeLinked = false
        await page.evaluate(() => (window as any).reloadWorktrees("second"))
        await page.evaluate(() => (window as any).releaseInventoryBudget())
      } else if (mode !== "foreground-existing") {
        assert.ok(blocked.some(path => path.endsWith("/creation/release")), "ownership acknowledgement is still stalled")
        assert.ok(blocked.some(path => path.endsWith("/location")), "project metadata is still stalled")
      } else {
        assert.ok(blocked.filter(path => path.endsWith("/api/session")).length <= 3,
          "unselected existing projects must share the secondary budget before selection is established")
      }
      assert.equal(await selected.getAttribute("aria-selected"), "true")
    }
    if (userSelection) await page.getByRole("tab", { name: "D:/first", exact: true }).click()
    if (mode === "foreground-user") {
      await page.waitForFunction(() => (window as any).messageCount() === 200)
      await page.getByText("Saved transcript visible before secondary hydration", { exact: true }).first().waitFor()
      assert.equal(released, false, "selecting a queued project must promote its saved transcript immediately")
      assert.equal(requested.filter(path => path === "/workspaces/first/instance/api/session/saved-session").length, 1)
    }
    if (mode === "timeout") {
      await page.getByRole("tab", { name: "D:/first", exact: true }).waitFor()
      await page.clock.fastForward(61_000)
      await page.locator('[data-restoring="false"]').waitFor()
      assert.equal(await page.getByRole("tab").count(), 2, "session timeout must not remove a bound project tab")
      assert.equal(await selected.getAttribute("data-session-selection"), "saved-session")
    }
    releaseSessions()
    released = true
    releaseSecondary()
    if (mode === "foreground-inventory") {
      await page.waitForFunction(() => (window as any).sessionListLoading("second") === false)
      assert.equal(await page.evaluate(() => (window as any).sessionListIds("second").includes("linked-session")), false,
        "a partial row excluded by final membership must not be retained as a concurrent creation")
    }
    await page.locator('[data-restoring="false"]').waitFor()
    assert.equal(await page.getByRole("tab", { name: userSelection ? "D:/first" : "D:/second", exact: true }).getAttribute("aria-selected"), "true")
    if (mode === "catalog") {
      await page.waitForFunction(() => {
        const commit = (window as any).committedState
        return commit && JSON.parse(commit.partitions[commit.snapshot.sessionPartition]).session?.activeTabIndex === 1
      })
      const saved = JSON.parse(await page.evaluate(async () => JSON.stringify(await (window as any).decodeSavedState())))
      assert.equal(saved.session.tabs[1].sessionCatalog.length, 4, "capture must persist the hierarchy despite failed refreshes")
      sessionsReady = new Promise<void>(resolve => { releaseSessions = resolve })
      await page.reload()
      await page.locator('[data-session-id="grandchild"]').waitFor()
      assert.equal(await page.locator('[data-session-id="other-worktree"]').isVisible(), true,
        "a fresh renderer must display the catalog written through the native partition adapter")
    } else if (mode !== "foreground-catalog" && mode !== "foreground-history") {
      await page.waitForFunction(index => (window as any).savedSnapshot?.session?.activeTabIndex === index, userSelection ? 0 : 1)
    }
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error({ errors, blocked, requested, body: (await page.locator("body").innerText()).slice(-3000), count: await page.evaluate(() => (window as any).messageCount?.()) })
    throw error
  } finally { releaseRetry(); releaseInitial(); releaseSessions(); releaseSecondary(); await page.close() }
})
}
