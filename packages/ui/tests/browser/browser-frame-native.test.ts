import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import electronPath from "electron"
import { chromium, _electron, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
let heldGuestRequested = () => {}
const heldGuests: Array<() => void> = []
const guestRequests: string[] = []
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "browser-native-fixture", configureServer(s) {
      s.middlewares.use("/browser-native-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/browser-native-fixture", '<html><head><style>webview { display: flex }</style></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/browser-frame-native.tsx"></script></body></html>'))
      })
      s.middlewares.use("/browser-native-blocking-script", (_req, res) => {
        heldGuests.push(() => { res.setHeader("Content-Type", "text/javascript"); res.end("") })
        heldGuestRequested()
      })
      s.middlewares.use("/browser-native-guest", (req, res) => {
        guestRequests.push(req.url!)
        const query = new URL(req.url!, "http://fixture").searchParams
        if (query.has("redirect")) {
          res.writeHead(302, { Location: "/browser-native-guest?destination" })
          res.end()
          return
        }
        if (query.has("destination")) {
          res.setHeader("Content-Type", "text/html")
          res.end('<html><body>Redirect destination<script src="/browser-native-blocking-script"></script></body></html>')
          return
        }
        const respond = () => { res.setHeader("Content-Type", "text/html"); res.end("<html><body>Preview guest</body></html>") }
        if (req.url?.includes("hold")) {
          heldGuests.push(respond)
          heldGuestRequested()
        } else respond()
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, allowedHosts: ["insecure.test"], hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/browser-native-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined,
    args: ["--host-resolver-rules=MAP insecure.test 127.0.0.1", "--no-proxy-server"] })
})
after(async () => { await browser?.close(); await server?.close() })

const snapshot = (page: Page) => page.evaluate(() => {
  const fixture = (window as any).nativeFixture
  return { calls: fixture.calls, errors: fixture.errors, locations: fixture.locations, listeners: fixture.listenerCount() }
})

test("viewport menu distinguishes size from device emulation and restores desktop overrides", async () => {
  const page = await browser.newPage({ userAgent: "Windows fixture" })
  try {
    await page.goto(url)
    await page.waitForFunction(() => (window as any).nativeFixture?.calls.some((c: any) => c.command === "browser_target_register"))
    const menu = page.getByRole("button", { name: "Viewport", exact: true })
    assert.equal(await page.getByRole("button", { name: /Landscape orientation|Orientation paysage/ }).count(), 0)
    await menu.click()
    assert.deepEqual(await page.getByRole("menuitemradio").allTextContents(), ["Responsive", "Desktop (1440 × 900)", "Tablet (768 × 1024)", "Tablet landscape (1024 × 768)", "Mobile (390 × 844)", "Mobile landscape (844 × 390)"])
    await page.getByRole("menuitemradio", { name: /390 × 844/ }).click()
    await page.waitForFunction(() => (window as any).nativeFixture.calls.some((c: any) => c.payload?.preset === "mobile"))
    await menu.click()
    assert.equal(await page.getByRole("menuitemradio", { name: /390 × 844/ }).getAttribute("aria-checked"), "true")
    await page.getByRole("menuitemradio", { name: /844 × 390/ }).click()
    await menu.click()
    if (process.env.CODENOMAD_MOBILE_CAPTURE) await page.screenshot({ path: `${process.env.CODENOMAD_MOBILE_CAPTURE}/phone-templates-menu.png` })
    await page.evaluate(() => { (window as any).nativeFixture.failEmulation = true })
    await page.getByRole("menuitemradio", { name: /390 × 844/ }).click()
    await page.getByRole("alertdialog").waitFor()
    await page.evaluate(() => { (window as any).nativeFixture.overlay(false); (window as any).nativeFixture.failEmulation = false })
    await menu.click()
    assert.equal(await page.getByRole("menuitemradio", { name: /844 × 390/ }).getAttribute("aria-checked"), "true", "failed emulation preserves the applied selection")
    await page.getByRole("menuitemradio").first().click()
    await page.waitForFunction(() => (window as any).nativeFixture.calls.some((c: any) => c.payload?.preset === "none"))
    assert.deepEqual((await snapshot(page)).calls.filter((c: any) => c.payload?.action === "emulate").map((c: any) => c.payload.preset), ["mobile", "mobileLandscape", "mobile", "none"])
  } finally { await page.close() }
})

