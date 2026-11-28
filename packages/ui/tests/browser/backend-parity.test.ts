import assert from "node:assert/strict"
import { test } from "node:test"
import { chromium, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

async function fixturePage(run: (page: Page) => Promise<void>, manageServers = false) {
  const fixture = await borrowFixture({ name: "backend-parity", routes: [{ path: "/fixture", html:
    '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/backend-parity.tsx"></script></body></html>' }] })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  const page = await browser.newPage(), errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: 'window.__name = value => value; window.EventSource = class extends EventTarget { close() {} }' })
  await page.addInitScript(() => {
    const w = window as any
    w.systemNotifications = []
    w.Notification = class extends EventTarget {
      static permission = "granted"
      static requestPermission = async () => "granted"
      title: string
      options: any
      private handler: EventListener | null = null
      constructor(title: string, options: any) {
        super(); this.title = title; this.options = options; w.systemNotifications.push(this)
      }
      set onclick(handler: EventListener | null) {
        if (this.handler) this.removeEventListener("click", this.handler)
        this.handler = handler
        if (handler) this.addEventListener("click", handler)
      }
      get onclick() { return this.handler }
      close() {}
    }
  })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  if (manageServers) await page.route("**/api/meta", route => route.fulfill({ json: {
    localRequest: false, serversUsable: true, serversManageable: true, secretEntryAllowed: false,
  } }))
  try {
    await page.goto(fixture.url)
    await page.waitForFunction(() => Boolean((window as any).parity) && document.querySelectorAll(".image-settings select:not(:disabled)").length === 3
      && document.querySelectorAll(".websearch-settings-defaults select:not(:disabled)").length === 6)
    await run(page)
    assert.deepEqual(await page.evaluate(() => (window as any).parity.violations), [])
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
}

test("real Images and Web search consumers route A/B/local reads and mutations exclusively to their owner", async () => fixturePage(async page => {
  for (const owner of ["A", "B", "local"]) {
    const section = page.locator(`[data-owner="${owner}"]`)
    await section.locator(".image-settings select").selectOption("off")
    await page.waitForFunction(owner => (window as any).parity.calls.some((call: any) => call.owner === owner && call.body?.generation === false), owner)
    await page.waitForFunction(owner => !document.querySelector(`[data-owner="${owner}"] .image-settings select:disabled`), owner)
    await section.locator(".image-settings").getByRole("checkbox").click()
    await section.locator(".websearch-settings-defaults select").first().selectOption("off")
    await page.waitForFunction(owner => !document.querySelector(`[data-owner="${owner}"] .websearch-settings-defaults select:disabled`), owner)
    await section.locator(".websearch-settings-defaults select").last().selectOption("provider:search")
    await section.getByRole("button", { name: `New Images ${owner}`, exact: true }).click()
  }
  await page.waitForFunction(() => (window as any).parity.calls.filter((call: any) => call.path.endsWith("images-conversation")).length === 3)
  const calls = await page.evaluate(() => (window as any).parity.calls)
  for (const owner of ["A", "B", "local"]) {
    for (const suffix of ["image-settings", "websearch-settings", "images-conversation"]) {
      assert.ok(calls.some((call: any) => call.owner === owner && call.path === `/api/workspaces/same/${suffix}`))
    }
    const writes = calls.filter((call: any) => call.owner === owner && call.method !== "GET")
    assert.equal(writes.length, 5)
    assert.ok(writes.every((call: any) => (call.body.directory ?? call.body.location.directory) === `/${owner}`))
    assert.ok(writes.some((call: any) => call.body.mediaStorage === true))
    assert.ok(writes.some((call: any) => call.body.scope === "global" && call.body.provider === false))
    assert.ok(writes.some((call: any) => call.body.scope === "project" && call.body.provider === "search"))
  }
}))

