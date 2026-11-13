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

for (const host of ["electron", "tauri"]) for (const mode of ["create", "reuse", "offline", "auth", "pairing", "refused", "absent", "disabled", "closed", "uncertain", "partial-refusal", "auto-off"]) {
  test(`${host}: real restore hook preserves remote occurrences (${mode})`, async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    page.setDefaultNavigationTimeout(60_000)
    const errors: string[] = [], creates: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await context.addInitScript(({ host }) => {
      ;(window as any).__name = new Function("value", "return value")
      Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: host, __CODENOMAD_WINDOW_CONTEXT__: "local" })
      window.EventSource = class extends EventTarget { close() {} } as any
      const session = { activeTabIndex: 2, tabs: [
        { folder: "/local" }, { folder: "/same", backendId: "a", occurrence: 0 }, { folder: "/same", backendId: "a", occurrence: 1 },
      ].map((value, index) => ({ kind: "workspace", ...value, drafts: { __no_session_draft__: `draft-${index}` },
        attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {} })) }
      const snapshot = { version: 1, revision: 1, savedAt: 1, layout: {}, session }
      const persisted = JSON.parse(sessionStorage.getItem("restored-state") || "null")
      const load = () => ({ isPrimary: true, restoreEnabled: true, snapshot: persisted?.snapshot || snapshot, partitionProtocolVersion: 1 })
      const commit = (value: any) => { (window as any).committedState = value; sessionStorage.setItem("restored-state", JSON.stringify(value)); return true }
      ;(window as any).electronAPI = { claimClientStateAccess: async () => true, loadClientState: async () => load(),
        loadClientStatePartition: async (_token: any, key: string) => persisted?.partitions[key] ?? null, commitClientStatePartitions: async (_token: any, value: any) => commit(value),
        saveClientState: async () => true, setClientStateRestoreEnabled: async () => true }
      if (host === "tauri") {
        ;(window as any).__TAURI_INTERNALS__ = { transformCallback: () => 1, invoke: async (command: string, args: any) =>
          command === "client_state_load" ? load() : command === "client_state_load_partition" ? persisted?.partitions[args.key] ?? null
            : command === "client_state_commit_partitions" ? commit(args.payload) : true }
        ;(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
      }
    }, { host })
    let healthy = !["offline", "auth", "pairing", "refused"].includes(mode)
    let generation = 0
    let profileWrites = 0
    const projects: any[] = mode === "reuse" ? [0, 1].map(index => descriptor(`existing-${index}`, "/same")) : []
    let releaseCreate!: () => void
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
    let markCreate!: () => void
    const createStarted = new Promise<void>(resolve => { markCreate = resolve })
    await context.route(/\/(?:api|workspaces)\//, async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname
      const remote = pathname.startsWith("/api/backends/a/")
      const path = remote ? pathname.slice("/api/backends/a".length) : pathname
      let body: any = {}
      if (path.startsWith("/api/storage/")) {
        if (!remote && path.endsWith("/state/ui") && request.method() !== "GET") profileWrites++
        body = remote ? {} : path.endsWith("/config/ui") ? { settings: { multiBackend: mode !== "disabled" } }
          : path.endsWith("/state/ui") ? { remoteServers: mode === "absent" ? [] : [
            { id: "a", name: "Server A", baseUrl: "https://a.test", skipTlsVerify: false, createdAt: "", updatedAt: "" },
          ] } : {}
      } else if (path === "/api/auth/login") {
        assert.equal(remote, true)
        assert.deepEqual(request.postDataJSON(), mode === "pairing" ? { pairingLink: `https://a.test/remote-pair#${"p".repeat(32)}` } : { username: "user", password: "secret" })
        healthy = true; body = { ok: true }
      }
      else if (remote && !healthy && path === "/api/meta") {
        return route.fulfill({ status: ["auth", "pairing"].includes(mode) ? 401 : mode === "refused" ? 200 : 503,
          json: mode === "refused" ? { apiContract: -1, serverId: "a" } : { error: "unavailable" } })
      } else if (path === "/api/auth/status") body = { authenticated: healthy }
      else if (path === "/api/meta") body = { apiContract: CODENOMAD_API_CONTRACT, serverId: remote ? "a" : "local" }
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
        assert.equal(creates.filter(value => value === "a:/same").length, 3, "only the definitively refused occurrence is recreated")
      }
      if (["offline", "auth", "pairing", "refused", "absent"].includes(mode)) {
        assert.equal(await page.getByRole("tab").count(), 3)
        assert.equal(await page.locator('[data-remote-restore="a"]').count(), 1)
        const snapshot = await page.evaluate(() => (window as any).restoreFixture.snapshot())
        assert.equal(snapshot.tabs[2].drafts.__no_session_draft__, "draft-2")
        if (mode === "auth" || mode === "pairing") {
          await page.getByRole("button", { name: "Connect", exact: true }).click()
          if (mode === "pairing") await page.getByLabel("Pairing link", { exact: true }).fill(`https://a.test/remote-pair#${"p".repeat(32)}`)
          else {
            await page.getByLabel("Username", { exact: true }).fill("user")
            await page.getByLabel("Password", { exact: true }).fill("secret")
          }
          await page.getByRole("button", { name: "Connect", exact: true }).first().click()
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
        assert.equal(creates.filter(value => value === "a:/same").length, mode === "reuse" ? 0 : mode === "partial-refusal" ? 3 : 2)
        const before = creates.length
        await page.waitForFunction(() => Boolean((window as any).committedState))
        await page.reload()
        await page.waitForFunction(() => (window as any).restoreFixture?.tabs().filter((tab: any) => tab.kind === "instance").length === 3)
        assert.deepEqual((await page.evaluate(() => (window as any).restoreFixture.tabs())).map((tab: any) => tab.drafts.__no_session_draft__), ["draft-0", "draft-1", "draft-2"])
        const secondWindow = await context.newPage()
        await secondWindow.goto(url)
        await secondWindow.waitForFunction(() => (window as any).restoreFixture?.tabs().filter((tab: any) => tab.kind === "instance").length === 3)
        assert.equal((await secondWindow.evaluate(() => (window as any).restoreFixture.tabs()))[2].drafts.__no_session_draft__, "draft-2")
        assert.equal(creates.filter(value => value === "a:/same").length, mode === "reuse" ? 0 : mode === "partial-refusal" ? 3 : 2, "restart and another window reuse remote occurrences")
        assert.equal(creates.length, before + 2, "only the mock local inventory is empty on restart and in the second window")
        await secondWindow.close()
        // A backend restart replaces UUIDs; Retry recreates the same logical tabs.
        projects.splice(0); generation++
        await page.evaluate(() => (window as any).restoreFixture.restartBackend())
        await page.evaluate(() => (window as any).restoreFixture.retry())
        await page.waitForFunction(() => (window as any).restoreFixture.tabs().filter((tab: any) => tab.id.includes("remote-1")).length === 2)
        const restored = await page.evaluate(() => (window as any).restoreFixture.tabs())
        assert.equal(restored[2].drafts.__no_session_draft__, "draft-2")
        if (mode === "create" || mode === "pairing" || mode === "auto-off") {
          if (mode === "auto-off") await page.evaluate(() => (window as any).restoreFixture.disableAutoRestore())
          const count = creates.filter(value => value.startsWith("a:")).length
          healthy = false
          await page.evaluate(() => (window as any).restoreFixture.disconnect())
          await page.waitForFunction(() => (window as any).restoreFixture.tabs().filter((tab: any) => tab.kind === "remote-restore").length === 2)
          assert.equal(await page.evaluate(() => (window as any).restoreFixture.state()), mode === "pairing" ? "unauthorized" : "unreachable")
          assert.equal(await page.getByRole("tab").count(), 3)
          if (mode === "pairing") {
            await page.getByRole("button", { name: "Connect", exact: true }).click()
            await page.getByLabel("Pairing link", { exact: true }).fill(`https://a.test/remote-pair#${"p".repeat(32)}`)
            await page.getByRole("button", { name: "Connect", exact: true }).first().click()
          } else {
            healthy = true
            await page.evaluate(() => (window as any).restoreFixture.retry())
          }
          await page.waitForFunction(() => (window as any).restoreFixture.tabs().every((tab: any) => tab.kind === "instance"))
          assert.equal(creates.filter(value => value.startsWith("a:")).length, count, "reconnect reuses the retained occurrences")
          assert.deepEqual((await page.evaluate(() => (window as any).restoreFixture.tabs())).map((tab: any) => tab.drafts.__no_session_draft__), ["draft-0", "draft-1", "draft-2"])
        }
        assert.equal(await page.evaluate(() => (window as any).restoreFixture.removeServer().then(() => false, () => true)), true)
        if (mode === "create") {
          await page.evaluate(() => { const f = (window as any).restoreFixture; for (const tab of f.tabs().filter((tab: any) => tab.id.includes("a~"))) f.close(tab.id) })
          await page.waitForFunction(() => (window as any).restoreFixture.snapshot().tabs.every((tab: any) => !tab.backendId))
          const beforeWrites = profileWrites
          const cancelled = page.evaluate(() => (window as any).restoreFixture.removeServer())
          await page.getByRole("button", { name: "Cancel", exact: true }).click()
          await cancelled
          assert.equal(profileWrites, beforeWrites)
          const accepted = page.evaluate(() => (window as any).restoreFixture.removeServer())
          await page.getByRole("button", { name: "Confirm", exact: true }).click()
          await accepted
          assert.equal(profileWrites, beforeWrites + 1)
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
