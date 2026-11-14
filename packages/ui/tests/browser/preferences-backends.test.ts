import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import type { NativePreferencesRequest } from "../../src/lib/native/preferences-window"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "preferences-backends", routes: [
    { path: "/fixture", html: '<html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>' },
  ] })
  url = fixture.url + "?preferences=chat"
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

const project = (owner: string, section = "general"): NativePreferencesRequest => ({
  section: section as NativePreferencesRequest["section"], instanceId: owner === "local" ? "same" : `${owner}~same`,
  ...(owner === "local" ? {} : { serverId: `server-${owner}` }),
  workspacePath: "/homonym", location: { directory: "/homonym" },
})
async function host(page: Page, kind: "electron" | "tauri", initial: NativePreferencesRequest) {
  await page.addInitScript(({ kind, initial }) => {
    const w = window as any
    w.__name = (value: unknown) => value
    w.__CODENOMAD_RUNTIME_HOST__ = kind
    w.__CODENOMAD_WINDOW_CONTEXT__ = "preferences"
    w.request = initial
    w.EventSource = class extends EventTarget { close() {} }
    const accept = (request: unknown) => { w.request = request }
    w.electronAPI = kind === "electron" ? {
      getPreferencesRequest: async () => w.request, acceptPreferencesRequest: accept,
      onPreferencesSection: (listener: unknown) => { w.open = listener; return () => {} },
      onPreferencesCloseRequested: () => () => {}, onPreferencesTransitionRequested: () => () => {},
      preferencesReady: async () => { w.ready = true },
      openPreferences: async (section: string, context: object) => { w.opened = { section, ...context } },
      memoryCleanup: async (value: unknown) => { await w.fixtureRunCleanup?.(value); w.cleanup = value },
    } : undefined
    if (kind === "tauri") {
      const callbacks = new Map()
      w.__TAURI_INTERNALS__ = {
        transformCallback: (callback: unknown) => { const id = callbacks.size + 1; callbacks.set(id, callback); return id },
        invoke: async (command: string, args: any) => {
          if (command === "plugin:event|listen" && args.event === "preferences:section") w.open = (payload: unknown) => callbacks.get(args.handler)?.({ payload })
          if (command === "preferences_get_request") return w.request
          if (command === "preferences_accept_request") accept(args.request)
          if (command === "preferences_window_ready") w.ready = true
          if (command === "open_preferences_window") w.opened = args.request
          if (command === "preferences_memory_cleanup") { await w.fixtureRunCleanup?.(args.request); w.cleanup = args.request }
          return 1
        },
      }
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    }
  }, { kind, initial })
}