for (const host of ["electron", "tauri"]) {
  test(`${host} mobile emulation remains retryable after retained-profile application fails`, async () => {
    const fixture = host === "electron" ? await openElectronFixture() : undefined
    const page = fixture?.page ?? await browser.newPage({ userAgent: "Windows fixture" })
    try {
      await page.goto(`${url}?host=${host}`)
      await page.waitForFunction(() => (window as any).nativeFixture?.calls.some((c: any) => c.command === "browser_target_register"))
      const menu = page.getByRole("button", { name: "Viewport", exact: true })
      await menu.click()
      await page.getByRole("menuitemradio", { name: /390 × 844/ }).click()
      await page.evaluate(() => {
        ;(window as any).nativeFixture.failEmulation = true
        ;(window as any).nativeFixture.session("replacement-session")
      })
      await page.getByRole("alertdialog").waitFor()
      await page.evaluate(() => {
        ;(window as any).nativeFixture.failEmulation = false
        ;(window as any).nativeFixture.overlay(false)
      })
      await menu.click()
      assert.equal(await page.getByRole("menuitemradio", { name: /390 × 844/ }).isEnabled(), true)
      assert.equal(await page.getByRole("menuitemradio", { name: /844 × 390/ }).isEnabled(), true)
      await page.getByRole("menuitemradio", { name: /390 × 844/ }).click()
      await page.waitForFunction(() => (window as any).nativeFixture.calls.filter((c: any) => c.payload?.preset === "mobile").length === 3)
      await menu.click()
      await page.getByRole("menuitemradio").first().click()
      await menu.click()
      assert.equal(await page.getByRole("menuitemradio", { name: /390 × 844/ }).isEnabled(), true)
      assert.deepEqual((await snapshot(page)).calls.filter((c: any) => c.payload?.action === "emulate").map((c: any) => c.payload.preset), ["mobile", "mobile", "mobile", "none"])
    } finally { if (fixture) await fixture.close(); else await page.close() }
  })
}

test("fixed viewport templates remain keyboard accessible in a narrow preview", async () => {
  const page = await browser.newPage({ userAgent: "Windows fixture", viewport: { width: 320, height: 740 } })
  try {
    await page.goto(url)
    await page.evaluate(() => { document.getElementById("preview")!.style.width = "100%" })
    const menu = page.getByRole("button", { name: "Viewport", exact: true })
    await menu.click()
    const bounds = await page.getByRole("menu").boundingBox()
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320)
    await page.getByRole("menuitemradio", { name: /390 × 844/ }).click()
    await menu.click()
    await page.getByRole("menuitemradio", { name: /844 × 390/ }).focus()
    await page.keyboard.press("Space")
    await page.waitForFunction(() => (window as any).nativeFixture.calls.some((c: any) => c.payload?.preset === "mobileLandscape"))
    const close = page.locator(".window-close-button")
    const closeBounds = await close.boundingBox()
    assert.ok(closeBounds && closeBounds.x + closeBounds.width <= 320)
    await close.click()
    assert.equal(await menu.count(), 0)
  } finally { await page.close() }
})

test("iframe preview keeps the original mobile templates as dimensions only", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(`${url}?host=web`)
    await page.getByRole("button", { name: "Viewport", exact: true }).click()
    await page.getByRole("menuitemradio", { name: /390 × 844/ }).click()
    assert.equal(await page.locator("iframe").evaluate(el => Math.round(el.getBoundingClientRect().width)), 390)
    assert.equal((await snapshot(page)).calls.some((c: any) => c.payload?.action === "emulate"), false)
  } finally { await page.close() }
})

