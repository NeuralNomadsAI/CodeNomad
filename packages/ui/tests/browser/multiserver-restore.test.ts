import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "multiserver-restore", routes: [{ path: "/fixture", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/project-tab-restore.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

for (const host of ["electron", "tauri"]) test(`${host} preserves remote orphans across recapture and reload without local creation or recovery requests`, async () => {
  const page = await browser.newPage()
  const errors: string[] = [], forbidden: string[] = [], explicitOpens: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(host => {
    const win = window as any
    // tsx preserves nested function names when serializing this init callback.
    win.__name = Object
    win.__CODENOMAD_RUNTIME_HOST__ = host
    win.__CODENOMAD_WINDOW_CONTEXT__ = "local"
    win.EventSource = class extends EventTarget { close() {} }
    const session = { activeTabIndex: 1, tabs: ["missing-credentials", "deleted-profile"].map(serverId => ({
      kind: "workspace", serverId, folder: "D:/same", occurrence: 0,
      activeSessionId: "same", activeParentSessionId: "same", drafts: { same: serverId },
      attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
    })) }
    const initial = { version: 1, revision: 1, savedAt: 1, layout: {}, session }
    const persisted = JSON.parse(sessionStorage.getItem("server-state") || "null")
    const load = () => ({ isPrimary: true, restoreEnabled: true, partitionProtocolVersion: 1, snapshot: persisted?.snapshot ?? initial })
    const commit = (value: any) => { win.committedState = value; sessionStorage.setItem("server-state", JSON.stringify(value)); return true }
    win.electronAPI = {
      claimClientStateAccess: async () => true, loadClientState: async () => load(),
      loadClientStatePartition: async (_token: string, key: string) => persisted?.partitions[key] ?? null,
      commitClientStatePartitions: async (_token: string, value: any) => commit(value),
      saveClientState: async () => true,
    }
    if (host === "tauri") {
      win.__TAURI_INTERNALS__ = { transformCallback: () => 1, invoke: async (command: string, args: any) => {
        if (command === "client_state_load") return load()
        if (command === "client_state_load_partition") return persisted?.partitions[args.key] ?? null
        if (command === "client_state_commit_partitions") return commit(args.payload)
        return true
      } }
      win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    }
  }, host)
  await page.route(/\/(?:api|workspaces)\//, async route => {
    const req = route.request(), path = new URL(req.url()).pathname
    // A saved remote project reopens on its own server only; a refused server keeps the orphan.
    if (path === "/api/workspaces" && req.method() === "POST") {
      const body = req.postDataJSON()
      if (!body.serverId) forbidden.push(`local create ${body.path}`)
      explicitOpens.push(`${body.serverId} ${body.path}`)
      return route.fulfill({ status: 400, contentType: "text/plain", body: "unknown server" })
    }
    if (path.startsWith("/workspaces/") || path.includes("worktrees") || path.includes("pending") || path.includes("filesystem") || path.includes("git-")) forbidden.push(`${req.method()} ${path}`)
    await route.fulfill({ json: path === "/api/workspaces" ? [] : {} })
  })
  try {
    await page.goto(url)
    for (let pass = 0; pass < 2; pass++) {
      await page.locator('[data-restoring="false"]').waitFor()
      await page.evaluate(pass => (window as any).flushFixtureLayout(String(pass)), pass)
      assert.ok(await page.evaluate(() => Boolean((window as any).committedState)), `layout flush must commit: ${errors.join("; ")}`)
      const saved = await page.evaluate(() => (window as any).decodeSavedState())
      assert.equal(saved.session.activeTabIndex, 1)
      assert.deepEqual(saved.session.tabs.map((tab: any) => [tab.serverId, tab.folder, tab.drafts.same]), [
        ["missing-credentials", "D:/same", "missing-credentials"], ["deleted-profile", "D:/same", "deleted-profile"],
      ])
      assert.equal(await page.getByRole("tab").count(), 0)
      await page.evaluate(() => (window as any).runtimeRecovery.continueOpenCodeSetup())
      if (pass === 0) await page.reload()
    }
    assert.deepEqual(forbidden, [])
    assert.ok(explicitOpens.every(open => open === "missing-credentials D:/same" || open === "deleted-profile D:/same"))
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

// prototype-1236 (R11): a saved project on a reachable OpenCode server is restored like a local one.
for (const host of ["electron", "tauri"]) test(`${host} reopens a saved server project tab on its own server`, async () => {
  const page = await browser.newPage()
  const errors: string[] = [], creates: any[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(host => {
    const win = window as any
    win.__name = Object
    win.__CODENOMAD_RUNTIME_HOST__ = host
    win.__CODENOMAD_WINDOW_CONTEXT__ = "local"
    win.EventSource = class extends EventTarget { close() {} }
    const session = { activeTabIndex: 0, tabs: [{ kind: "workspace", serverId: "oc-test", folder: "/srv/project", occurrence: 0,
      drafts: { __no_session_draft__: "kept" }, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {} }] }
    const load = () => ({ isPrimary: true, restoreEnabled: true, partitionProtocolVersion: 1, snapshot: { version: 1, revision: 1, savedAt: 1, layout: {}, session } })
    const commit = (value: any) => { win.committedState = value; return true }
    win.electronAPI = { claimClientStateAccess: async () => true, loadClientState: async () => load(),
      loadClientStatePartition: async () => null, commitClientStatePartitions: async (_token: string, value: any) => commit(value), saveClientState: async () => true }
    if (host === "tauri") {
      win.__TAURI_INTERNALS__ = { transformCallback: () => 1, invoke: async (command: string, args: any) => {
        if (command === "client_state_load") return load()
        if (command === "client_state_load_partition") return null
        if (command === "client_state_commit_partitions") return commit(args.payload)
        return true
      } }
      win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    }
  }, host)
  const workspace = { id: "remote", path: "/srv/project", binding: { serverId: "oc-test", directory: "/srv/project" }, status: "ready",
    proxyPath: "/workspaces/remote/instance", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }
  await page.route(/\/(?:api|workspaces)\//, async route => {
    const req = route.request(), path = new URL(req.url()).pathname
    if (path === "/api/workspaces" && req.method() === "POST") {
      creates.push(req.postDataJSON())
      return route.fulfill({ status: 201, json: { ...workspace, requestId: req.postDataJSON().requestId } })
    }
    return route.fulfill({ json: path === "/api/workspaces" ? [] : path.endsWith("/session") ? { data: [], cursor: {} }
      : path.endsWith("/worktrees") ? { worktrees: [] } : {} })
  })
  try {
    await page.goto(url)
    await page.locator('[data-restoring="false"]').waitFor()
    assert.deepEqual(creates.map(body => [body.serverId, body.path]), [["oc-test", "/srv/project"]])
    await page.getByRole("tab", { name: "/srv/project" }).waitFor()
    assert.equal(await page.getByRole("tab").count(), 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const host of ["electron", "tauri"]) test(`${host} closed explicit occurrence stays absent after failed DELETE, capture and reload`, async () => {
  const context = await browser.newContext()
  const page = await context.newPage()
  let sibling: Awaited<ReturnType<typeof browser.newPage>> | undefined
  const errors: string[] = [], deletes: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const projects = [
    { id: "local", serverId: "local-shared", directory: "D:/same" },
    { id: "first", serverId: "A", directory: "D:/same" },
    { id: "a2", serverId: "A", directory: "D:/same" },
    { id: "b", serverId: "B", directory: "D:/same" },
    { id: "alias", serverId: "A", directory: "d:/same" },
  ]
  await page.context().addInitScript(({ host, projects }) => {
    const win = window as any
    win.__name = Object
    win.__CODENOMAD_RUNTIME_HOST__ = host
    win.__CODENOMAD_WINDOW_CONTEXT__ = "local"
    win.EventSource = class extends EventTarget { close() {} }
    const snapshot = { version: 1, revision: 1, savedAt: 1, layout: {}, session: { activeTabIndex: 1,
      tabs: projects.map((target, index) => ({ kind: "workspace", serverId: target.serverId, folder: target.directory,
        occurrence: index === 2 ? 1 : 0, drafts: { __no_session_draft__: target.id }, attachments: {},
        scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {} })),
    } }
    const persisted = JSON.parse(sessionStorage.getItem("closed-state") || "null")
    const load = () => ({ isPrimary: true, restoreEnabled: true, partitionProtocolVersion: 1, snapshot: persisted?.snapshot ?? snapshot })
    const commit = (value: any) => { win.committedState = value; sessionStorage.setItem("closed-state", JSON.stringify(value)); return true }
    win.electronAPI = { claimClientStateAccess: async () => true, loadClientState: async () => load(),
      loadClientStatePartition: async (_token: string, key: string) => persisted?.partitions[key] ?? null,
      commitClientStatePartitions: async (_token: string, value: any) => commit(value), saveClientState: async () => true }
    if (host === "tauri") {
      win.__TAURI_INTERNALS__ = { transformCallback: () => 1, invoke: async (command: string, args: any) => {
        if (command === "client_state_load") return load()
        if (command === "client_state_load_partition") return persisted?.partitions[args.key] ?? null
        if (command === "client_state_commit_partitions") return commit(args.payload)
        return true
      } }
      win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    }
  }, { host, projects })
  await page.context().route(/\/(?:api|workspaces)\//, async route => {
    const req = route.request(), path = new URL(req.url()).pathname
    if (req.method() === "DELETE") {
      deletes.push(path)
      return route.fulfill({ status: 503, json: { error: "fixture-close-failure" } })
    }
    const data = projects.map(({ id, ...binding }) => ({ id, path: binding.directory, binding, status: "ready",
      proxyPath: `/workspaces/${id}/instance`, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }))
    return route.fulfill({ json: path === "/api/workspaces" ? data : path.endsWith("/session") ? { data: [], cursor: {} }
      : path.endsWith("/worktrees") ? { worktrees: [] } : {} })
  })
  try {
    await page.goto(url)
    sibling = await page.context().newPage()
    await sibling.goto(url)
    await sibling.locator('[data-restoring="false"]').waitFor()
    await page.locator('[data-restoring="false"]').waitFor()
    assert.equal(await page.getByRole("tab").count(), 5)
    await page.evaluate(() => (window as any).flushFixtureLayout("before-close"))
    await page.evaluate(() => (window as any).runtimeRecovery.closeFirst())
    assert.equal(await page.getByRole("tab").count(), 4)
    for (let pass = 0; pass < 2; pass++) {
      await page.locator('[data-restoring="false"]').waitFor()
      await page.evaluate(pass => (window as any).flushFixtureLayout(`after-close-${pass}`), pass)
      const saved = await page.evaluate(() => (window as any).decodeSavedState())
      assert.deepEqual(saved.session.tabs.map((tab: any) => [tab.serverId, tab.folder, tab.drafts.__no_session_draft__]), [
        ["local-shared", "D:/same", "local"], ["A", "D:/same", "a2"], ["B", "D:/same", "b"], ["A", "d:/same", "alias"],
      ])
      assert.equal(await page.getByRole("tab").count(), 4)
      if (pass === 0) await page.reload()
    }
    assert.deepEqual(deletes, ["/api/workspaces/first"])
    await sibling.evaluate(() => (window as any).flushFixtureLayout("other-window"))
    assert.equal(await sibling.getByRole("tab").count(), 5)
    const siblingSaved = await sibling.evaluate(() => (window as any).decodeSavedState())
    assert.deepEqual(siblingSaved.session.tabs.map((tab: any) => tab.drafts.__no_session_draft__), projects.map(project => project.id))
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})
