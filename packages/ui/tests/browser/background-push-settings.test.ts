import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { startProductFixture } from "./fixtures/product-fixture-server"
import { fixtureEventStream } from "./fixture-event-stream"

let fixture: Awaited<ReturnType<typeof startProductFixture>>, events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => { fixture = await startProductFixture("background-push"); events = await fixtureEventStream(fixture.url) })
after(async () => { try { await fixture?.close() } finally { await events?.close() } })

async function setup(state = "off", host = "web") {
  const page = await fixture.browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const writes: any[] = []
  const requests: string[] = []
  await page.addInitScript({ content: `(() => {
    const state = ${JSON.stringify(state)}, host = ${JSON.stringify(host)}
    const w = window
    w.__CODENOMAD_RUNTIME_HOST__ = host
    w.permissionRequests = 0; w.osNotifications = 0
    let subscribed = state === "on"
    w.Notification = class {
      static permission = state === "denied" ? "denied" : "granted"
      static async requestPermission() { w.permissionRequests++; return this.permission }
      constructor() { w.osNotifications++ }
    }
    if (state === "https") Object.defineProperty(window, "isSecureContext", { value: false })
    if (state === "ios") {
      Object.defineProperty(navigator, "userAgent", { value: "iPhone" })
    }
    if (state === "unsupported") w.PushManager = undefined
    else w.PushManager = class {}
    const subscription = { endpoint: "https://push.example.test/local", toJSON: () => ({
      endpoint: "https://push.example.test/local", keys: { p256dh: "test", auth: "test" },
    }), unsubscribe: async () => { subscribed = false; return true } }
    Object.defineProperty(navigator, "serviceWorker", { value: {
      getRegistration: async () => ({ scope: location.origin + "/", active: { scriptURL: location.origin + "/sw.js", postMessage() {} },
        pushManager: { getSubscription: async () => subscribed ? subscription : null,
          subscribe: async () => { subscribed = true; return subscription } } }),
    } })
  })()` })
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname
    requests.push(path)
    if (path.startsWith("/api/push/")) {
      if (route.request().method() !== "GET") writes.push(route.request().postDataJSON())
      await route.fulfill({ json: path.endsWith("subscription") ? { publicKey: "BAAAAA" } : {
        enabled: state !== "disabled" && state !== "storage", unavailable: state === "storage", subscribed: state === "on",
      } })
    } else await route.fulfill({ json: {} })
  })
  await events.route(page)
  await page.goto(fixture.url)
  try { await page.waitForFunction(() => Boolean((window as any).fixture)) }
  catch (error) { await page.close(); throw new Error(`Fixture bootstrap: ${JSON.stringify(errors)}`, { cause: error }) }
  return { page, writes, requests, control: page.getByRole("switch", { name: "In the background on this device" }) }
}

test("off by default; explicit activation alone requests permission and registers current scope", async () => {
  const { page, writes, requests, control } = await setup()
  try {
    await control.waitFor()
    await page.evaluate(() => (window as any).fixture.refreshBackgroundPush())
    assert.equal(await page.evaluate(() => (window as any).fixture.state()), "ready",
      JSON.stringify({ requests, value: await page.evaluate(() => ({ state: (window as any).fixture.state(), environment: (window as any).fixture.environment() })) }))
    assert.equal(await control.isChecked(), false)
    assert.equal(await page.evaluate(() => (window as any).permissionRequests), 0)
    await control.click()
    await page.waitForFunction(() => (document.querySelector('[role="switch"]') as HTMLInputElement)?.checked)
    assert.equal(await page.evaluate(() => (window as any).permissionRequests), 1)
    assert(writes.some(value => value?.consent === true))
    assert(writes.some(value => value?.projects?.[0] === "project" && value.preferences.needsInput))
    const history = await page.evaluate(() => (window as any).fixture.notify())
    assert.deepEqual(history, ["private-screen-only"])
    assert.equal(await page.evaluate(() => (window as any).osNotifications), 0)
  } finally { await page.close() }
})

for (const [state, text] of [
  ["disabled", "Disabled by the host"], ["storage", "Host push storage unavailable"],
  ["https", "Use HTTPS or Remote Control"], ["ios", "Add CodeNomad to the Home Screen"],
  ["denied", "Allow notifications in browser settings"],
  ["unsupported", "Background notifications unavailable"],
]) test(`switch refuses ${state} without asking permission`, async () => {
  const { page, control } = await setup(state)
  try {
    await page.getByRole("status").filter({ hasText: text }).waitFor()
    assert.equal(await control.isDisabled(), true)
    assert.equal(await page.evaluate(() => (window as any).permissionRequests), 0)
  } finally { await page.close() }
})

test("an existing browser subscription is refreshed without permission or a second subscribe", async () => {
  const { page, writes, control } = await setup("on")
  try {
    await page.waitForFunction(() => (document.querySelector('[role="switch"]') as HTMLInputElement)?.checked)
    assert.equal(await control.isChecked(), true)
    await page.evaluate(() => (window as any).fixture.refreshBackgroundPush())
    assert.equal(await page.evaluate(() => (window as any).permissionRequests), 0)
    assert(writes.some(value => value?.subscription?.endpoint === "https://push.example.test/local"))
  } finally { await page.close() }
})

for (const host of ["electron", "tauri"]) test(`${host} hides background switch`, async () => {
  const { page, control, writes } = await setup("off", host)
  try { assert.equal(await control.count(), 0); assert.deepEqual(writes, []) }
  finally { await page.close() }
})