test("failed remote writes stay remote; detach fences held completions and clears settings until reattachment", async () => fixturePage(async page => {
  const a = page.locator('[data-owner="A"]')
  await page.evaluate(() => (window as any).parity.fail())
  await a.locator(".image-settings select").selectOption("off")
  await a.locator(".image-settings [role=alert]").waitFor()
  const localBefore = await page.evaluate(() => (window as any).parity.calls.filter((call: any) => call.owner === "local").length)
  await page.evaluate(() => (window as any).parity.hold())
  await a.locator(".websearch-settings-defaults select").first().selectOption("off")
  await a.getByRole("button", { name: "New Images A", exact: true }).click()
  await page.waitForFunction(() => (window as any).parity.pending >= 2)
  await page.evaluate(() => (window as any).parity.detach())
  await page.waitForFunction(() => !document.querySelector('[data-owner="A"] .image-settings select')
    && !document.querySelector('[data-owner="A"] .websearch-settings-defaults select'))
  const dispatched = await page.evaluate(() => (window as any).parity.calls.length)
  await a.getByRole("button", { name: "New Images A", exact: true }).click()
  assert.equal(await page.evaluate(() => (window as any).parity.calls.length), dispatched, "detached action dispatches nothing")
  await page.evaluate(() => (window as any).parity.release())
  await page.waitForFunction(() => (window as any).parity.outcomes.some((result: any) => result.owner === "A" && result.status === "unknown"))
  await page.evaluate(() => (window as any).parity.reattach())
  await a.locator(".image-settings select").waitFor()
  assert.equal(await page.evaluate(() => (window as any).parity.calls.filter((call: any) => call.owner === "local").length), localBefore)
}))

test("homonymous sessions on two servers have independent notices, exact navigation and revoked actions", async () => fixturePage(async page => {
  await page.evaluate(() => { (window as any).parity.notify("A"); (window as any).parity.notify("B"); (window as any).parity.notify("A") })
  await page.waitForFunction(() => (window as any).parity.history().length === 2)
  assert.equal(await page.getByText('Session "Same session" was compacted', { exact: true }).count(), 2, "B never replaces A's bubble")
  let history = await page.evaluate(() => (window as any).parity.history())
  assert.deepEqual(history.map((item: any) => item.title).sort(), ["Server A · A", "Server B · B"])
  for (const owner of ["A", "B"]) {
    await page.evaluate(title => (window as any).parity.action(title), `Server ${owner} · ${owner}`)
    const selected = await page.evaluate(() => (window as any).parity.selected())
    assert.equal(selected.instance, `${owner}~same`)
    assert.equal(selected[`session${owner}`], "ses_homonym")
  }
  await page.evaluate(() => (window as any).parity.action("Server A · A"))
  await page.evaluate(() => (window as any).parity.detach())
  history = await page.evaluate(() => (window as any).parity.history())
  assert.equal(history.length, 1)
  assert.equal(history[0].title, "Server B · B")
  await page.waitForFunction(() => [...document.querySelectorAll("p")].filter(el => el.textContent === 'Session "Same session" was compacted').length === 1)
  await page.evaluate(() => (window as any).parity.action("Server B · B"))
  await page.evaluate(() => { (window as any).parity.reattach(); return (window as any).parity.staleAction() })
  assert.equal((await page.evaluate(() => (window as any).parity.selected())).instance, "B~same")
  await page.evaluate(() => (window as any).parity.notify("A", "session.execution.succeeded", 2))
  await page.waitForFunction(() => (window as any).parity.history().length === 2)
  history = await page.evaluate(() => (window as any).parity.history())
  const done = history.find((item: any) => item.message.includes("finished"))
  assert.equal(done.title, "Server A · A")
  assert.equal((await page.evaluate(() => (window as any).parity.selected())).instance, "B~same")
  await page.evaluate(() => (window as any).parity.clearSelection("A"))
  const finishedNotice = page.getByText(done.message, { exact: true }).locator("..")
  await finishedNotice.getByRole("button").click()
  await page.waitForFunction(() => (window as any).parity.selected().sessionA === "ses_homonym")
  const selected = await page.evaluate(() => (window as any).parity.selected())
  assert.equal(selected.instance, "A~same")
  assert.equal(selected.sessionA, "ses_homonym")
}))

test("web system notification clicks navigate to the qualified session and revoked attachment clicks stay fenced", async () => fixturePage(async page => {
  await page.evaluate(async () => {
    await (window as any).parity.systemRouting()
    ;(window as any).parity.notify("A")
    ;(window as any).parity.notify("B")
  })
  await page.waitForFunction(() => (window as any).systemNotifications.length === 2)
  assert.deepEqual(await page.evaluate(() => (window as any).parity.history()), [], "System-only routing creates no history action")
  for (const owner of ["A", "B"]) {
    await page.evaluate(owner => {
      ;(window as any).parity.openMissionReader(`${owner}~same`)
      const notice = (window as any).systemNotifications.find((item: any) => item.title === `Server ${owner} · ${owner}`)
      notice.dispatchEvent(new Event("click"))
    }, owner)
    await page.waitForFunction(owner => (window as any).parity.selected().instance === `${owner}~same`, owner)
    const selected = await page.evaluate(() => (window as any).parity.selected())
    assert.equal(selected[`session${owner}`], "ses_homonym")
    assert.equal(await page.evaluate(owner => (window as any).parity.surface(`${owner}~same`), owner), "conversation", "The click shows the conversation over a Mission reader")
  }
  await page.evaluate(() => {
    ;(window as any).parity.detach()
    ;(window as any).parity.reattach()
    const stale = (window as any).systemNotifications.find((item: any) => item.title === "Server A · A")
    stale.dispatchEvent(new Event("click"))
  })
  // Drain asynchronous action imports before asserting the retained click cannot change selection.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  assert.equal((await page.evaluate(() => (window as any).parity.selected())).instance, "B~same")
}))

