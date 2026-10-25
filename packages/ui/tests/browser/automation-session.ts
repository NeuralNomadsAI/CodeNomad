import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { chromium, type BrowserContext, type Page } from "playwright"
import { DeveloperCdp, type DeveloperCdpIdentity } from "../../../server/src/developer-cdp"
import { parsePageAction } from "../../../server/src/automation/page/parse"

/** A real Chromium with its DevTools endpoint, driven by the real codenomad.inspect/act
 * controller exactly as it drives the CodeNomad window. */
export async function launchAutomationBrowser() {
  const profile = await mkdtemp(path.join(os.tmpdir(), "codenomad-automation-"))
  const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined, locale: "en-US",
    args: ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"] })
  armFixtureNavigationBudget(context)
  let port = ""
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8").catch(() => "")).split(/\r?\n/, 1)[0]
    if (!port) await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(port, "Chromium published its DevTools port")
  return { context, endpoint: `http://127.0.0.1:${port}`, close: async () => { await context.close(); await rm(profile, { recursive: true, force: true }) } }
}

let windows = 0

/** A page that identifies as one CodeNomad window, and the controller pinned to it. */
export async function openAutomationPage(browser: { context: BrowserContext; endpoint: string }, url: string, setup?: (page: Page) => Promise<void>) {
  const windowId = `automation-window-${++windows}`
  const page = await browser.context.newPage()
  page.setDefaultTimeout(15_000)
  await page.addInitScript(`window.__CODENOMAD_WINDOW_ID__ = ${JSON.stringify(windowId)}`)
  await setup?.(page)
  await page.goto(url)
  const cdp = new DeveloperCdp({ timeoutMs: 10_000 })
  const identity: DeveloperCdpIdentity = { endpoint: browser.endpoint, runId: `run-${windowId}`, windowId }
  const refFor = async (pattern: RegExp, query?: string) => {
    const { snapshot } = await cdp.inspect(identity, query ? { query } : {})
    const match = new RegExp(`${pattern.source}[^\\n]*?\\[(e\\d+)\\]`).exec(snapshot)
    assert.ok(match, `${pattern} in:\n${snapshot}`)
    return match[1]
  }
  /** Tool-shaped input, validated by the same parser as codenomad.act. */
  const act = async (input: Record<string, unknown>) => cdp.act(identity, parsePageAction(input, "inspection")!)
  return { page, cdp, identity, refFor, act, close: async () => { cdp.close(); await page.close() } }
}
