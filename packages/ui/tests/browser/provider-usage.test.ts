import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page, type Route } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "provider-usage-fixture", configureServer(vite) {
      vite.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await vite.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/provider-usage.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function prepare(page: Page) {
  const requests: Route[] = []
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  // Do not open any shared server/SSE connection. Events below use the real dispatcher.
  await page.addInitScript(() => {
    ;(window as any).EventSource = class {
      static OPEN = 1; readyState = 1
      addEventListener() {} removeEventListener() {} close() {}
    }
  })
  await page.route("**/api/**", route => {
    if (new URL(route.request().url()).pathname.startsWith("/api/usage/")) { requests.push(route); return }
    return route.fulfill({ contentType: "application/json", body: "{}" })
  })
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).usageFixture))
  return { requests, errors }
}
const fulfill = (route: Route, usedPercent: number) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
  requestedProviderId: "openai", providerId: "codex", providerName: "Codex", supported: true, configured: true, ok: true, fetchedAt: Date.now(),
  windows: { "5h": { usedPercent, remainingPercent: 100 - usedPercent, windowSeconds: 18000, resetAt: null } },
}) })
async function waitRequests(requests: Route[], count: number) {
  const deadline = Date.now() + 5000
  while (requests.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(requests.length, count)
}

test("rendered quota requests carry instance/session identity and stale sessions cannot publish or warm remounts", async () => {
  const page = await browser.newPage()
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1)
    const first = new URL(requests[0].request().url())
    assert.equal(first.searchParams.get("instanceId"), "first")
    assert.equal(first.searchParams.get("sessionId"), "session-a")
    assert.equal(first.searchParams.get("modelId"), "gpt-5")
    await page.evaluate(() => (window as any).usageFixture.select({ instanceId: "second", sessionId: "session-b", directory: "/worktree" }))
    await waitRequests(requests, 2)
    const second = new URL(requests[1].request().url())
    assert.equal(second.searchParams.get("instanceId"), "second")
    assert.equal(second.searchParams.get("sessionId"), "session-b")
    await fulfill(requests[1], 20)
    await page.getByRole("progressbar").waitFor()
    await fulfill(requests[0], 10)
    await page.waitForTimeout(50)
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "20")
    await page.evaluate(() => (window as any).usageFixture.mounted(false))
    await page.locator("[data-usage]").waitFor({ state: "detached" })
    await page.evaluate(() => (window as any).usageFixture.mounted(true))
    await waitRequests(requests, 3)
    assert.equal(await page.getByRole("progressbar").count(), 0, "no global warm snapshot before native account validation")
    await fulfill(requests[2], 30)
    await page.getByRole("progressbar").waitFor()
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "30")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("native account events and reconnect clear old quotas; hidden panels do not fetch", async () => {
  const page = await browser.newPage()
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1); await fulfill(requests[0], 10)
    await page.getByRole("progressbar").waitFor()
    await page.evaluate(() => (window as any).usageFixture.event("credential.switched", "another-instance"))
    assert.equal(requests.length, 1)
    await page.evaluate(() => (window as any).usageFixture.event("credential.switched"))
    await waitRequests(requests, 2)
    assert.equal(await page.getByRole("progressbar").count(), 0)
    await page.evaluate(() => (window as any).usageFixture.connection("disconnected"))
    await fulfill(requests[1], 20)
    assert.equal(await page.getByRole("progressbar").count(), 0)
    await page.evaluate(() => (window as any).usageFixture.connection("connected"))
    await waitRequests(requests, 3); await fulfill(requests[2], 30)
    await page.getByRole("progressbar").waitFor()
    await page.evaluate(() => (window as any).usageFixture.active(false))
    await page.evaluate(() => (window as any).usageFixture.event("integration.updated"))
    await page.waitForTimeout(50)
    assert.equal(requests.length, 3)
    await page.evaluate(() => (window as any).usageFixture.active(true))
    await waitRequests(requests, 4); await fulfill(requests[3], 40)
    await page.getByRole("progressbar").waitFor()
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "40")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("missing credential API explains the running service requirement without generic authentication advice", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1)
    await requests[0].fulfill({ contentType: "application/json", body: JSON.stringify({
      requestedProviderId: "openai", providerId: "codex", providerName: "Codex", supported: true,
      configured: true, ok: false, fetchedAt: Date.now(), windows: {}, unavailableReason: "native-credential-api-unavailable",
    }) })
    await page.getByText("Usage requires OpenCode 2.0.20 or newer. Update OpenCode, then restart its service from Settings.", { exact: true }).waitFor()
    assert.equal(await page.getByRole("progressbar").count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("repeated connected notifications preserve quota DOM and in-flight refreshes without compaction or input coupling", async () => {
  const page = await browser.newPage()
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1)
    // Establish both connection identities before publishing their validated quota.
    await page.evaluate(() => (window as any).usageFixture.connection("connected"))
    await waitRequests(requests, 2)
    await page.evaluate(() => (window as any).usageFixture.transport("connected"))
    await waitRequests(requests, 3)
    await fulfill(requests[0], 80); await fulfill(requests[1], 90); await fulfill(requests[2], 10)
    const bar = page.getByRole("progressbar")
    await bar.waitFor()
    const original = await bar.elementHandle()
    await page.evaluate(() => {
      const fixture = (window as any).usageFixture
      for (let i = 0; i < 20; i++) {
        fixture.connection("connected")
        fixture.transport("connected")
      }
      fixture.event("session.compaction.started")
      fixture.event("session.compaction.ended")
    })
    await page.waitForTimeout(50)
    assert.equal(requests.length, 3, "duplicate connectivity and compaction alone do not demand quotas")
    assert.equal(await original!.evaluate(el => el.isConnected), true)
    assert.equal(await bar.getAttribute("aria-valuenow"), "10")

    await page.evaluate(() => (window as any).usageFixture.event("provider.updated"))
    await waitRequests(requests, 4)
    await page.evaluate(() => {
      const fixture = (window as any).usageFixture
      for (let i = 0; i < 20; i++) {
        fixture.connection("connected")
        fixture.transport("connected")
      }
    })
    assert.equal(await original!.evaluate(el => el.isConnected), true, "a pending refresh cannot reset the display")
    if (process.env.CODENOMAD_USAGE_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_USAGE_CAPTURE })
    await fulfill(requests[3], 20)
    await page.waitForFunction(() => document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow") === "20")
    await page.waitForTimeout(50)
    assert.equal(requests.length, 4, "duplicate connectivity neither cancels nor schedules trailing reads")
    assert.equal(await original!.evaluate(el => el.isConnected), true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const boundary of ["native-generation", "native-disconnect", "transport-disconnect", "server-connected"] as const) {
  test(`real ${boundary} boundary still revokes quotas and fences old responses`, async () => {
    const page = await browser.newPage()
    try {
      const { requests, errors } = await prepare(page)
      await waitRequests(requests, 1)
      await page.evaluate(() => (window as any).usageFixture.connection("connected"))
      await waitRequests(requests, 2)
      await page.evaluate(() => (window as any).usageFixture.transport("connected"))
      await waitRequests(requests, 3)
      await fulfill(requests[0], 80); await fulfill(requests[1], 90); await fulfill(requests[2], 10)
      await page.getByRole("progressbar").waitFor()
      await page.evaluate(() => {
        for (let i = 0; i < 5; i++) (window as any).usageFixture.event("provider.updated")
      })
      await waitRequests(requests, 4)
      await page.evaluate(boundary => {
        const fixture = (window as any).usageFixture
        if (boundary === "native-generation") fixture.connection("connected", 2)
        else if (boundary === "native-disconnect") fixture.connection("disconnected")
        else if (boundary === "transport-disconnect") fixture.transport("disconnected")
        else fixture.event("server.connected")
      }, boundary)
      assert.equal(await page.getByRole("progressbar").count(), 0)
      await fulfill(requests[3], 95)
      await page.waitForTimeout(50)
      assert.equal(await page.getByRole("progressbar").count(), 0, "old reads cannot restore disconnected quotas")
      if (boundary === "native-disconnect" || boundary === "transport-disconnect") {
        assert.equal(requests.length, 4, "obsolete trailing demand is fenced on disconnect")
        await page.evaluate(boundary => {
          if (boundary === "native-disconnect") (window as any).usageFixture.connection("connected")
          else (window as any).usageFixture.transport("connected")
        }, boundary)
      }
      await waitRequests(requests, 5)
      await fulfill(requests[4], 30)
      await page.getByRole("progressbar").waitFor()
      assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "30")
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

test("provider catalogue bursts refresh in place, coalesce reads and ignore other native locations", async () => {
  const page = await browser.newPage({ viewport: { width: 360, height: 400 }, locale: "en-US" })
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1); await fulfill(requests[0], 10)
    const bar = page.getByRole("progressbar")
    await bar.waitFor()
    const original = await bar.elementHandle()
    await page.evaluate(() => (window as any).usageFixture.event("provider.updated", "first", "/another-location"))
    await page.waitForTimeout(50)
    assert.equal(requests.length, 1, "another location's catalogue is not this quota's authority")
    await page.evaluate(() => {
      for (let i = 0; i < 20; i++) (window as any).usageFixture.event("provider.updated")
    })
    await waitRequests(requests, 2)
    assert.equal(await original!.evaluate(el => el.isConnected), true, "passive events must not replace quota with Loading")
    if (process.env.CODENOMAD_USAGE_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_USAGE_CAPTURE })
    await fulfill(requests[1], 20)
    await waitRequests(requests, 3)
    assert.equal(await bar.getAttribute("aria-valuenow"), "20")
    assert.equal(await original!.evaluate(el => el.isConnected), true, "quota updates keep the same bar DOM")
    await fulfill(requests[2], 30)
    await page.waitForFunction(() => document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow") === "30")
    assert.equal(await original!.evaluate(el => el.isConnected), true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("an account boundary during passive refresh clears quota and fences old and trailing results", async () => {
  const page = await browser.newPage()
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1); await fulfill(requests[0], 10)
    await page.getByRole("progressbar").waitFor()
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++) (window as any).usageFixture.event("provider.updated")
    })
    await waitRequests(requests, 2)
    await page.evaluate(() => (window as any).usageFixture.event("credential.switched"))
    await waitRequests(requests, 3)
    assert.equal(await page.getByRole("progressbar").count(), 0)
    await fulfill(requests[1], 90)
    await page.waitForTimeout(50)
    assert.equal(requests.length, 3, "obsolete passive demand must not restart an old account read")
    assert.equal(await page.getByRole("progressbar").count(), 0)
    await fulfill(requests[2], 40)
    await page.getByRole("progressbar").waitFor()
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "40")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("stable window labels handle removed quotas and passive read failure without retaining old data", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1); await fulfill(requests[0], 10)
    await page.getByRole("progressbar").waitFor()
    await page.evaluate(() => (window as any).usageFixture.event("provider.updated"))
    await waitRequests(requests, 2)
    await requests[1].fulfill({ contentType: "application/json", body: JSON.stringify({
      requestedProviderId: "openai", providerId: "codex", providerName: "Codex", supported: true, configured: true,
      ok: true, fetchedAt: Date.now(), windows: { weekly: { usedPercent: 30, remainingPercent: 70, resetAt: null, windowSeconds: 604800 } },
    }) })
    await page.waitForFunction(() => document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow") === "30", undefined, { timeout: 5000 })
      .catch(async error => { console.error("Window replacement failure", errors, await page.locator("body").innerText()); throw error })
    assert.equal(await page.getByRole("progressbar").count(), 1)
    await page.evaluate(() => (window as any).usageFixture.event("provider.updated"))
    await waitRequests(requests, 3)
    await requests[2].fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) })
    await page.getByText("Usage is temporarily unavailable.", { exact: true }).waitFor({ timeout: 5000 })
      .catch(async error => { console.error("Failure display", errors, await page.locator("body").innerText(), requests.length); throw error })
    assert.equal(await page.getByRole("progressbar").count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("Claude Code sessions label model-scoped limits beside the plan windows", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1)
    await page.evaluate(() => (window as any).usageFixture.select({ providerId: "claude-code", modelId: "claude-opus-5-5" }))
    await waitRequests(requests, 2)
    assert.equal(new URL(requests[1].request().url()).pathname, "/api/usage/claude-code")
    const quota = (usedPercent: number, windowSeconds: number) => ({ usedPercent, remainingPercent: 100 - usedPercent, windowSeconds, resetAt: null })
    await requests[1].fulfill({ contentType: "application/json", body: JSON.stringify({
      requestedProviderId: "claude-code", providerId: "claude-code", providerName: "Claude", supported: true, configured: true, ok: true,
      fetchedAt: Date.now(), windows: { "5h": quota(4, 18000), "7d": quota(1, 604800), "7d:Opus": quota(60, 604800) },
    }) })
    await page.getByText("7 days · Opus", { exact: true }).waitFor({ timeout: 5000 })
    assert.equal(await page.getByRole("progressbar").count(), 3)
    for (const label of ["5 hours", "7 days"]) assert.equal(await page.getByText(label, { exact: true }).count(), 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})