for (const host of ["electron", "tauri"] as const) {
  test(`${host} system clicks select the exact local and qualified remote sessions`, async () => fixturePage(async page => {
    await page.evaluate(async host => {
      const w = window as any
      await w.parity.systemRouting()
      w.__CODENOMAD_RUNTIME_HOST__ = host
      const notices: Array<{ title: string; actionId: string }> = w.systemNotifications
      const show = async (notice: typeof notices[number]) => { notices.push(notice); return { ok: true } }
      if (host === "electron") {
        w.electronAPI = { showNotification: show, onNotificationClick: (callback: typeof w.clickNative) => { w.clickNative = callback } }
      } else {
        w.__CODENOMAD_NOTIFICATION_ACTIONS__ = true
        w.__TAURI_INTERNALS__ = { invoke: (command: string, args: typeof notices[number]) =>
          command === "notification_show" ? show(args) : undefined }
        w.clickNative = (id: string) => dispatchEvent(new CustomEvent("codenomad:notification-click", { detail: id }))
      }
      w.parity.notify("local")
      w.parity.notify("A")
      w.parity.notify("B")
    }, host)
    await page.waitForFunction(() => (window as any).systemNotifications.length === 3)
    for (const [title, key, session] of [["local", "same", "sessionLocal"], ["Server B · B", "B~same", "sessionB"]]) {
      await page.evaluate(title => {
        const w = window as any
        w.clickNative(w.systemNotifications.find((notice: any) => notice.title === title).actionId)
      }, title)
      await page.waitForFunction(({ key, session }) => {
        const selected = (window as any).parity.selected()
        return selected.instance === key && selected[session] === "ses_homonym"
      }, { key, session })
    }
    const selected = await page.evaluate(async () => {
      const w = window as any
      w.parity.detach()
      w.parity.reattach()
      w.clickNative(w.systemNotifications.find((notice: any) => notice.title === "Server A · A").actionId)
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      return w.parity.selected().instance
    })
    assert.equal(selected, "B~same")
  }))
}

test("embedded Settings Missions reads the selected qualified project's worktree Location", async () => fixturePage(async page => {
  for (const owner of ["A", "B"]) {
    const before = await page.evaluate(() => (window as any).parity.calls.length)
    await page.evaluate(owner => (window as any).parity.openMissions(owner), owner)
    await page.waitForFunction(({ owner, before }) => (window as any).parity.calls.slice(before)
      .some((call: any) => call.owner === owner && call.path === "/api/workspaces/same/subagent-depth"), { owner, before })
    const reads = await page.evaluate(before => (window as any).parity.calls.slice(before)
      .filter((call: any) => call.path.endsWith("/subagent-depth")), before)
    assert.ok(reads.length > 0)
    assert.ok(reads.every((call: any) => call.owner === owner && call.directory === `/${owner}/worktree`),
      `Missions must use ${owner}'s selected Location, never its root folder or another backend: ${JSON.stringify(reads)}`)
  }
}))

test("web clients manage and select saved servers through embedded Settings without a native bridge", async () => fixturePage(async page => {
  await page.evaluate(() => (window as any).parity.openServers())
  await page.waitForFunction(() => [
    'input[aria-label="Server address or link"]',
    'button[aria-label="Add SSH server"]',
    'button[aria-label="Edit server: Server A"]',
  ].every(selector => document.querySelector(`.settings-screen-shell ${selector}`)?.checkVisibility()))
  const open = await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.settings-screen-shell button[aria-label="Open: Server A"]'))
  await open.asElement()!.click()
  await page.waitForFunction(() => (window as any).parity.serverSelection()?.id === "A")
  const id = await page.evaluate(async () => {
    Object.defineProperty(crypto, "randomUUID", { value: undefined })
    return (await (window as any).parity.addServer()).id
  })
  assert.match(id, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i)
  assert.equal(await page.evaluate(() => Boolean(window.electronAPI || (window as any).__TAURI_INTERNALS__)), false)
}, true))
