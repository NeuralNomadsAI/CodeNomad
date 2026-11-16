import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { startProductFixture } from "./fixtures/product-fixture-server"
import { fixtureEventStream } from "./fixture-event-stream"

let fixture: Awaited<ReturnType<typeof startProductFixture>>, events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => { fixture = await startProductFixture("background-push"); events = await fixtureEventStream(fixture.url) })
after(async () => { try { await fixture?.close() } finally { await events?.close() } })

for (const mode of ["open tab", "new page", "late inventory"]) test(`opaque click waits for restore/authentication and selects the existing project (${mode})`, async () => {
  const page = await fixture.browser.newPage()
  let authenticated = false, resolves = 0, mutations = 0
  try {
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname
      if (path === "/api/auth/login") { authenticated = true; await route.fulfill({ json: { ok: true } }); return }
      if (path === "/api/auth/status") { await route.fulfill({ json: { authenticated } }); return }
      if (path.startsWith("/api/push/routes/")) {
        resolves++
        await route.fulfill({ status: authenticated ? 200 : 401, json: authenticated ? { instanceId: "project", sessionId: "session" } : {} })
        return
      }
      if (route.request().method() !== "GET") mutations++
      await route.fulfill({ json: path === "/api/push/status" ? { enabled: false, subscribed: false } : {} })
    })
    await events.route(page)
    await page.goto(`${fixture.url}?navigation${mode !== "open tab" ? "&closed" : ""}${mode === "late inventory" ? "&late" : ""}#push=${"a".repeat(32)}`)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    assert.equal(resolves, 0)
    const denied = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/status")
    await page.evaluate(() => (window as any).fixture.release())
    await page.waitForFunction(() => !location.hash)
    await denied
    await page.waitForFunction(() => (window as any).fixture.authRequired())
    assert.equal(await page.evaluate(() => (window as any).fixture.selected().session), undefined)
    const resolved = mode === "late inventory" ? page.waitForResponse(response =>
      new URL(response.url()).pathname.startsWith("/api/push/routes/") && response.status() === 200) : undefined
    await page.evaluate(() => (window as any).fixture.signIn())
    if (mode === "late inventory") {
      await resolved
      assert.equal(await page.evaluate(() => (window as any).fixture.selected().session), undefined)
      await page.evaluate(() => (window as any).fixture.seedProjects())
    }
    await page.waitForFunction(() => (window as any).fixture.selected().session === "session")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.selected()), { tab: "instance:project", session: "session" })
    assert.equal(mutations, 0, "navigation never creates/retries a workspace")
  } finally { await page.close() }
})
