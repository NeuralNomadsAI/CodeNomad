import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "project-tab-restore", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/project-tab-restore.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

for (const host of ["electron", "tauri"] as const) for (const mode of ["normal", "user", "timeout", "foreground", "foreground-user", "foreground-existing", "foreground-git", "foreground-inventory"] as const) {
const userSelection = mode === "user" || mode === "foreground-user"
test(`${host} restores the active project and saved session identity before hydration (${mode})`, async () => {
  const page = await browser.newPage()
  if (mode === "timeout") await page.clock.install()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: `{
    window.__CODENOMAD_RUNTIME_HOST__ = ${JSON.stringify(host)}
    window.__CODENOMAD_WINDOW_CONTEXT__ = 'local'
    window.EventSource = class extends EventTarget { close() {} }
    const snapshot = { version: 1, revision: 1, savedAt: 1, layout: {}, session: {
      activeTabIndex: 1, tabs: ['D:/first', 'D:/second'].map(folder => ({
        kind: 'workspace', folder, occurrence: 0, activeSessionId: 'saved-session', activeParentSessionId: 'saved-session',
        drafts: {}, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
      }))
    } }
    window.electronAPI = {
      claimClientStateAccess: async () => true,
      loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot }),
      saveClientState: async (_token, value) => { window.savedSnapshot = value; return true },
    }
    if (${JSON.stringify(host)} === 'tauri') {
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args) => {
          if (command === 'client_state_load') return { isPrimary: true, restoreEnabled: true, snapshot }
          if (command === 'client_state_save') window.savedSnapshot = args.snapshot
          return true
        },
      }
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    }
  }` })
  let releaseSessions!: () => void
  const sessionsReady = new Promise<void>(resolve => { releaseSessions = resolve })
  const foreground = mode.startsWith("foreground")
  let releaseSecondary!: () => void
  const secondaryReady = new Promise<void>(resolve => { releaseSecondary = resolve })
  let released = false
  const blocked: string[] = []
  const requested: string[] = []
  const cursors: string[] = []
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
    if (path === "/api/workspaces") {
      if (request.method() === "POST") {
        const input = request.postDataJSON()
        const id = input.path.endsWith("first") ? "first" : "second"
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
        { slug: "linked", directory: `${directory}/linked`, serviceDirectory: `${directory}/linked`, kind: "worktree" },
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
        assert.equal(new URL(request.url()).searchParams.get("limit"), "200")
        body = { data: Array.from({ length: 200 }, (_, i) => ({ id: `message-${String(200-i).padStart(4, "0")}`,
          type: "assistant", agent: "build", model: { providerID: "fixture", id: "fixture" }, time: { created: 201-i },
          content: [{ type: "text", text: "Saved transcript visible before secondary hydration" }] })), cursor: {} }
      } else if (foreground) body = { data: [], cursor: {} }
      else if (path.includes("/session")) {
        await sessionsReady
        if (path.endsWith("/saved-session")) return route.fulfill({ status: 404, json: { message: "Session no longer exists" } })
      }
      if (!foreground) body = []
    }
    await route.fulfill({ json: body })
  })
  try {
    await page.goto(`${url}${foreground ? `?${mode}` : ""}`)
    const selected = page.getByRole("tab", { name: "D:/second", exact: true })
    await selected.waitFor()
    assert.equal(await selected.getAttribute("aria-selected"), "true", "project selection must not wait for its conversation requests")
    assert.equal(await selected.getAttribute("data-session-selection"), "saved-session", "saved session identity must not wait for HTTP hydration")
    if (foreground) {
      await page.getByText("Saved transcript visible before secondary hydration", { exact: true }).first().waitFor()
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
    await page.locator('[data-restoring="false"]').waitFor()
    assert.equal(await page.getByRole("tab", { name: userSelection ? "D:/first" : "D:/second", exact: true }).getAttribute("aria-selected"), "true")
    await page.waitForFunction(index => (window as any).savedSnapshot?.session?.activeTabIndex === index, userSelection ? 0 : 1)
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error({ errors, blocked, requested, body: (await page.locator("body").innerText()).slice(-3000), count: await page.evaluate(() => (window as any).messageCount?.()) })
    throw error
  } finally { releaseSessions(); releaseSecondary(); await page.close() }
})
}
