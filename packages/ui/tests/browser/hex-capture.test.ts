import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import type { Page } from "playwright"
import { startProductFixture } from "./fixtures/product-fixture-server"

let fixture: Awaited<ReturnType<typeof startProductFixture>>
before(async () => { fixture = await startProductFixture("hex-capture") })
after(async () => { await fixture?.close() })

async function withCapture(use: (page: Page) => Promise<void>, linuxTauri = false) {
  const page = await fixture.browser.newPage()
  const errors: Error[] = []
  page.on("pageerror", error => errors.push(error))
  try {
    if (linuxTauri) await page.addInitScript(() => {
      Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: "tauri", __CODENOMAD_WINDOW_CONTEXT__: "dictation" })
      Object.defineProperty(navigator, "userAgent", { value: "Linux" })
    })
    page.setDefaultTimeout(6_000)
    await page.goto(fixture.url)
    await page.getByRole("button", { name: "Start" }).waitFor()
    await use(page)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
}

async function start(page: Page) {
  await page.getByRole("button", { name: "Start" }).click()
  const info = await page.waitForFunction(() => {
    const info = (window as any).fixture
    return info.error || info.state === "recording" ? info : null
  }).then(handle => handle.jsonValue())
  assert.equal(info.state, "recording", JSON.stringify(info))
}

test("Hex captures synthetic PCM, releases the audio track and finishes only on the native bridge", () => withCapture(async page => {
  await start(page)
  await page.waitForFunction(() => (window as any).fixture.samples > 0)
  await page.getByRole("button", { name: "Finish" }).click()
  await page.waitForFunction(() => (window as any).fixture.text === "Bonjour.")
  const info = await page.evaluate(() => (window as any).fixture)
  assert.equal(info.stopped, 1)
  const wav = Buffer.from(info.requests.find(({ action }: { action: string }) => action === "finish").wav, "base64")
  assert.equal(wav.toString("ascii", 0, 4), "RIFF")
  assert.equal(wav.readUInt32LE(24), 16_000)
  assert.ok(wav.length > 44)
  assert.equal(await page.locator("iframe").count(), 0)
}, true))

test("Hex releases synthetic audio immediately on cancel and never hands it to inference", () => withCapture(async page => {
  await start(page)
  await page.getByRole("button", { name: "Cancel" }).click()
  const info = await page.evaluate(() => (window as any).fixture)
  assert.equal(info.stopped, 1)
  assert.equal(info.state, "idle")
  assert.equal(info.requests.filter(({ action }: { action: string }) => action === "finish").length, 0)
  assert.equal(info.requests.filter(({ action }: { action: string }) => action === "cancel").length, 1)
  assert.equal(await page.locator("iframe").count(), 0)
}, true))