async function openElectronFixture() {
  const temp = process.env.CODENOMAD_TEST_TEMP || (process.platform === "win32"
    ? join(process.env.LOCALAPPDATA!, "Temp", "opencode") : tmpdir())
  await mkdir(temp, { recursive: true })
  const profile = await mkdtemp(join(temp, "browser-frame-electron-"))
  const env = { ...process.env, CODENOMAD_TEST_PROFILE: profile }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: process.env.CODENOMAD_TEST_ELECTRON || electronPath,
    args: ["--no-sandbox", fileURLToPath(new URL("fixtures/browser-frame-native-electron.cjs", import.meta.url))], env })
  return { page: await app.firstWindow(), close: async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } }
}

test("insecure HTTP web previews mount without native UUID support", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(String(error)))
  try {
    await page.goto(`${url.replace("127.0.0.1", "insecure.test")}?host=web`)
    await page.locator("iframe").waitFor()
    assert.deepEqual(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID })),
      { secure: false, uuid: "undefined" })
    assert.equal(await page.frameLocator("iframe").locator("body").innerText(), "Preview guest")
    assert.deepEqual((await snapshot(page)).calls, [])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("real Electron guest mounts and accepts target changes before dom-ready", async () => {
  const fixture = await openElectronFixture()
  const { page } = fixture
  const errors: string[] = []
  page.on("pageerror", error => errors.push(String(error)))
  const heldRequest = new Promise<void>(resolve => { heldGuestRequested = resolve })
  try {
    await page.goto(`${url}?host=electron&hold=1`)
    await heldRequest
    // The server holds the first document, so the real guest cannot be ready yet.
    assert.equal((await snapshot(page)).calls.filter((c: any) => c.command === "browser_target_register").length, 0)
    await page.getByRole("button", { name: "Back", exact: true }).click()
    await page.getByRole("button", { name: "Refresh", exact: true }).click()
    const target = new URL("/browser-native-guest?next", url).href
    await page.evaluate(target => (window as any).nativeFixture.address(target), target)
    await page.waitForFunction(() => (window as any).nativeFixture.calls.some((c: any) => c.command === "browser_target_register"))
    assert.equal(await page.locator("webview").evaluate((guest: any) => guest.getURL()), target)
    const nextTarget = new URL("/browser-native-guest?manual", url).href
    await page.evaluate(() => {
      ;(window as any).guestLoaded = new Promise<void>(resolve => {
        document.querySelector("webview")!.addEventListener("did-finish-load", () => resolve(), { once: true })
      })
    })
    await page.getByRole("textbox", { name: "Address", exact: true }).fill(nextTarget)
    await page.getByRole("button", { name: "Go", exact: true }).click()
    await page.evaluate(() => (window as any).guestLoaded)
    assert.equal(await page.locator("webview").evaluate((guest: any) => guest.getURL()), nextTarget)
    assert.deepEqual(errors, [])
    assert.deepEqual((await snapshot(page)).errors, [])
    await page.evaluate(() => (window as any).nativeFixture.mount(false))
    await page.waitForFunction(() => (window as any).nativeFixture.calls.some((c: any) => c.command === "browser_target_unregister"))
  } finally {
    heldGuestRequested = () => {}
    heldGuests.splice(0).forEach(respond => respond())
    await fixture.close()
  }
})

