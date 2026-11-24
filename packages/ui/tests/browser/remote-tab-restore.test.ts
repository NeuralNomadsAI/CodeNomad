import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { CODENOMAD_API_CONTRACT } from "../../../server/src/meta-contract"
import { RELAY_AUTHORITY_HEADER } from "../../../server/src/codenomad-servers/relay-authority"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "remote-tab-restore", routes: [
    { path: "/fixture", html: '<html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/remote-tab-restore.tsx"></script></body></html>' },
  ] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

for (const host of ["electron", "tauri"]) for (const mode of ["create", "reuse", "offline", "auth", "pairing", "refused", "absent", "disabled", "closed", "uncertain", "partial-refusal", "auto-off", "cancel-quit"]) {
  test(`${host}: real restore hook preserves remote occurrences (${mode})`, async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    page.setDefaultNavigationTimeout(60_000)
    const errors: string[] = [], creates: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await context.addInitScript(({ host, mode }) => {
      ;(window as any).__name = new Function("value", "return value")
      Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: host, __CODENOMAD_WINDOW_CONTEXT__: "local" })
      window.EventSource = class extends EventTarget { close() {} } as any
      const session = { activeTabIndex: 2, tabs: [
        { folder: "/local" }, ...[0, 1].map(occurrence => ({ folder: "/same", backendId: "a", serverId: "a", occurrence,
          ...(!["create", "closed", "uncertain", "partial-refusal"].includes(mode) && !location.search
            ? { workspaceId: `a~existing-${occurrence}` } : {}) })),
      ].map((value, index) => ({ kind: "workspace", ...value, drafts: { __no_session_draft__: `draft-${index}` },
        attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {} })) }
      const snapshot = { version: 1, revision: 1, savedAt: 1, layout: {}, session }
      let persisted = JSON.parse(sessionStorage.getItem("restored-state") || "null")
      const load = () => ({ isPrimary: true, restoreEnabled: true, snapshot: persisted?.snapshot || snapshot, partitionProtocolVersion: 1 })
      const commit = (value: any) => {
        if ((window as any).holdSnapshotCommit) return new Promise(() => {})
        const partitions = { ...persisted?.partitions, ...value.partitions }
        if (value.partitionKeys.some((key: string) => !(key in partitions))) throw Error("Missing client state partition")
        persisted = { ...value, partitions: Object.fromEntries(value.partitionKeys.map((key: string) => [key, partitions[key]])) }
        ;(window as any).committedState = persisted
        sessionStorage.setItem("restored-state", JSON.stringify(persisted))
        return true
      }
      ;(window as any).electronAPI = { claimClientStateAccess: async () => true, loadClientState: async () => load(),
        loadClientStatePartition: async (_token: any, key: string) => persisted?.partitions[key] ?? null, commitClientStatePartitions: async (_token: any, value: any) => commit(value),
        saveClientState: async () => true, setClientStateRestoreEnabled: async () => true }
      if (host === "tauri") {
        ;(window as any).__TAURI_INTERNALS__ = {
          metadata: { currentWindow: { label: "local-fixture" }, currentWebview: { label: "local-fixture" } },
          transformCallback: () => 1, invoke: async (command: string, args: any) =>
          command === "client_state_load" ? load() : command === "client_state_load_partition" ? persisted?.partitions[args.key] ?? null
            : command === "client_state_commit_partitions" ? commit(args.payload) : true }
        ;(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
      }
    }, { host, mode })
    let healthy = !["offline", "auth", "pairing", "refused"].includes(mode)
    let generation = 0
    let profileWrites = 0
    let forgets = 0
    let savedServers = mode === "absent" ? [] : [
      { id: "a", name: "Server A", baseUrl: "https://a.test", skipTlsVerify: false, createdAt: "", updatedAt: "" },
    ]
    const explicitlyOpen = ["create", "closed", "uncertain", "partial-refusal"].includes(mode)
    const projects: any[] = explicitlyOpen ? [] : [0, 1].map(index => descriptor(`existing-${index}`, "/same"))
    let releaseCreate!: () => void
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
    let markCreate!: () => void
    const createStarted = new Promise<void>(resolve => { markCreate = resolve })
    await context.route(url => /^\/(?:api|workspaces)\//.test(url.pathname), async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname
      const remote = pathname.startsWith("/api/backends/a/")
      const path = remote ? pathname.slice("/api/backends/a".length) : pathname
      let body: any = {}
      if (path === "/api/remote-servers/a/forget") { forgets++; body = { ok: true } }
      else if (path.startsWith("/api/storage/")) {
        if (!remote && path.endsWith("/state/ui") && request.method() !== "GET") {
          profileWrites++
          savedServers = request.postDataJSON().remoteServers ?? savedServers
        }
        body = remote ? {} : path.endsWith("/config/ui") ? { settings: { multiBackend: mode !== "disabled", locale: "en" } }
          : path.endsWith("/state/ui") ? { remoteServers: savedServers } : {}
      } else if (path === "/api/remote-servers/a/connect") {
        assert.equal(remote, false)
        assert.deepEqual(request.postDataJSON(), mode === "pairing" ? { pairingLink: `https://a.test/remote-pair#${"p".repeat(32)}` } : { username: "user", password: "secret" })
        healthy = true; body = { ok: true }
      }
      else if (remote && !healthy && path === "/api/meta") {
        return route.fulfill({ status: ["auth", "pairing"].includes(mode) ? 401 : mode === "refused" ? 200 : 503,
          json: mode === "refused" ? { apiContract: -1, serverId: "a" } : { error: "unavailable" } })
      } else if (path === "/api/auth/status") body = { authenticated: healthy }
      else if (path === "/api/meta") body = { apiContract: CODENOMAD_API_CONTRACT, serverId: remote ? "a" : "local",
        ...(!remote ? { localRequest: true, secretEntryAllowed: true } : {}) }
      else if (path === "/api/workspaces") {
        if (request.method() === "POST") {
          const input = request.postDataJSON()
          creates.push(`${remote ? "a" : "local"}:${input.path}`)
          if (remote && mode === "partial-refusal" && creates.filter(value => value === "a:/same").length === 2) {
            return route.fulfill({ status: 403, json: { error: "refused" } })
          }
          if (remote && mode === "uncertain") return route.fulfill({ status: 503, json: { error: "unconfirmed" } })
          if (remote && mode === "closed") { markCreate(); await createGate }
          body = { ...descriptor(remote ? `remote-${generation}-${projects.length}` : "local", input.path), requestId: input.requestId }
          if (remote) projects.push(body)
        } else body = remote ? projects : []
      } else if (path.endsWith("/worktrees")) body = { isGitRepo: false, worktrees: [] }
      else if (remote && path.startsWith("/api/workspaces/") && request.method() === "DELETE") {
        const id = path.slice("/api/workspaces/".length)
        const index = projects.findIndex(project => project.id === id)
        if (index >= 0) projects.splice(index, 1)
      }
      else if (path.includes("/instance/api/")) body = { data: [], cursor: {} }
      const headers = remote && path === "/api/meta" ? { [RELAY_AUTHORITY_HEADER]: "x".repeat(43) } : undefined
      await route.fulfill({ json: body, headers })
    })
    try {
      await page.goto(url)
      if (mode === "closed") {
        await createStarted
        await page.waitForFunction(() => (window as any).restoreFixture?.tabs().filter((tab: any) => tab.kind === "remote-restore").length === 2)
        await page.evaluate(() => { const f = (window as any).restoreFixture; for (const tab of f.tabs().filter((tab: any) => tab.kind === "remote-restore")) f.close(tab.id) })
        releaseCreate()
      }
      await page.locator('[data-restoring="false"]').waitFor()
      await page.waitForFunction(() => (window as any).restoreFixture.tabs().some((tab: any) => tab.id === "instance:local"))
      if (mode === "partial-refusal") {
        const before = await page.evaluate(() => (window as any).restoreFixture.tabs())
        assert.equal(before.length, 3)
        assert.equal(before[1].kind, "remote-restore")
        assert.equal(before[2].drafts.__no_session_draft__, "draft-2")
        await page.evaluate(() => (window as any).restoreFixture.retry())
        const after = await page.evaluate(() => (window as any).restoreFixture.tabs())
        assert.equal(after.length, 3, "Retry must retain both occurrences")
        assert.equal(after[2].id, before[2].id, "the successful active occurrence keeps its binding")
        assert.deepEqual(after.map((tab: any) => tab.drafts.__no_session_draft__), ["draft-0", "draft-1", "draft-2"])
        assert.equal(creates.filter(value => value === "a:/same").length, 3, "Retry creates the definitively refused occurrence")
      }
      if (["offline", "auth", "pairing", "refused", "absent"].includes(mode)) {
        assert.equal(await page.getByRole("tab").count(), 3)
        assert.equal(await page.locator('[data-remote-restore="a"]').count(), 1)
        if (mode === "absent") {
          const restore = page.locator('[data-remote-restore="a"]')
          assert.equal(await restore.getByRole("status").textContent(), "Server not found")
          assert.ok(await restore.getByRole("button", { name: "Retry" }).isDisabled())
          assert.ok(await restore.getByRole("button", { name: "Connect" }).isDisabled())
        }
        const snapshot = await page.evaluate(() => (window as any).restoreFixture.snapshot())
        assert.equal(snapshot.tabs[2].drafts.__no_session_draft__, "draft-2")
        if (mode === "offline") {
          const writes = profileWrites
          for (const action of ["retargetServerQueued"]) {
            const editing = page.evaluate(action => (window as any).restoreFixture[action](), action)
            await page.getByRole("button", { name: "Cancel", exact: true }).click()
            await editing
          }
          assert.equal(forgets, 0, "cancelling an address change keeps the saved connection")
          assert.equal(profileWrites, writes, "cancelling keeps the saved profile")
        }
        if (mode === "auth" || mode === "pairing") {
          await page.getByRole("button", { name: "Connect", exact: true }).click()
          if (mode === "pairing") {
            const field = page.locator('[data-remote-restore="a"]').getByLabel("New pairing link", { exact: true })
            await field.fill(`https://a.test/remote-pair#${"p".repeat(32)}`)
            await field.press("Enter")
          } else {
            assert.equal(await page.getByLabel("Username", { exact: true }).inputValue(), "codenomad")
            await page.getByLabel("Username", { exact: true }).fill("user")
            await page.getByLabel("Password", { exact: true }).fill("secret")
            await page.getByRole("button", { name: "Sign in", exact: true }).click()
          }
        } else if (mode !== "absent") {
          healthy = true
          await page.evaluate(() => Promise.all([(window as any).restoreFixture.retry(), (window as any).restoreFixture.retry()]))
        }
      }
      if (mode === "uncertain") {
        assert.equal(creates.filter(value => value === "a:/same").length, 2)
        await page.evaluate(() => (window as any).restoreFixture.retry())
        assert.equal(creates.filter(value => value === "a:/same").length, 2, "an uncertain create is never replayed")
        const placeholders = await page.evaluate(() => (window as any).restoreFixture.tabs().filter((tab: any) => tab.kind === "remote-restore"))
        assert.equal(placeholders.length, 2)
        await page.evaluate(() => { const f = (window as any).restoreFixture; for (const tab of f.tabs().filter((tab: any) => tab.kind === "remote-restore")) f.close(tab.id) })
        await page.evaluate(() => (window as any).restoreFixture.retry())
        assert.equal(await page.getByRole("tab").count(), 1)
      }
      if (!["absent", "disabled", "closed", "uncertain"].includes(mode)) {
        await page.waitForFunction(() => (window as any).restoreFixture.tabs().filter((tab: any) => tab.kind === "instance").length === 3)
        const tabs = await page.evaluate(() => (window as any).restoreFixture.tabs())
        assert.deepEqual(tabs.map((tab: any) => tab.folder), ["/local", "/same", "/same"])
        assert.deepEqual(tabs.map((tab: any) => tab.drafts.__no_session_draft__), ["draft-0", "draft-1", "draft-2"])
        assert.equal(await page.evaluate(() => (window as any).restoreFixture.active()), tabs[2].id)
        const expectedCreates = mode === "partial-refusal" ? 3 : 2
        assert.equal(creates.filter(value => value === "a:/same").length, expectedCreates)
        if (mode === "cancel-quit") {
          await page.evaluate(async () => {
            const flush = window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__!
            await flush("prepare")
            await flush("release")
            const fixture = (window as any).restoreFixture
            for (const tab of fixture.tabs()) fixture.stopped(tab.id)
          })
          await page.waitForFunction(() => (window as any).restoreFixture.tabs().length === 0)
          assert.deepEqual(projects.map(project => project.id), ["existing-0", "existing-1"], "only the renderer's records went through the relay")
          generation++
          await page.evaluate(() => window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__!("cancel"))
          await page.waitForFunction(() => (window as any).restoreFixture.tabs().filter((tab: any) => tab.kind === "instance").length === 3)
          const recovered = await page.evaluate(() => (window as any).restoreFixture.tabs())
          assert.deepEqual(recovered.map((tab: any) => tab.drafts.__no_session_draft__), ["draft-0", "draft-1", "draft-2"])
          assert.ok(recovered.slice(1).every((tab: any) => tab.id.startsWith("instance:a~remote-1")))
          assert.equal(await page.evaluate(() => (window as any).restoreFixture.active()), recovered[2].id)
          assert.deepEqual(errors, [])
          return
        }
        const before = creates.length
        await page.waitForFunction(() => Boolean((window as any).committedState))
        const immediateReload = host === "electron" && mode === "reuse"
        if (immediateReload) {
          await page.waitForFunction(async id => (await (window as any).restoreFixture.saved())?.session?.tabs[1]?.workspaceId === id, tabs[1].id.slice("instance:".length))
          await page.evaluate(() => { (window as any).holdSnapshotCommit = true })
          await page.getByRole("tab").nth(1).click()
          assert.equal(await page.evaluate(() => (window as any).restoreFixture.active()), tabs[1].id)
          assert.equal(await page.evaluate(async () => (await (window as any).restoreFixture.saved()).session.activeTabIndex), 2)
          healthy = false
        }
        await page.reload()
        if (immediateReload) {
          await page.locator('[data-restoring="false"]').waitFor()
          const pending = await page.evaluate(() => (window as any).restoreFixture.tabs())
          assert.equal(pending[1].kind, "remote-restore")
          assert.equal(pending[1].drafts.__no_session_draft__, "draft-1")
          assert.equal(await page.evaluate(() => (window as any).restoreFixture.active()), pending[1].id)
          healthy = true
          await page.evaluate(() => (window as any).restoreFixture.retry())
        }
        await page.waitForFunction(() => (window as any).restoreFixture?.tabs().filter((tab: any) => tab.kind === "instance").length === 3)
        const reloaded = await page.evaluate(() => (window as any).restoreFixture.tabs())
        assert.equal(await page.evaluate(() => (window as any).restoreFixture.active()), reloaded[immediateReload ? 1 : 2].id)
        assert.deepEqual(reloaded.map((tab: any) => tab.drafts.__no_session_draft__), ["draft-0", "draft-1", "draft-2"])
        assert.ok(reloaded.slice(1).every((tab: any) => tabs.every((original: any) => tab.id !== original.id)))
        const secondWindow = await context.newPage()
        await secondWindow.goto(`${url}?fresh`)
        await secondWindow.waitForFunction(() => (window as any).restoreFixture?.tabs().filter((tab: any) => tab.kind === "instance").length === 3)
        assert.equal((await secondWindow.evaluate(() => (window as any).restoreFixture.tabs()))[2].drafts.__no_session_draft__, "draft-2")
        assert.equal(creates.filter(value => value === "a:/same").length, expectedCreates + 4, "reload and a second window open independent occurrences")
        assert.equal(creates.length, before + 6)
        await secondWindow.close()
        // Retry recreates the unavailable occurrences.
        projects.splice(0); generation++
        await page.evaluate(() => (window as any).restoreFixture.restartBackend())
        await page.evaluate(() => (window as any).restoreFixture.retry())
        assert.equal(creates.filter(value => value === "a:/same").length, expectedCreates + 6)
        await page.waitForFunction(() => (window as any).restoreFixture.tabs().filter((tab: any) => tab.id.includes("remote-1")).length === 2)
        const restored = await page.evaluate(() => (window as any).restoreFixture.tabs())
        assert.equal(restored[2].drafts.__no_session_draft__, "draft-2")
        if (mode === "create" || mode === "pairing" || mode === "auto-off") {
          if (mode === "auto-off") await page.evaluate(() => (window as any).restoreFixture.disableAutoRestore())
          await page.evaluate(id => (window as any).restoreFixture.notify(id), restored[2].id)
          const count = creates.filter(value => value.startsWith("a:")).length
          healthy = false
          await page.evaluate(() => (window as any).restoreFixture.disconnect())
          await page.waitForFunction(() => (window as any).restoreFixture.tabs().filter((tab: any) => tab.kind === "remote-restore").length === 2)
          assert.equal(await page.evaluate(() => (window as any).restoreFixture.state()), mode === "pairing" ? "unauthorized" : "unreachable")
          assert.equal(await page.getByRole("tab").count(), 3)
          const suspended = await page.evaluate(() => (window as any).restoreFixture.tabs())
          await page.evaluate(() => (window as any).restoreFixture.activateNotice())
          assert.deepEqual(await page.evaluate(() => (window as any).restoreFixture.tabs()), suspended, "notification navigation preserves the waiting occurrences and drafts")
          assert.equal(await page.evaluate(() => (window as any).restoreFixture.active()), suspended[2].id)
          if (mode === "pairing") {
            await page.getByRole("button", { name: "Connect", exact: true }).click()
            const field = page.locator('[data-remote-restore="a"]').getByLabel("New pairing link", { exact: true })
            await field.fill(`https://a.test/remote-pair#${"p".repeat(32)}`)
            await field.press("Enter")
          } else {
            healthy = true
            await page.evaluate(() => (window as any).restoreFixture.retry())
          }
          await page.waitForFunction(() => (window as any).restoreFixture.tabs().every((tab: any) => tab.kind === "instance"))
          assert.equal(creates.filter(value => value.startsWith("a:")).length, count, "reconnect reuses the retained occurrences")
          assert.deepEqual((await page.evaluate(() => (window as any).restoreFixture.tabs())).map((tab: any) => tab.drafts.__no_session_draft__), ["draft-0", "draft-1", "draft-2"])
        }
        if (mode === "create") {
          const beforeWrites = profileWrites, beforeForgets = forgets, beforeRecords = projects.length
          await page.evaluate(() => { (window as any).__removedServer = (window as any).restoreFixture.removeServerQueued() })
          await page.getByText(/closing 2 open tabs/).waitFor()
          await page.getByRole("button", { name: "Remove", exact: true }).click()
          await page.evaluate(() => (window as any).__removedServer)
          await page.waitForFunction(() => (window as any).restoreFixture.tabs().length === 1)
          assert.equal(await page.getByRole("tab").count(), 1, "forgetting a server closes only its tabs")
          assert.equal(forgets, beforeForgets + 1)
          assert.equal(profileWrites, beforeWrites + 1)
          assert.equal(projects.length, beforeRecords, "forgetting a server does not delete its records")
        }
      }
      assert.equal(creates.filter(value => value.startsWith("local:")).every(value => value === "local:/local"), true)
      assert.deepEqual(errors, [])
    } catch (error) {
      throw new Error(`${String(error)}\n${JSON.stringify({ errors, creates, state: await page.evaluate(() => ({
        tabs: (window as any).restoreFixture?.tabs(), state: (window as any).restoreFixture?.state(),
      })) })}`, { cause: error })
    } finally { releaseCreate(); await context.close() }
  })
}
function descriptor(id: string, path: string) {
  return { id, path, status: "ready", port: 1234, proxyPath: `/workspaces/${id}/instance`,
    binaryId: "fixture", createdAt: "", updatedAt: "" }
}