async function api(page: Page, selected: () => string) {
  const requests: { owner: string; path: string; method: string; body: any }[] = [], errors: string[] = []
  let restored = false, unavailable = false, missing = false, failWrites = false, identity = "server-a"
  let verificationFailure: { path: string; status: "network" | 401 | 503 } | undefined
  page.on("pageerror", error => errors.push(error.message))
  await page.route(/\/(?:api|workspaces)\//, async route => {
    const request = route.request(), raw = new URL(request.url()).pathname
    const match = /^\/api\/backends\/([^/]+)(\/.*)$/.exec(raw)
    const owner = match?.[1] ?? "local", path = match?.[2] ?? raw, method = request.method()
    const body = request.postData() ? JSON.parse(request.postData()!) : undefined
    requests.push({ owner, path, method, body })
    if (owner === "local" && selected() !== "local" && (path.startsWith("/api/memory") || path === "/api/workspaces" || path.includes("/workspaces/"))) {
      errors.push(`local sentinel: ${method} ${path}`)
      return route.fulfill({ status: 500, json: {} })
    }
    if (failWrites && (method === "PATCH" && path === "/api/storage/state/ui"
      || method === "POST" && path === "/api/remote-servers/a/forget")) {
      return route.fulfill({ status: 500, json: { error: "private-transport-detail-do-not-display" } })
    }
    if (owner === "a" && path === verificationFailure?.path) {
      return verificationFailure.status === "network" ? route.abort("connectionrefused")
        : route.fulfill({ status: verificationFailure.status, json: { error: "private-verification-detail-do-not-display" } })
    }
    if (owner !== "local" && unavailable) return route.fulfill({ status: 503, json: {} })
    const id = restored && owner !== "local" ? "restarted" : "same"
    const data = path.endsWith("/provider") ? [{ id: "ai", name: owner, activation: "enabled" }]
      : path.endsWith("/integration") ? [{ id: "ai", name: owner, methods: [{ type: "key", label: "API key" }], connections: [] }] : []
    const value = path === "/api/storage/config/ui" ? { settings: { locale: "en", multiBackend: true } }
      : path === "/api/storage/state/ui" ? { remoteServers: ["a", "b"].map(id => ({ id, name: id, baseUrl: `http://${id}.test`, skipTlsVerify: false, createdAt: "", updatedAt: "" })) }
      : path === "/api/meta" ? { serverId: owner === "a" ? identity : `server-${owner}`, apiContract: 1 }
      : path === "/api/workspaces" ? missing ? [] : [{ id, path: "/homonym", status: "ready", proxyPath: `/workspaces/${id}/instance` }]
      : path === "/api/memory/settings" ? { enabled: true }
      : path === "/api/memory" ? body.operation.action === "list" ? {
        entries: [{ id: "entry", title: `Memory ${owner}`, text: "Verified", type: "fact", sessionId: "s", revision: "a".repeat(64),
          createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", flagged: false }],
        scopeKey: "same", observedAt: "2026-11-01T00:00:00Z", cleanupWritable: true, cleanupDirectory: "/homonym",
      } : { revision: "b".repeat(64), flagged: false }
      : path.includes("/instance/api/") ? { data }
      : path.endsWith("/image-settings") ? { location: { directory: "/homonym" }, generation: { global: true, effective: true, models: [] } }
      : path.endsWith("/websearch-settings") ? { location: { directory: "/homonym" }, effective: null,
        scopes: [{ scope: "global", path: "/global.jsonc", selection: null }, { scope: "project", path: "/homonym/opencode.jsonc", selection: null }] } : {}
    return route.fulfill({ json: value, headers: owner !== "local" && path === "/api/meta" ? { "X-CodeNomad-Backend-Authority": owner.repeat(43) } : {} })
  })
  return { requests, errors, restore: () => { restored = true }, unavailable: () => { unavailable = true },
    missing: () => { missing = true }, failWrites: () => { failWrites = true },
    failVerification: (status: "network" | 401 | 503, path = "/api/meta") => { verificationFailure = { path, status } },
    replace: () => { identity = "replacement" } }
}

for (const kind of ["electron", "tauri"] as const) {
  for (const reason of ["usage", "transport", "network", "401", "503", "inventory"] as const) for (const action of ["delete", "retarget"] as const) test(`${kind}: Servers ${action} shows ${reason === "usage" ? "the actionable remote-context usage refusal" : `a masked ${reason} failure`}`, async () => {
    const page = await browser.newPage(), f = await api(page, () => "a")
    f.missing()
    if (reason === "transport") f.failWrites()
    if (reason === "network" || reason === "401" || reason === "503") f.failVerification(reason === "network" ? reason : Number(reason) as 401 | 503)
    if (reason === "inventory") f.failVerification(503, "/api/workspaces")
    await host(page, kind, reason === "usage" ? project("a", "servers") : { section: "servers" })
    try {
      await page.goto(url)
      await page.locator('[data-remote-server="a"]').waitFor()
      if (action === "delete") {
        await page.getByRole("button", { name: "Remove saved server: a", exact: true }).click()
        await page.getByRole("button", { name: "Remove saved server", exact: true }).click()
      } else {
        await page.getByRole("button", { name: "Edit server: a", exact: true }).click()
        await page.getByLabel("SSH host (optional)", { exact: true }).fill("other-lab")
        await page.getByRole("button", { name: "Save", exact: true }).click()
      }
      if (reason === "transport") await page.getByRole("button", { name: "Confirm", exact: true }).click()
      const alert = action === "retarget" ? page.getByRole("dialog").getByRole("alert") : page.getByRole("alert").first()
      await alert.waitFor()
      assert.equal(await alert.innerText(), reason === "usage"
        ? "Close this server’s tabs and reopen Settings from another project before removing or changing its address."
        : "Could not save the preference.")
      assert.equal((await page.locator("body").innerText()).includes("do-not-display"), false)
      const forget = (value: typeof f.requests[number]) => value.owner === "local" && value.method === "POST" && value.path === "/api/remote-servers/a/forget"
      const patch = (value: typeof f.requests[number]) => value.owner === "local" && value.method === "PATCH" && value.path === "/api/storage/state/ui"
      if (reason !== "transport") {
        if (reason === "usage") assert.equal(await page.getByText("Could not save the preference.", { exact: true }).count(), 0)
        else assert.equal(await page.getByText("Close this server’s tabs and reopen Settings from another project before removing or changing its address.", { exact: true }).count(), 0)
        assert.equal(f.requests.some(value => forget(value) || patch(value)), false)
      } else assert.ok(f.requests.some(action === "delete" ? forget : patch))
      if (!["usage", "transport"].includes(reason)) {
        assert.ok(f.requests.some(value => value.owner === "a" && value.method === "GET"
          && value.path === (reason === "inventory" ? "/api/workspaces" : "/api/meta")))
      }
      assert.equal(await page.locator('[data-remote-server="a"]').count(), 1)
      assert.deepEqual(f.errors, [])
    } finally { await page.close() }
  })

  for (const state of ["offline", "missing"] as const) test(`${kind}: restored remote Preferences stay unavailable while restoration waits (${state})`, async () => {
    const page = await browser.newPage(), f = await api(page, () => "a")
    if (state === "offline") f.unavailable()
    else f.missing()
    await host(page, kind, project("a", "providers"))
    try {
      await page.goto(url)
      await page.waitForFunction(() => (window as any).ready)
      await page.getByRole("status").filter({ hasText: "Open a project to connect" }).waitFor()
      assert.equal(await page.getByLabel("Image generation", { exact: true }).count(), 0)
      assert.equal(await page.getByLabel("For the current project", { exact: true }).count(), 0)
      assert.equal(await page.evaluate(() => (window as any).request.instanceId), "a~same")
      assert.equal(f.requests.some(value => /\/(?:session|worktrees)(?:\/|$)/.test(value.path)), false)
      assert.equal(f.requests.some(value => value.path === "/api/workspaces" && value.method !== "GET"), false)
      assert.deepEqual(f.errors, [])
    } finally { await page.close() }
  })

  test(`${kind}: a remote Preferences context reserves its server even with an empty inventory`, async () => {
    const page = await browser.newPage(), f = await api(page, () => "a")
    f.missing()
    await host(page, kind, project("a", "providers"))
    const check = () => page.evaluate(async () => {
      const path = "/src/stores/remote-server-usage.ts"
      const { confirmRemoteServerChange } = await import(path)
      ;(window as any).usageResult = "pending"
      void confirmRemoteServerChange("a").then(value => { (window as any).usageResult = value ? "accepted" : "cancelled" },
        () => { (window as any).usageResult = "refused" })
    })
    try {
      const inventory = page.waitForResponse(response => new URL(response.url()).pathname === "/api/backends/a/api/workspaces")
      await page.goto(url)
      await inventory
      await page.getByRole("status").filter({ hasText: "Open a project to connect" }).waitFor()
      const before = f.requests.length
      await check()
      await page.waitForFunction(() => (window as any).usageResult !== "pending" || !!document.querySelector(".alert-dialog"))
      assert.equal(await page.evaluate(() => (window as any).usageResult), "refused")
      assert.equal(f.requests.length, before, "the native context refuses before registry or inventory work")
      await page.evaluate(() => (window as any).open({ section: "servers" }))
      await page.locator('[data-remote-server="a"]').waitFor()
      await check()
      await page.getByRole("button", { name: "Cancel", exact: true }).click()
      await page.waitForFunction(() => (window as any).usageResult === "cancelled")
      assert.deepEqual(f.errors, [])
    } finally { await page.close() }
  })

  test(`${kind}: detached Preferences clears Images and Web search, including retained hook snapshots`, async () => {
    const page = await browser.newPage(), f = await api(page, () => "a")
    await host(page, kind, project("a", "providers"))
    try {
      await page.goto(url)
      await page.getByRole("heading", { name: "Web search", exact: true }).click()
      await page.getByRole("heading", { name: "Images", exact: true }).click()
      await page.getByLabel("For the current project", { exact: true }).waitFor()
      await page.getByLabel("Image generation", { exact: true }).waitFor()
      await page.evaluate(async () => {
        const path = "/tests/browser/fixtures/preferences-provider-state.ts"
        ;(window as any).providerProbe = (await import(path)).observeProviderSettings("a~same")
      })
      await page.waitForFunction(() => {
        const state = (window as any).providerProbe.state()
        return !!state.image && !!state.search && state.providers.length > 0 && state.integrations.length > 0 && !state.busy
      })
      assert.equal(await page.evaluate(async () => {
        const path = "/src/stores/remote-backends.ts"
        return (await import(path)).backendRegistry.state("a")
      }), "compatible", "metadata-only admission satisfies the registry's inventory callback contract")
      await page.evaluate(async () => {
        const path = "/src/stores/remote-backends.ts"
        ;(await import(path)).backendRegistry.detach("a")
      })
      await page.waitForFunction(() => {
        const state = (window as any).providerProbe.state()
        return !state.image && !state.search && !state.providers.length && !state.integrations.length && !state.busy
      })
      assert.equal(await page.getByLabel("For the current project", { exact: true }).count(), 0)
      assert.equal(await page.getByLabel("Image generation", { exact: true }).count(), 0)
      assert.deepEqual(f.errors, [])
    } finally {
      await page.evaluate(() => (window as any).providerProbe?.dispose()).catch(() => {})
      await page.close()
    }
  })

  test(`${kind}: Preferences owns homonym projects, memory mutations and native cleanup intent`, async () => {
    const page = await browser.newPage()
    page.setDefaultTimeout(30_000)
    let selected = "local"
    const f = await api(page, () => selected)
    await host(page, kind, project("local"))
    try {
      await page.goto(url)
      for (const owner of ["local", "a", "b"]) {
        selected = owner
        if (owner !== "local") await page.evaluate(request => (window as any).open(request), project(owner))
        const card = page.locator("#agent-memory")
        await page.waitForFunction(() => (document.querySelector("#agent-memory select") as HTMLSelectElement)?.value === "project")
        await card.getByRole("button", { name: `Memory ${owner}` }).click()
        await card.getByRole("textbox", { name: "Title", exact: true }).fill(`Edited ${owner}`)
        await Promise.all([
          page.waitForResponse(response => response.request().postData()?.includes('"action":"save"') === true),
          card.getByRole("button", { name: "Save", exact: true }).click(),
        ])
        const write = f.requests.findLast(value => value.body?.operation?.action === "save")!
        assert.equal(write.owner, owner)
        assert.equal(write.body.context.workspaceId, "same", "HTTP receives the owner's raw record ID")
        assert.equal(f.requests.some(value => /\/(?:session|worktrees)(?:\/|$)/.test(value.path)), false, "admission must not hydrate instances")
        await page.evaluate(async id => {
          const path = "/tests/browser/fixtures/preferences-cleanup.ts"
          ;(await import(path)).installCleanupOpener(id)
        }, project(owner).instanceId!)
        const beforeCleanup = f.requests.filter(value => value.path === "/api/memory").length
        await card.getByRole("button", { name: "Tidy up", exact: true }).click()
        await page.getByRole("dialog").getByRole("button", { name: "Tidy up", exact: true }).click()
        await page.waitForFunction(() => !!(window as any).cleanup)
        assert.equal((await page.evaluate(() => (window as any).cleanup)).workspaceId, project(owner).instanceId)
        assert.deepEqual(await page.evaluate(() => (window as any).cleanupCalls), ["create", "prompt"])
        const checks = f.requests.filter(value => value.path === "/api/memory").slice(beforeCleanup)
        assert.ok(checks.length > 0, "Tidy up rechecks memory before creating a session")
        assert.ok(checks.every(value => value.owner === owner))
        if (owner !== "local") {
          const beforeRefusal = f.requests.length
          assert.equal(await page.evaluate(async owner => {
            const w = window as any
            return w.fixtureRunCleanup({ ...w.cleanup, id: `wrong-server-${owner}`, serverId: "replacement" }).then(() => false, () => true)
          }, owner), true)
          assert.equal(f.requests.length, beforeRefusal, "the opener refuses another server before any preflight")
        }
        await page.evaluate(() => { delete (window as any).cleanup })
        await page.evaluate(async id => {
          const path = "/tests/browser/fixtures/preferences-cleanup.ts"
          ;(await import(path)).releaseCleanupOpener(id)
        }, project(owner).instanceId!)
        await page.getByRole("button", { name: "Providers", exact: true }).click()
        if (!await page.locator("details").filter({ has: page.getByRole("heading", { name: "Web search", exact: true }) }).evaluate((element: HTMLDetailsElement) => element.open)) {
          await page.getByRole("heading", { name: "Web search", exact: true }).click()
        }
        await Promise.all([
          page.waitForResponse(response => response.request().method() === "PUT" && response.url().includes("/websearch-settings")),
          page.getByLabel("For the current project", { exact: true }).selectOption("off"),
        ])
        assert.equal(f.requests.findLast(value => value.path.endsWith("/websearch-settings") && value.method === "PUT")?.owner, owner)
        if (!await page.locator("details").filter({ has: page.getByRole("heading", { name: "Images", exact: true }) }).evaluate((element: HTMLDetailsElement) => element.open)) {
          await page.getByRole("heading", { name: "Images", exact: true }).click()
        }
        await Promise.all([
          page.waitForResponse(response => response.request().method() === "PUT" && response.url().includes("/image-settings")),
          page.getByLabel("Image generation", { exact: true }).selectOption("off"),
        ])
        assert.equal(f.requests.findLast(value => value.path.endsWith("/image-settings") && value.method === "PUT")?.owner, owner)
        await Promise.all([
          page.waitForResponse(response => response.url().includes("/service-usage")),
          page.getByRole("button", { name: "Stats", exact: true }).click(),
        ])
        assert.equal(f.requests.findLast(value => value.path.includes("/service-usage"))?.owner, owner)
      }
      await page.evaluate(request => (window as any).open(request), project("b"))
      const card = page.locator("#agent-memory")
      await card.getByRole("button", { name: "Memory b" }).click()
      await card.getByRole("textbox", { name: "Title", exact: true }).fill("Unsent b")
      await page.evaluate(async () => {
        const path = "/src/stores/remote-backends.ts"
        ;(await import(path)).backendRegistry.detach("b")
      })
      await page.waitForFunction(() => (document.querySelector('#agent-memory input[role="switch"]') as HTMLInputElement)?.disabled)
      await page.evaluate(async () => {
        const path = "/src/stores/remote-backends.ts"
        await (await import(path)).backendRegistry.ensure("b")
      })
      await page.waitForFunction(() => (document.querySelector('#agent-memory input[id$="-title"]') as HTMLInputElement)?.value === "Unsent b")
      // Native opening adapters retain the same qualified project and durable server identity.
      const request = project("b", "providers")
      const beforeWrongOwner = f.requests.length
      assert.equal(await page.evaluate(async () => {
        const path = "/src/lib/agent-memory-api.ts"
        return (await import(path)).agentMemoryFor("b~same").list("project", { workspaceId: "a~same" }).then(() => false, () => true)
      }), true)
      assert.equal(f.requests.length, beforeWrongOwner)
      await page.evaluate(async request => {
        const path = "/src/lib/native/preferences-window.ts"
        await (await import(path)).openNativePreferences(request)
      }, request)
      assert.deepEqual(await page.evaluate(() => (window as any).opened), request)
      assert.equal(f.requests.some(value => value.path.includes("~")), false, "qualified keys stay outside HTTP paths")
      assert.equal(f.requests.some(value => /\/(?:session|worktrees)(?:\/|$)/.test(value.path)), false, "admission must not hydrate instances")
      assert.deepEqual(f.errors, [])
    } catch (error) { console.error({ errors: f.errors, requests: f.requests, body: (await page.locator("body").innerText()).slice(0, 2500) }); throw error }
    finally { await page.close() }
  })

  test(`${kind}: restart rebind is backend-qualified; unavailable and replacement never fall back locally`, async () => {
    const page = await browser.newPage(), f = await api(page, () => "a")
    page.setDefaultTimeout(30_000)
    f.restore()
    await host(page, kind, project("a", "providers"))
    try {
      await page.goto(url)
      await page.waitForFunction(() => (window as any).request.instanceId === "a~restarted")
      const accepted = await page.evaluate(() => (window as any).request)
      assert.equal(accepted.serverId, "server-a")
      assert.equal(accepted.location.workspaceID, undefined)
      assert.ok(f.requests.some(value => value.owner === "a" && value.path === "/api/workspaces"))
      assert.equal(f.requests.some(value => value.owner === "local" && value.path === "/api/workspaces"), false)
      assert.equal(f.requests.some(value => /\/(?:session|worktrees)(?:\/|$)/.test(value.path)), false)
      f.unavailable()
      await page.reload()
      await page.waitForFunction(() => (window as any).ready)
      assert.equal(await page.locator("#agent-memory button").count(), 0)
      assert.deepEqual(f.errors, [])
    } catch (error) { console.error({ errors: f.errors, requests: f.requests, body: (await page.locator("body").innerText()).slice(0, 2500) }); throw error }
    finally { await page.close() }
    const replacement = await browser.newPage(), r = await api(replacement, () => "a")
    r.replace()
    await host(replacement, kind, project("a"))
    try {
      await replacement.goto(url)
      await replacement.waitForResponse(response => new URL(response.url()).pathname === "/api/backends/a/api/meta")
      await replacement.waitForFunction(() => (window as any).ready)
      assert.equal(await replacement.locator("#agent-memory button").count(), 0)
      assert.equal(r.requests.some(value => value.owner === "a" && value.path === "/api/workspaces"), false)
      assert.deepEqual(r.errors, [])
    } finally { await replacement.close() }
  })
}
