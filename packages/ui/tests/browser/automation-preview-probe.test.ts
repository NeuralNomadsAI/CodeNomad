// TEMPORARY runner probe (removed before merge): which difference from the real test lets the first key arrive.
import { test } from "node:test"
import { createServer } from "node:http"
import { copyFile, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import { createRequire } from "node:module"
import { _electron } from "playwright"

const REAL = `<!doctype html><main><form>
      <label>Title <input value="Prefilled"></label>
      <label>Plan <select><option value="custom">Flexible</option><option value="wayfinder">Exploration</option></select></label>
      <button id="confirm" type="button">Confirm</button><button>Submit</button><output id="result">Pending</output>
      <script>document.getElementById('confirm').addEventListener('click', () => {
        document.getElementById('result').textContent = document.querySelector('input').value + ':' + document.querySelector('select').value
      }); document.querySelector('input').addEventListener('keydown', event => {
        document.getElementById('result').textContent = 'Key:' + event.key
      }); let submitted = 0; document.querySelector('form').addEventListener('submit', event => {
        event.preventDefault(); document.getElementById('result').textContent = 'Submitted:' + (++submitted) + ':' + document.querySelector('input').value
      })</script></form></main>`
const SMALL = `<!doctype html><main><form>
  <label>Title <input value="Prefilled"></label>
  <button id="confirm" type="button">Confirm</button><output id="result">Pending</output>
  <script>document.querySelector('input').addEventListener('keydown', event => { document.getElementById('result').textContent = 'Key:' + event.key })</script></form></main>`

type Variant = { name: string; small?: boolean; skipWaitForFunction?: boolean; watch?: boolean; stateBefore?: boolean; subProfile?: boolean }
const VARIANTS: Variant[] = [
  { name: "exact" }, { name: "no-waitForFunction", skipWaitForFunction: true }, { name: "watch", watch: true },
  { name: "state-before", stateBefore: true }, { name: "sub-profile", subProfile: true }, { name: "small-page", small: true },
]

test("PROBE first key: real-test sequence with one difference at a time", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-preview-probe-"))
  const server = createServer((request, response) => { response.setHeader("Content-Type", "text/html"); response.end(request.url === "/small" ? SMALL : REAL) })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  const shared = path.join(root, "engine.cjs")
  await build({ entryPoints: [fileURLToPath(new URL("fixtures/automation-preview-engine.ts", import.meta.url))],
    outfile: shared, bundle: true, platform: "node", format: "cjs", external: ["electron"],
    define: { "import.meta.url": JSON.stringify(pathToFileURL(shared).href) } })
  try {
    for (const variant of [VARIANTS[0], VARIANTS[0], VARIANTS[0], VARIANTS[0], VARIANTS[0]]) {
      // Like the real test: a fresh directory holding the engine bundle is the Electron profile.
      const profile = await mkdtemp(path.join(os.tmpdir(), "codenomad-preview-engine-"))
      const bundle = path.join(profile, "engine.cjs")
      await copyFile(shared, bundle)
      const env = { ...process.env, CODENOMAD_TEST_PROFILE: variant.subProfile ? path.join(profile, "sub") : profile,
        CODENOMAD_TEST_AUTOMATION_BUNDLE: bundle, CODENOMAD_TEST_GUEST_URL: variant.small ? `${base}small` : base }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.ELECTRON_NO_ASAR
      const app = await _electron.launch({ executablePath: createRequire(import.meta.url)("electron") as string,
        args: ["--no-sandbox", fileURLToPath(new URL("fixtures/automation-preview-electron.cjs", import.meta.url))], env })
      try {
        const execute = (action: Record<string, unknown>) => app.evaluate(async (_electron, input) => (globalThis as any).automationPreview.execute(input), action) as Promise<Record<string, any>>
        const page = await app.firstWindow()
        if (!variant.skipWaitForFunction) await page.waitForFunction(() => Boolean(document.querySelector("webview")))
        await app.evaluate(() => (globalThis as any).automationPreview.ready())
        if (variant.watch) await app.evaluate(() => (globalThis as any).automationPreview.probe.watch())
        await execute({ action: "wait", text: "Title", gone: false, timeout: 15000 })
        const outline = String((await execute({ action: "snapshot" })).snapshot)
        const title = /textbox "Title"[^\n]*?\[(b\d+e\d+)\]/.exec(outline)![1]
        await execute({ action: "type", ref: title, text: "Pilot", clear: true })
        if (variant.stateBefore) await app.evaluate(() => (globalThis as any).automationPreview.probe.state())
        await app.evaluate(() => (globalThis as any).automationPreview.probe.mark("press a"))
        const pressed = Date.now()
        const press = await execute({ action: "press", key: "a", ref: title })
        const pressMs = Date.now() - pressed
        const wait = await execute({ action: "wait", text: "Key:a", gone: false, timeout: 3000 }).then(result => result, error => ({ found: false, error: String(error).slice(0, 120) }))
        let second: unknown
        if (!wait.found) {
          await execute({ action: "press", key: "b", ref: title })
          second = await execute({ action: "wait", text: "Key:b", gone: false, timeout: 1000 }).then(result => result.found, () => false)
        }
        const timeline = await app.evaluate(() => (globalThis as any).automationPreview.probe.timeline())
        const after = await app.evaluate(() => (globalThis as any).automationPreview.probe.state())
        console.log("PROBE " + JSON.stringify({ variant: variant.name, found: wait.found, waitedMs: wait.waitedMs, pressMs, second, timeline,
          after: { result: after.page.result, active: after.page.active, hasFocus: after.page.hasFocus, guestFocused: after.guestFocused } }))
      } catch (error) {
        console.log("PROBE " + JSON.stringify({ variant: variant.name, error: String(error).slice(0, 300) }))
      } finally {
        await app.close().catch(() => undefined)
        await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
