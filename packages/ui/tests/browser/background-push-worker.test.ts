import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import http from "node:http"
import { test } from "node:test"
import { chromium } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

test("real worker displays generic push, rejects expired/foreign routes and requests UI focus", async () => {
  const script = await readFile(new URL("../../src/renderer/public/push-v1.js", import.meta.url), "utf8")
  const login = await readFile(new URL("../../../server/src/server/routes/auth-pages/login.html", import.meta.url), "utf8")
  const server = http.createServer((req, res) => {
    if (req.url === "/sw.js") {
      res.setHeader("Content-Type", "text/javascript")
      res.end(`
const original = ServiceWorkerRegistration.prototype.showNotification;
self.addEventListener("push", event => event.waitUntil((async () => {
  for (const client of await self.clients.matchAll({includeUncontrolled:true}))
    client.postMessage({type:"fixture-data", raw:event.data?.text()});
})()));
ServiceWorkerRegistration.prototype.showNotification = async function(...args) {
  self.attempted = args;
  try { await original.apply(this, args); } catch(error) {
    for (const client of await self.clients.matchAll({includeUncontrolled:true})) client.postMessage({type:"fixture-error", error:String(error)});
    throw error;
  }
  self.observed = (await this.getNotifications())[0];
  self.shown = args;
  for (const client of await self.clients.matchAll({includeUncontrolled:true})) client.postMessage({type:"fixture-shown", title:args[0], options:args[1]});
};
${script}`)
    } else if (req.url === "/login") {
      res.setHeader("Content-Type", "text/html")
      res.end(login)
    } else {
      res.setHeader("Content-Type", "text/html")
      res.end("<!doctype html><title>Push fixture</title>")
    }
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`
  const browser = await chromium.launch({ headless: true, channel: "chromium" })
  armFixtureNavigationBudget(browser)
  try {
    const context = await browser.newContext({ permissions: ["notifications"] })
    const page = await context.newPage()
    await page.goto(origin)
    const cdp = await context.newCDPSession(page)
    let registrationId = ""
    cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
      registrationId = registrations.find((r: any) => r.scopeURL === `${origin}/`)?.registrationId ?? registrationId
    })
    await cdp.send("ServiceWorker.enable")
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js", { scope: "/" })
      await navigator.serviceWorker.ready
      ;(window as any).pushRoutes = []
      navigator.serviceWorker.addEventListener("message", e => {
        if (e.data.type === "codenomad-push-route") (window as any).pushRoutes.push(e.data)
        if (e.data.type === "fixture-shown") (window as any).shown = e.data
        if (e.data.type === "fixture-data") (window as any).raw = e.data.raw
        if (e.data.type === "fixture-error") (window as any).pushError = e.data.error
      })
    })
    assert(registrationId)
    const worker = context.serviceWorkers()[0]
    const payload = { v: 1, title: "CodeNomad", body: "A conversation needs your answer.",
      notificationId: "notice-1", route: "a".repeat(32), expiresAt: Date.now() + 300000 }
    const deliver = (value: unknown) => cdp.send("ServiceWorker.deliverPushMessage", {
      origin, registrationId, data: JSON.stringify(value),
    })
    await deliver(payload)
    await page.waitForFunction(() => typeof (window as any).raw === "string")
    assert.equal(await page.evaluate(() => (window as any).raw), JSON.stringify(payload))
    // Windows may dismiss immediately; successful native showNotification is the publication receipt.
    await page.waitForFunction(() => Boolean((window as any).shown || (window as any).pushError))
    assert.equal(await page.evaluate(() => (window as any).pushError), undefined)
    assert.deepEqual(await page.evaluate(() => {
      const n = (window as any).shown
      return { title: n.title, body: n.options.body, tag: n.options.tag }
    }), { title: "CodeNomad", body: payload.body, tag: payload.notificationId })
    // Chromium reserves focus/open permission for trusted OS clicks. The synthetic
    // event records that native boundary while retaining real WindowClient messaging.
    await worker.evaluate(`(async () => {
      const sw = self
      const client = (await sw.clients.matchAll({type:"window", includeUncontrolled:true}))[0]
      Object.getPrototypeOf(client).focus = async function() { sw.focused = this.id; return this }
      const notification = sw.observed ?? { data: sw.shown[1].data, close() {} }
      const event = new Event("notificationclick")
      let completion = Promise.resolve()
      Object.defineProperties(event, { notification: { value: notification },
        waitUntil: { value: (work) => { completion = work } } })
      sw.dispatchEvent(event)
      await completion
    })()`)
    await page.waitForFunction(() => (window as any).pushRoutes.length === 1)
    assert.deepEqual(await page.evaluate(() => (window as any).pushRoutes[0]), { v: 1, type: "codenomad-push-route", route: payload.route })
    assert.equal(typeof await worker.evaluate("self.focused"), "string")
    for (const invalid of [
      { ...payload, v: 2 }, { ...payload, expiresAt: Date.now() - 1 },
      { ...payload, route: "https://foreign.test/private" }, { ...payload, route: "/api/private" },
    ]) await deliver(invalid)
    assert.equal(await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length), 0)
    await page.goto(`${origin}/login#push=${payload.route}`)
    await page.locator("#username").fill("user")
    await page.locator("#password").fill("fixture-password")
    await page.locator("#submit").click()
    await page.waitForURL(`${origin}/#push=${payload.route}`)
    await context.close()
  } finally {
    await browser.close()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
