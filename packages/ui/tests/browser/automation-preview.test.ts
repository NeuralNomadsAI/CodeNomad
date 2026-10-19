import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import { createRequire } from "node:module"
import { _electron, type ElectronApplication } from "playwright"

test("the shared engine drives a real Electron preview through the guarded native channel, without a visible window", { timeout: 90_000 }, async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "codenomad-preview-engine-"))
  let app: ElectronApplication | undefined
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html")
    response.end(`<!doctype html><main>
      <label>Title <input value="Prefilled"></label>
      <label>Plan <select><option value="custom">Flexible</option><option value="wayfinder">Exploration</option></select></label>
      <button id="confirm">Confirm</button><output id="result">Pending</output>
      <script>document.getElementById('confirm').addEventListener('click', () => {
        document.getElementById('result').textContent = document.querySelector('input').value + ':' + document.querySelector('select').value
      })</script></main>`)
  })
  t.after(async () => {
    try { await app?.close() }
    finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const guestURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  const bundle = path.join(profile, "engine.cjs")
  await build({ entryPoints: [fileURLToPath(new URL("fixtures/automation-preview-engine.ts", import.meta.url))],
    outfile: bundle, bundle: true, platform: "node", format: "cjs", external: ["electron"],
    define: { "import.meta.url": JSON.stringify(pathToFileURL(bundle).href) } })
  const env = { ...process.env, CODENOMAD_TEST_PROFILE: profile, CODENOMAD_TEST_AUTOMATION_BUNDLE: bundle, CODENOMAD_TEST_GUEST_URL: guestURL }
  delete env.ELECTRON_RUN_AS_NODE
  const executablePath = process.env.CODENOMAD_TEST_ELECTRON || createRequire(import.meta.url)("electron") as string
  app = await _electron.launch({ executablePath,
    args: ["--no-sandbox", fileURLToPath(new URL("fixtures/automation-preview-electron.cjs", import.meta.url))], env })
  const running = app
  const execute = (action: Record<string, unknown>) => running.evaluate(async (_electron, input) =>
    (globalThis as any).automationPreview.execute(input), action) as Promise<Record<string, any>>
  // The guest must load before a snapshot; no installed app or foreground window is involved.
  const page = await running.firstWindow()
  await page.waitForFunction(() => Boolean(document.querySelector("webview")))
  let outline = ""
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await running.evaluate(() => (globalThis as any).automationPreview?.ready())) {
      outline = String((await execute({ action: "snapshot" })).snapshot)
      if (outline.includes('textbox "Title"')) break
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const ref = (pattern: RegExp) => new RegExp(`${pattern.source}[^\\n]*?\\[(b\\d+e\\d+)\\]`).exec(outline)![1]
  const title = ref(/textbox "Title"/), plan = ref(/combobox "Plan"/), confirm = ref(/button "Confirm"/)
  assert.deepEqual((await execute({ action: "type", ref: title, text: "Pilot", clear: true })).value, "Pilot")
  assert.deepEqual((await execute({ action: "select", ref: plan, values: ["Exploration"] })).selected, ["Exploration"])
  await execute({ action: "click", ref: confirm })
  assert.equal((await execute({ action: "wait", text: "Pilot:wayfinder", gone: false, timeout: 1000 })).found, true)
  const scoped = await execute({ action: "snapshot", ref: plan })
  assert.match(scoped.snapshot, /option "Exploration".*selected/)
  await running.evaluate(() => (globalThis as any).automationPreview.visible(false))
  await assert.rejects(execute({ action: "click", ref: confirm }), /visible.*browser/i)
  await running.evaluate(() => (globalThis as any).automationPreview.visible(true))
  await running.evaluate(async (_electron, url) => (globalThis as any).automationPreview.navigate(url), `${guestURL}?next`)
  await assert.rejects(execute({ action: "click", ref: confirm }), /stale ref/)
})
