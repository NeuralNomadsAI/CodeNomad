// TEMPORARY runner probe (removed before merge): which preparation lets the first key reach a fresh hidden guest.
import { test } from "node:test"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import { createRequire } from "node:module"
import { _electron } from "playwright"

const PAGE = `<!doctype html><main><form>
  <label>Title <input value="Prefilled"></label>
  <button id="confirm" type="button">Confirm</button><output id="result">Pending</output>
  <script>window.__probeEvents = []
  for (const type of ["keydown", "keypress", "keyup", "beforeinput", "input", "focus", "blur", "focusin"])
    window.addEventListener(type, event => window.__probeEvents.push(type + ":" + (event.key ?? (event.target && event.target.tagName)) + ":" + Math.round(performance.now())), true)
  document.querySelector('input').addEventListener('keydown', event => { document.getElementById('result').textContent = 'Key:' + event.key })</script></form></main>`

test("PROBE first key to a fresh hidden guest", { timeout: 240_000 }, async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "codenomad-preview-probe-"))
  const server = createServer((_request, response) => { response.setHeader("Content-Type", "text/html"); response.end(PAGE) })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const guestURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  const bundle = path.join(profile, "engine.cjs")
  await build({ entryPoints: [fileURLToPath(new URL("fixtures/automation-preview-engine.ts", import.meta.url))],
    outfile: bundle, bundle: true, platform: "node", format: "cjs", external: ["electron"],
    define: { "import.meta.url": JSON.stringify(pathToFileURL(bundle).href) } })
  try {
    for (const variant of ["baseline", "focus", "shift", "notype", "delay", "mousemove", "baseline", "focus", "shift", "notype", "delay", "mousemove"]) {
      const env = { ...process.env, CODENOMAD_TEST_PROFILE: path.join(profile, `p-${Math.random()}`), CODENOMAD_TEST_AUTOMATION_BUNDLE: bundle, CODENOMAD_TEST_GUEST_URL: guestURL }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.ELECTRON_NO_ASAR
      const app = await _electron.launch({ executablePath: createRequire(import.meta.url)("electron") as string,
        args: ["--no-sandbox", fileURLToPath(new URL("fixtures/automation-preview-electron.cjs", import.meta.url))], env })
      try {
        const execute = (action: Record<string, unknown>) => app.evaluate(async (_electron, input) => (globalThis as any).automationPreview.execute(input), action) as Promise<Record<string, any>>
        await app.firstWindow()
        await app.evaluate(() => (globalThis as any).automationPreview.ready())
        await app.evaluate(() => (globalThis as any).automationPreview.probe.watch())
        await execute({ action: "wait", text: "Title", gone: false, timeout: 15000 })
        const outline = String((await execute({ action: "snapshot" })).snapshot)
        const title = /textbox "Title"[^\n]*?\[(b\d+e\d+)\]/.exec(outline)![1]
        if (variant !== "notype") await execute({ action: "type", ref: title, text: "Pilot", clear: true })
        const before = await app.evaluate(() => (globalThis as any).automationPreview.probe.state())
        await app.evaluate(async (_electron, value) => (globalThis as any).automationPreview.probe.prepare(value), variant)
        await execute({ action: "press", key: "a", ref: title })
        const found = await execute({ action: "wait", text: "Key:a", gone: false, timeout: 1000 }).then(result => result.found, () => false)
        const after = await app.evaluate(() => (globalThis as any).automationPreview.probe.state())
        console.log("PROBE " + JSON.stringify({ variant, found, before: { guestFocused: before.guestFocused, windowFocused: before.windowFocused, focusedWindow: before.focusedWindow, page: before.page }, after }))
      } catch (error) {
        console.log("PROBE " + JSON.stringify({ variant, error: String(error).slice(0, 300) }))
      } finally {
        await app.close().catch(() => undefined)
      }
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