for (const replaceTarget of [false, true]) {
  test(`real Electron initial redirect loads once${replaceTarget ? " and accepts a new target before dom-ready" : " through dom-ready"}`, async () => {
    const fixture = await openElectronFixture()
    const { page } = fixture
    const errors: string[] = []
    page.on("pageerror", error => errors.push(String(error)))
    const blocked = new Promise<void>(resolve => { heldGuestRequested = resolve })
    guestRequests.length = 0
    try {
      await page.goto(`${url}?host=electron&redirect=1`)
      await blocked
      await page.waitForFunction(() => (window as any).nativeFixture.locations.length > 0)
      // The redirect has committed, but its parser-blocking script prevents dom-ready.
      // Allow a duplicate navigation enough time to reach the HTTP fixture.
      await page.waitForTimeout(100)
      const destination = new URL("/browser-native-guest?destination", url).href
      assert.deepEqual(guestRequests, ["/?redirect", "/?destination"])
      assert.deepEqual((await snapshot(page)).locations, [destination])
      assert.equal((await snapshot(page)).calls.filter((c: any) => c.command === "browser_target_register").length, 0)
      const target = replaceTarget ? new URL("/browser-native-guest?replacement", url).href : destination
      if (replaceTarget) await page.evaluate(target => (window as any).nativeFixture.address(target), target)
      else heldGuests.splice(0).forEach(respond => respond())
      await page.waitForFunction(() => (window as any).nativeFixture.calls.some((c: any) => c.command === "browser_target_register"))
      // Releasing a superseded document must not feed its URL back into the new guest.
      heldGuests.splice(0).forEach(respond => respond())
      await page.waitForTimeout(100)
      assert.equal(await page.locator("webview").evaluate((guest: any) => guest.getURL()), target)
      assert.deepEqual(guestRequests, ["/?redirect", "/?destination", ...(replaceTarget ? ["/?replacement"] : [])])
      const settled = await snapshot(page)
      assert.deepEqual(settled.locations, replaceTarget ? [destination, target] : [destination])
      assert.deepEqual(settled.errors, [])
      assert.deepEqual(errors, [])
    } finally {
      heldGuestRequested = () => {}
      heldGuests.splice(0).forEach(respond => respond())
      await fixture.close()
    }
  })
}

for (const ready of [false, true]) for (const viaAddressBar of [false, true]) {
  test(`real Electron re-requests the original redirect source ${ready ? "after" : "before"} dom-ready via ${viaAddressBar ? "address bar" : "props"}`, async () => {
    const fixture = await openElectronFixture()
    const { page } = fixture
    const errors: string[] = []
    page.on("pageerror", error => errors.push(String(error)))
    const blocked = new Promise<void>(resolve => { heldGuestRequested = resolve })
    guestRequests.length = 0
    try {
      await page.goto(`${url}?host=electron&redirect=1`)
      await blocked
      await page.waitForFunction(() => (window as any).nativeFixture.locations.length === 1)
      if (ready) {
        heldGuests.splice(0).forEach(respond => respond())
        await page.waitForFunction(() => (window as any).nativeFixture.calls.some((c: any) => c.command === "browser_target_register"))
      }
      assert.equal((await snapshot(page)).calls.some((c: any) => c.command === "browser_target_register"), ready)
      const source = new URL("/browser-native-guest?redirect", url).href
      const destination = new URL("/browser-native-guest?destination", url).href
      const reblocked = new Promise<void>(resolve => { heldGuestRequested = resolve })
      if (viaAddressBar) {
        await page.getByRole("textbox", { name: "Address", exact: true }).fill(source)
        await page.getByRole("button", { name: "Go", exact: true }).click()
      } else await page.evaluate(source => (window as any).nativeFixture.address(source), source)
      await page.waitForFunction(count => (window as any).nativeFixture.locations.length === count,
        viaAddressBar ? 3 : 2, { timeout: 5_000 })
      await reblocked
      await page.evaluate(() => {
        ;(window as any).guestLoaded = new Promise<void>(resolve => {
          document.querySelector("webview")!.addEventListener("did-finish-load", () => resolve(), { once: true })
        })
      })
      heldGuests.splice(0).forEach(respond => respond())
      await page.evaluate(() => (window as any).guestLoaded)
      await page.waitForTimeout(100)
      // An explicit request for A must dispatch again, while each resulting B
      // notification remains observational rather than starting another load.
      assert.deepEqual(guestRequests, ["/?redirect", "/?destination", "/?redirect", "/?destination"])
      assert.equal(await page.locator("webview").evaluate((guest: any) => guest.getURL()), destination)
      assert.equal(await page.getByRole("textbox", { name: "Address", exact: true }).inputValue(), destination)
      const settled = await snapshot(page)
      assert.deepEqual(settled.locations, viaAddressBar ? [destination, source, destination] : [destination, destination])
      assert.deepEqual(settled.errors, [])
      assert.deepEqual(errors, [])
    } finally {
      heldGuestRequested = () => {}
      heldGuests.splice(0).forEach(respond => respond())
      await fixture.close()
    }
  })
}

