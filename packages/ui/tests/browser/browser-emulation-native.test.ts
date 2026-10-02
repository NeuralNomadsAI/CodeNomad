import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import electronPath from "electron"
import { _electron } from "playwright"

test("native Chromium emulation applies mobile media, UA, density and orientation and fully resets", async () => {
  const temp = await mkdtemp(join(process.env.CODENOMAD_TEST_TEMP || (process.platform === "win32" ? join(process.env.LOCALAPPDATA!, "Temp", "opencode") : tmpdir()), "emulation-"))
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html")
    res.end('<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>Mobile fixture</body></html>')
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    const modulePath = join(temp, "emulation.cjs")
    await build({ entryPoints: [fileURLToPath(new URL("../../../electron-app/electron/main/browser-emulation.ts", import.meta.url))], outfile: modulePath, bundle: true, platform: "node", format: "cjs", external: ["electron"] })
    const env = { ...process.env, CODENOMAD_TEST_PROFILE: join(temp, "profile"), CODENOMAD_EMULATION_MODULE: modulePath,
      CODENOMAD_EMULATION_URL: `http://127.0.0.1:${(server.address() as any).port}/` }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: process.env.CODENOMAD_TEST_ELECTRON || electronPath,
      args: ["--no-sandbox", fileURLToPath(new URL("fixtures/browser-emulation-electron.cjs", import.meta.url))], env })
    const page = await app.firstWindow()
    await page.waitForLoadState()
    const snapshot = () => app!.evaluate(() => (globalThis as any).emulationFixture.snapshot())
    const baseline = await snapshot()
    const dimensions = { mobile: [390, 844], mobileLandscape: [844, 390] }
    for (const preset of ["mobile", "mobileLandscape", "none"] as const) {
      const loaded = page.waitForEvent("load")
      await app.evaluate((_electron, preset) => (globalThis as any).emulationFixture.apply(preset), preset)
      await loaded
      const result = await snapshot()
      if (preset === "none") assert.deepEqual(result, baseline)
      else {
        assert.equal(result.width, dimensions[preset][0])
        assert.equal(result.height, dimensions[preset][1])
        assert.equal(result.dpr, 2.75)
        assert.equal(result.coarse, true)
        assert.equal(result.hover, false)
        assert.equal(result.mobile, true)
        assert.equal(result.hintPlatform, "Android")
        assert.equal(result.platform, "Linux armv8l")
        assert.equal(result.screenWidth, result.width)
        assert.equal(result.screenHeight, result.height)
        assert.equal(result.touch, 5)
        assert.match(result.ua, /Android 11/)
        assert.doesNotMatch(result.ua, /Pixel/)
        assert.equal(result.orientation, preset.endsWith("Landscape") ? "landscape-primary" : "portrait-primary")
        await app.evaluate(() => (globalThis as any).emulationFixture.accessibility())
        assert.deepEqual(await snapshot(), result, "accessibility inspection keeps emulation active")
        await page.reload()
        assert.deepEqual(await snapshot(), result, "overrides survive document navigation")
      }
    }
    await assert.rejects(app.evaluate(() => (globalThis as any).emulationFixture.apply("untrusted-profile")), /Invalid browser emulation profile/)
  } finally {
    await app?.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
