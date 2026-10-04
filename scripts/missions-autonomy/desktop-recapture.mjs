import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { chromium } from "playwright"

// Read-only recapture of the already completed, owned empirical Mission.
// Native debugging transport is provisioned by the scoped desktop itself.
const root = "C:/Users/Admin/AppData/Local/Temp/opencode/missions-desktop-trial-20261003"
const artifactRoot = path.resolve("packages/tauri-app/target/release")
const portFile = path.join(process.env.LOCALAPPDATA,
  "ai.neuralnomads.codenomad.client-v2/scopes/missions-empirical-760fb808c6ee361b/developer-mode/local/EBWebView/DevToolsActivePort")
const port = (await readFile(portFile, "utf8")).split("\n")[0].trim()
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const page = browser.contexts().flatMap(context => context.pages()).find(item => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(item.url()))
assert(page, "Owned scoped empirical native window")
const receipt = { root, artifact: path.join(artifactRoot, "codenomad-tauri.exe"),
  time: new Date().toISOString(), providerRequests: 0, missionReplayed: false }
try {
  await page.getByRole("tab", { name: /product-project/, selected: true }).waitFor({ timeout: 30000 })
  const missions = page.getByRole("tab", { name: "Missions", exact: true })
  if (await missions.getAttribute("aria-selected") !== "true") await missions.click()
  // Startup can display an unavailable snapshot before native provisioning
  // completes. Exercise its existing explicit read refresh, never location.reload.
  const unavailable = page.getByText("Le centre de mission est indisponible", { exact: true })
  if (await unavailable.isVisible()) {
    receipt.explicitSnapshotRefresh = true
    await page.getByRole("button", { name: "Actualiser la carte de mission", exact: true }).click()
  }
  await page.getByText("Validate recursive native Missions through the compiled desktop", { exact: true }).first().waitFor({ timeout: 30000 })
  const task = page.locator('.mission-route-task[data-task-key="check-result"]')
  await task.waitFor()
  const disclosure = task.locator('button[aria-expanded]').first()
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click()
  await task.getByText("Bilan des résultats par le coordinateur ; aucune notification n’est envoyée.", { exact: true }).waitFor()
  assert.equal(await task.locator("[data-notification]").count(), 0)
  receipt.readoutWithoutNotificationStatus = true
  await page.screenshot({ path: `${root}/corrected-readout.png` })
  await page.getByRole("button", { name: "Ouvrir le coordinateur", exact: true }).click()
  await page.getByText("484", { exact: false }).first().waitFor({ timeout: 20000 })
  const childTask = page.locator('.tool-call[data-tool="subagent"], .tool-call[data-tool="task"]')
  // Native tool metadata and renderer aliases may differ. Identify the actual
  // task renderer surface, without reading/modifying application store internals.
  let taskShell = childTask.first()
  if (!await taskShell.count()) taskShell = page.locator('.tool-call').filter({ has: page.locator('.tool-call-task-sections') }).first()
  if (!await taskShell.count()) {
    const buttons = page.locator('.tool-call-header-toggle').filter({ hasText: /mission_trial|Validate|484|calcul|subagent/ })
    if (await buttons.count()) await buttons.first().click()
    taskShell = page.locator('.tool-call').filter({ has: page.locator('.tool-call-task-sections') }).first()
  }
  await taskShell.waitFor({ timeout: 20000 })
  const toggle = taskShell.locator(':scope > .tool-call-header > .tool-call-header-toggle')
  if (await toggle.count() && await toggle.getAttribute("aria-expanded") === "false") await toggle.click()
  const stepCount = taskShell.locator('.tool-call-task-section-meta').filter({ hasText: /étapes/ }).first()
  await stepCount.waitFor({ timeout: 20000 })
  assert.equal((await stepCount.textContent())?.trim(), "1 étapes")
  assert(!(await taskShell.innerText()).includes("200+"))
  receipt.observedOneStep = true
  receipt.answer484Visible = true
  await page.screenshot({ path: `${root}/corrected-steps.png` })
  const hash = async file => createHash("sha256").update(await readFile(file)).digest("hex")
  receipt.artifactSha256 = await hash(receipt.artifact)
  receipt.publicIndexSha256 = await hash(path.join(artifactRoot, "resources/server/public/index.html"))
  assert.equal(receipt.publicIndexSha256, await hash("packages/server/public/index.html"))
  receipt.status = "passed"
} catch (error) {
  receipt.status = "failed"
  receipt.error = error.message ?? String(error)
  await page.screenshot({ path: `${root}/corrected-ui-failure.png` }).catch(() => {})
  await writeFile(`${root}/corrected-ui-text.txt`, await page.locator("body").innerText().catch(() => ""))
  process.exitCode = 1
} finally {
  await writeFile(`${root}/corrected-ui-result.json`, JSON.stringify(receipt, null, 2))
  await browser.close()
  console.log(`${receipt.status.toUpperCase()} corrected native UI recapture: ${root}`)
  if (receipt.error) console.error(receipt.error)
}