for (const change of ["resize", "hide"] as const) {
  test(`Tauri ${change} failures stop retrying and report once, then recover on layout changes`, async () => {
    const page = await browser.newPage({ userAgent: "Windows fixture" })
    try {
      await page.goto(url)
      await page.waitForFunction(() => (window as any).nativeFixture?.calls.some((c: any) => c.command === "browser_target_register"))
      await page.evaluate(change => {
        const fixture = (window as any).nativeFixture
        fixture.failUpdates = true
        if (change === "hide") fixture.overlay(true)
        else document.getElementById("preview")!.style.width = "700px"
      }, change)
      await page.getByRole("alertdialog").waitFor()
      await page.waitForFunction(() => (window as any).nativeFixture.errors.length > 0)
      // Cross many native IPC turns to catch recursive rejection retries.
      await page.waitForTimeout(250)
      const failed = await snapshot(page)
      assert.equal(failed.errors.length, 1)
      assert.ok(failed.calls.filter((c: any) => c.command === "browser_target_update").length <= 3)
      await page.waitForTimeout(100)
      assert.equal((await snapshot(page)).calls.length, failed.calls.length)

      await page.evaluate(() => {
        const fixture = (window as any).nativeFixture
        fixture.failUpdates = false
        fixture.overlay(false)
        document.getElementById("preview")!.style.width = "600px"
      })
      await page.waitForFunction(() => (window as any).nativeFixture.calls.some((c: any) =>
        c.command === "browser_target_update" && c.payload.visible && c.payload.bounds?.width === 600))
      assert.equal((await snapshot(page)).errors.length, 1)
    } finally { await page.close() }
  })
}

for (const host of ["electron", "tauri"]) {
  for (const reject of [false, true]) {
    test(`${host} pending registration ${reject ? "rejection stays silent" : "is unregistered"} after disposal`, async () => {
      const electron = host === "electron" ? await openElectronFixture() : undefined
      const page = electron?.page ?? await browser.newPage({ userAgent: "Windows fixture" })
      try {
        await page.goto(`${url}?host=${host}`)
        await page.waitForFunction(() => (window as any).nativeFixture?.calls.some((c: any) => c.command === "browser_target_register"))
        await page.evaluate(() => (window as any).nativeFixture.mount(false))
        await page.waitForFunction(() => (window as any).nativeFixture.calls.some((c: any) => c.command === "browser_target_unregister"))
        await page.evaluate(() => {
          const fixture = (window as any).nativeFixture
          fixture.calls.length = 0
          fixture.deferRegistration = true
          fixture.mount(true)
        })
        await page.waitForFunction(() => (window as any).nativeFixture.calls.some((c: any) => c.command === "browser_target_register"))
        const pending = (await snapshot(page)).calls.find((c: any) => c.command === "browser_target_register")
        await page.evaluate(({ reject, registrationId }) => {
          const fixture = (window as any).nativeFixture
          fixture.locations.length = 0
          fixture.mount(false)
          fixture.settleRegistration(reject)
          fixture.navigate(registrationId, "http://localhost:3000/stale")
        }, { reject, registrationId: pending.payload.registrationId })
        await page.waitForTimeout(250)
        const settled = await snapshot(page)
        assert.deepEqual(settled.errors, [])
        assert.deepEqual(settled.locations, [])
        assert.equal(settled.listeners, 0)
        assert.equal(settled.calls.filter((c: any) => c.command === "browser_target_register").length, 1)
        const unregisters = settled.calls.filter((c: any) => c.command === "browser_target_unregister")
        assert.equal(unregisters.length, reject ? 0 : 1)
        if (!reject) assert.equal(unregisters[0].registrationId, pending.payload.registrationId)
      } finally { if (electron) await electron.close(); else await page.close() }
    })
  }
}
