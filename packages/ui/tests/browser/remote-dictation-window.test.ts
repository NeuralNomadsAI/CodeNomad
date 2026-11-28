import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { borrowFixture } from "./fixture-borrow"

let url: string
let browser: Browser
before(async () => {
  const fixture = await borrowFixture({
    name: "trusted-dictation",
    routes: [{ path: "/fixture", html: `<html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>` }],
  })
  const target = new URL(fixture.url)
  target.searchParams.set("dictationLocale", "en-US")
  target.hash = new URLSearchParams({ dictationDestination: "https://projects.example.test:8443" }).toString()
  url = target.toString()
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

async function withWindow(use: (page: Page) => Promise<void>, engine: "hex" | "api" | null = "hex", locale: "en-US" | "fr-FR" = "en-US") {
  const page = await browser.newPage({ locale })
  page.setDefaultTimeout(6000)
  const posts: string[] = []
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("request", request => { if (request.method() === "POST") posts.push(request.url()) })
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    const installNativeBridge = (engine: "hex" | "api" | null) => {
      const events: Record<string, unknown>[] = []
      const id = "00000000-0000-4000-8000-000000000001"
      let state = "recording"
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext()
        const source = context.createOscillator()
        const output = context.createMediaStreamDestination()
        source.connect(output)
        source.start()
        await context.resume()
        const [track] = output.stream.getAudioTracks()
        const stop = track.stop.bind(track)
        track.stop = () => { stop(); void context.close() }
        return output.stream
      }
      const addModule = Worklet.prototype.addModule
      Worklet.prototype.addModule = function (url, options) {
        return addModule.call(this, new URL(`/src/renderer/public${new URL(String(url)).pathname}`, location.href), options)
      }
      Object.assign(window, {
        events, showPreview: () => { state = "transcribed" },
        __CODENOMAD_WINDOW_CONTEXT__: "dictation", __CODENOMAD_RUNTIME_HOST__: "electron",
        electronAPI: {
          deviceSpeech: async (request: { action: string }) => {
            events.push(request)
            switch (request.action) {
              case "claimMicrophone": return { ok: true, value: { busy: null } }
              case "releaseMicrophone": return { ok: true, value: null }
              case "read": return { ok: true, value: {
                engine, hex: { state: "ready", plan: { id: "ready", missing: [] } },
              } }
              case "start": return { ok: true, value: { id } }
              case "status": return { ok: true, value: { state, ...(state === "transcribed" ? { text: "Local preview" } : {}) } }
              case "finish": state = "transcribing"; return { ok: true, value: null }
              case "cancel": state = "cancelled"; return { ok: true, value: null }
            }
          },
          settleRemoteDictation: async (request: Record<string, unknown>) => { events.push({ settle: true, ...request }) },
        },
      })
    }
    await page.addInitScript(`{ const __name = (value) => value; (${installNativeBridge.toString()})(${JSON.stringify(engine)}); }`)
    await page.goto(url)
    await page.bringToFront()
    await page.getByRole("heading", { name: locale === "fr-FR" ? "Dicter sur cet appareil" : "Dictate on this device" }).waitFor().catch(error => {
      if (errors.length) throw new AggregateError(errors, errors.join("; "), { cause: error })
      throw error
    })
    await use(page)
    assert.deepEqual(posts, [])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
}

const events = (page: Page) => page.evaluate(() => (window as any).events as Record<string, unknown>[])
const showPreview = (page: Page) => page.evaluate(() => (window as any).showPreview())

test("the trusted window requires a real gesture before capture and after preview, and releases only text", () => withWindow(async page => {
  await page.getByText("https://projects.example.test:8443", { exact: true }).waitFor()
  const start = page.getByRole("button", { name: "Start voice input" })
  await start.evaluate((button: HTMLButtonElement) => button.click())
  assert.deepEqual(await events(page), [{ action: "read" }])
  await start.focus()
  await page.keyboard.press("Enter")
  const stop = page.getByRole("button", { name: "Stop recording and transcribe" })
  await stop.waitFor()
  assert.equal(await page.getByRole("button", { name: "Insert transcript" }).count(), 0)
  assert.equal(await stop.evaluate(node => node === document.activeElement), true)
  await page.keyboard.down("Enter")
  await page.waitForFunction(() => (window as any).events.some(({ action }: any) => action === "finish"))
  const finish = (await events(page)).find(event => event.action === "finish")
  assert.equal(typeof finish?.wav, "string")
  await showPreview(page)
  await page.getByText("Local preview", { exact: true }).waitFor()
  const insert = page.getByRole("button", { name: "Insert transcript", exact: true })
  assert.equal(await insert.evaluate(node => node === document.activeElement), true)
  await insert.evaluate((button: HTMLButtonElement) => button.click())
  await page.keyboard.down("Enter")
  await page.keyboard.up("Enter")
  assert.deepEqual((await events(page)).filter(event => event.settle), [])
  await page.keyboard.press("Enter")
  assert.deepEqual((await events(page)).filter(event => event.settle), [{ settle: true, action: "complete", text: "Local preview" }])
}))

test("the transcript preview leaves focus on Cancel when the user moves it during transcription", () => withWindow(async page => {
  await page.getByRole("button", { name: "Start voice input" }).press("Enter")
  await page.getByRole("button", { name: "Stop recording and transcribe" }).press("Enter")
  await page.waitForFunction(() => (window as any).events.some(({ action }: any) => action === "finish"))
  const cancel = page.getByRole("button", { name: "Cancel", exact: true })
  await cancel.focus()
  await showPreview(page)
  await page.getByRole("button", { name: "Insert transcript", exact: true }).waitFor()
  assert.equal(await cancel.evaluate(node => node === document.activeElement), true)
  assert.deepEqual((await events(page)).filter(event => event.settle), [])
}))

for (const input of ["pointer", "Space"] as const) {
  test(`${input} pressed before the preview cannot confirm it on release`, () => withWindow(async page => {
    await page.getByRole("button", { name: "Start voice input" }).press("Enter")
    await page.getByRole("button", { name: "Stop recording and transcribe" }).press("Enter")
    const capture = page.getByRole("button", { name: "Start voice input" })
    const bounds = (await capture.boundingBox())!
    const point = { x: bounds.x + bounds.width - 16, y: bounds.y + bounds.height / 2 }
    if (input === "pointer") {
      await page.mouse.move(point.x, point.y)
      await page.mouse.down()
    } else await page.keyboard.down(input)
    await showPreview(page)
    const insert = page.getByRole("button", { name: "Insert transcript", exact: true })
    await insert.waitFor()
    if (input === "pointer") {
      assert.equal(await insert.evaluate((node, { x, y }) => node.contains(document.elementFromPoint(x, y)), point), true)
      await page.mouse.up()
    } else await page.keyboard.up(input)
    assert.deepEqual((await events(page)).filter(event => event.settle), [])
  }))
}

test("an unsupported saved engine offers Voice preferences, without capture or API fallback", () => withWindow(async page => {
  await page.getByRole("status").getByText("Choose an engine in local Preferences → Voice → Dictation.", { exact: true }).waitFor()
  assert.equal(await page.getByRole("button", { name: "Start voice input" }).count(), 0)
  await page.getByRole("button", { name: "Voice", exact: true }).click()
  assert.deepEqual(await events(page), [{ action: "read" }, { settle: true, action: "settings" }])
}, null))

test("the trusted hand-off uses the device's French interface locale", () => withWindow(async page => {
  assert.equal(await page.locator("html").getAttribute("lang"), "fr")
  await page.getByText("La dictée locale est indisponible.", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Voix", exact: true }).focus()
  await page.keyboard.press("Enter")
  assert.deepEqual((await events(page)).at(-1), { settle: true, action: "settings" })
}, "api", "fr-FR"))

test("Escape cancels native capture and closes the trusted hand-off without releasing text", () => withWindow(async page => {
  await page.getByRole("button", { name: "Start voice input" }).click()
  await page.getByRole("button", { name: "Stop recording and transcribe" }).waitFor()
  await page.keyboard.press("Escape")
  const actions = await events(page)
  assert.deepEqual(actions.filter(event => event.action === "cancel"), [
    { action: "cancel", id: "00000000-0000-4000-8000-000000000001" },
    { settle: true, action: "cancel" },
  ])
  assert.deepEqual(actions.at(-1), {
    action: "releaseMicrophone", id: actions.find(event => event.action === "claimMicrophone")?.id,
  })
}))
