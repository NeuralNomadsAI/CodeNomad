import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { build } from "esbuild"
import electronPath from "electron"
import { _electron } from "playwright"

async function main() {
const output = resolve(process.argv[2] || ".tmp/p5-validation")
await mkdir(output, { recursive: true })
const temp = await mkdtemp(join(process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Temp/opencode") : tmpdir(), "mobile-comparison-"))
const html = await readFile("packages/tauri-app/tests/browser-parent/mobile.html", "utf8")
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.end(html.replace("{{UA}}", JSON.stringify(req.headers["user-agent"]).replaceAll("<", "\\u003c"))
    .replace("{{LOAD}}", JSON.stringify(randomUUID())))
})
await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
try {
  const modulePath = join(temp, "emulation.cjs")
  await build({ entryPoints: ["packages/electron-app/electron/main/browser-emulation.ts"], outfile: modulePath,
    bundle: true, platform: "node", format: "cjs", external: ["electron"] })
  const env = { ...process.env, CODENOMAD_TEST_PROFILE: join(temp, "profile"), CODENOMAD_EMULATION_MODULE: modulePath,
    CODENOMAD_EMULATION_URL: `http://127.0.0.1:${(server.address() as any).port}/` }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ASAR
  app = await _electron.launch({ executablePath: electronPath,
    args: ["--no-sandbox", resolve("packages/ui/tests/browser/fixtures/browser-emulation-electron.cjs")], env })
  const page = await app.firstWindow()
  const probe = () => page.evaluate(() => {
    ;(window as any).report()
    return JSON.parse(document.querySelector("#report")!.textContent!.split("__CN_MOBILE__")[1])
  })
  await page.waitForFunction(() => typeof (window as any).report === "function")
  const baseline = await probe(), rows = []
  for (const preset of ["mobile", "mobileLandscape", "none"]) {
    const loaded = page.waitForEvent("load")
    await app.evaluate((_electron, preset) => (globalThis as any).emulationFixture.apply(preset), preset)
    await loaded
    const value = await probe()
    assert.equal(value.ua, value.httpUA)
    assert.notEqual(value.load, baseline.load)
    if (preset !== "none") {
      assert.deepEqual(value.inner, preset === "mobile" ? [390, 844] : [844, 390])
      assert.equal(value.dpr, 2.75)
      assert.equal(value.media["pointer:coarse"], true)
      assert.equal(value.media["hover:none"], true)
      await app.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents
        for (const type of ["mouseDown", "mouseUp"] as const) {
          contents.sendInputEvent({ type, x: 70, y: 150, button: "left", clickCount: 1 })
        }
      })
      await page.waitForFunction(() => (window as any).inputEvents.some((event: any) => event.type === "click"))
      const clicked = await probe()
      assert.ok(clicked.events.some((event: any) => event.type === "touchstart" && event.trusted))
      rows.push({ name: preset, ...clicked })
    } else {
      assert.equal(value.ua, baseline.ua)
      rows.push({ name: "reset", ...value })
    }
  }
  await writeFile(join(output, "chromium-mobile.json"), JSON.stringify({ passed: true, baseline, rows }, null, 2))
  console.log(JSON.stringify(rows.map(({ name, inner, dpr, touch, events }) => ({ name, inner, dpr, touch, events }))))
} finally {
  await app?.close()
  await new Promise<void>(done => server.close(() => done()))
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
}
main().catch(error => { console.error(error); process.exitCode = 1 })
