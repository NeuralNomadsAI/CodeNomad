import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string

before(async () => {
  const fixture = await borrowFixture({
      name: "plugin-controls",
      routes: [
        { path: "/fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/plugin-controls.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})

after(async () => {
  await browser?.close()

})

test("V2 plugin controls load on demand and expose explicit Global and Project switches", async () => {
  const page = await browser.newPage({ viewport: { width: 520, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(url)

  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => (window as any).fixture.reads()), 0, "a hidden plugin section must not load")
  await page.evaluate(() => (window as any).fixture.show())
  await page.getByText("acme.reviewer", { exact: true }).waitFor()
  if (process.env.CODENOMAD_PLUGIN_SCREENSHOTS) {
    await mkdir(process.env.CODENOMAD_PLUGIN_SCREENSHOTS, { recursive: true })
    await page.screenshot({ path: join(process.env.CODENOMAD_PLUGIN_SCREENSHOTS, "plugins-initial.png"), fullPage: true })
  }
  assert.equal(await page.locator(".plugin-control-row").count(), 3)
  assert.equal(await page.locator('.plugin-control-row input[type="checkbox"]').count(), 6)
  assert.deepEqual(await page.locator(".plugin-control-scope-label").allTextContents(), ["Global", "Project"])
  assert.equal(await page.locator(".plugin-controls-description, .plugin-controls-footer, .plugin-control-sub, .plugin-controls-notice").count(), 0)
  assert.deepEqual(await page.locator(".plugin-controls-header button").evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label"))),
    ["Refresh plugin controls", "Add"], "only the compact Refresh and Add icons appear in the header")
  assert.ok(await page.locator(".plugin-control-identity button").count() > 0, "package rows expose a compact native update/check action")
  const refresh = page.getByRole("button", { name: "Refresh plugin controls", exact: true })
  assert.equal(await refresh.isEnabled(), true)
  assert.equal(await refresh.locator(".animate-spin").count(), 0)
  const readsBeforeRefresh = await page.evaluate(() => (window as any).fixture.reads())
  await page.evaluate(() => (window as any).fixture.holdRead())
  await refresh.click()
  await page.waitForFunction((before) => (window as any).fixture.reads() > before, readsBeforeRefresh)
  assert.equal(await refresh.isDisabled(), true)
  assert.equal(await refresh.getAttribute("aria-busy"), "true")
  assert.equal(await refresh.locator(".animate-spin").count(), 1)
  await page.evaluate(() => (window as any).fixture.releaseRead())
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".plugin-controls-header button")!.disabled)
  assert.equal(await refresh.locator(".animate-spin").count(), 0)
  assert.equal(await page.locator(".plugin-control-tooltip").count(), 0, "details stay out of the resting surface")
  await page.locator('[data-plugin-id="broken.plugin"] .plugin-control-name').hover()
  await page.locator(".plugin-control-tooltip").waitFor()
  assert.match(await page.locator(".plugin-control-tooltip").innerText(), /Failed — Setup failed safely/)
  await page.mouse.move(500, 800)
  await page.locator(".plugin-control-tooltip").waitFor({ state: "hidden" })
  assert.equal(await page.getByText("Runtime inventory", { exact: true }).count(), 0)
  assert.equal(await page.getByText("Configured entries", { exact: true }).count(), 0)
  assert.equal(await page.getByText("opencode.provider.demo", { exact: true }).count(), 0)
  assert.equal(await page.getByText("opencode.prompt.identity", { exact: true }).count(), 0)
  assert.equal(await page.locator('.plugin-control-row input[type="checkbox"]').first().isDisabled(), false)

  const inherited = page.locator('[data-plugin-id="broken.plugin"]')
  const inheritedGlobal = inherited.locator('[data-scope="global"] input[type="checkbox"]')
  const inheritedProject = inherited.locator('[data-scope="project"] input[type="checkbox"]')
  assert.equal(await inheritedGlobal.isChecked(), true)
  assert.equal(await inheritedProject.isChecked(), true)
  await inheritedProject.click()
  await page.waitForFunction(() => (window as any).fixture.calls.some((call: any) => (
    call.type === "mutation" && call.pluginId === "broken.plugin"
      && call.scope === "project" && call.enabled === false
  )))
  assert.equal(await inheritedGlobal.isChecked(), true, "a Project override must not change the Global switch")
  assert.equal(await inheritedProject.isChecked(), false)

  const sleeping = page.locator('[data-plugin-id="sleeping.plugin"]')
  const globalToggle = sleeping.locator('[data-scope="global"] input[type="checkbox"]')
  const projectToggle = sleeping.locator('[data-scope="project"] input[type="checkbox"]')
  assert.equal(await globalToggle.isChecked(), true)
  assert.equal(await projectToggle.isChecked(), false)
  await projectToggle.click()
  await page.waitForFunction(() => (window as any).fixture.calls.some((call: any) => (
    call.type === "mutation" && call.pluginId === "sleeping.plugin"
      && call.scope === "project" && call.enabled === true
  )))
  assert.equal(await projectToggle.isChecked(), true)

  const acmeGlobal = page.locator('[data-plugin-id="acme.reviewer"] [data-scope="global"] input[type="checkbox"]')
  await acmeGlobal.click()
  await page.waitForFunction(() => (window as any).fixture.calls.some((call: any) => (
    call.type === "mutation" && call.pluginId === "acme.reviewer"
      && call.scope === "global" && call.enabled === false
  )))

  const switchGeometry = await page.evaluate(() => {
    const track = document.querySelector(".plugin-control-row .MuiSwitch-track")!
    const root = document.querySelector(".plugin-control-row .MuiSwitch-root") as HTMLElement | null
    const box = (root ?? track as HTMLElement).getBoundingClientRect()
    return { radius: getComputedStyle(track).borderRadius, width: Math.round(box.width), height: Math.round(box.height) }
  })
  assert.notEqual(switchGeometry.radius, "0px")
  assert.deepEqual([switchGeometry.width, switchGeometry.height], [40, 24])

  const readsBeforeSessionChange = await page.evaluate(() => (window as any).fixture.reads())
  await page.evaluate(() => (window as any).fixture.switchSession())
  await page.waitForTimeout(100)
  assert.equal(
    await page.evaluate(() => (window as any).fixture.reads()),
    readsBeforeSessionChange,
    "another session in the same worktree must reuse the snapshot",
  )

  const readsBeforeActivation = await page.evaluate(() => (window as any).fixture.reads())
  await page.evaluate(() => (window as any).fixture.hide())
  await page.waitForFunction(() => !(window as any).fixture.isActive())
  await page.evaluate(() => (window as any).fixture.activateSleepingPlugin())
  await page.waitForTimeout(100)
  assert.equal(
    await page.evaluate(() => (window as any).fixture.reads()),
    readsBeforeActivation,
    "events must not refresh a hidden plugin section",
  )
  await page.evaluate(() => (window as any).fixture.show())
  await page.waitForFunction((before) => (window as any).fixture.reads() > before, readsBeforeActivation)
  const burstReads = await page.evaluate(() => (window as any).fixture.eventBurst())
  assert.equal(burstReads, 2, "an in-flight event burst must coalesce into one trailing refresh")
  assert.deepEqual(errors, [])
  await page.close()
})

test("failed packages without IDs remain actionable and reconcile into loaded plugin rows", async () => {
  const page = await browser.newPage({ viewport: { width: 380, height: 600 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(url)
    await page.evaluate(() => { (window as any).fixture.failedPackagesOnly(); (window as any).fixture.setNarrow(); (window as any).fixture.show() })
    const target = "opencode-gemini-auth@latest"
    const row = page.locator(`[data-package-target="${target}"]`)
    await row.waitFor()
    assert.equal(await page.locator(".plugin-control-row").count(), 2, "duplicate native targets share one recovery row")
    assert.equal(await page.locator('.plugin-control-row input[type="checkbox"]').count(), 0, "a package target must never be used as an activation ID")
    await row.locator(".plugin-control-name").focus()
    await page.locator(".plugin-control-tooltip").waitFor()
    assert.match(await page.locator(".plugin-control-tooltip").innerText(), /Failed — Package failed before exporting a plugin ID/)
    await row.getByRole("button", { name: `Actions for ${target}`, exact: true }).click()
    await page.getByRole("menuitem", { name: `Check updates for ${target}`, exact: true }).click()
    const update = row.getByRole("button", { name: `Actions for ${target}`, exact: true })
    await update.waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    if (process.env.CODENOMAD_PLUGIN_SCREENSHOTS) {
      await mkdir(process.env.CODENOMAD_PLUGIN_SCREENSHOTS, { recursive: true })
      await page.screenshot({ path: join(process.env.CODENOMAD_PLUGIN_SCREENSHOTS, "plugins-failed-packages.png"), fullPage: true })
    }
    await update.click()
    await page.getByRole("menuitem", { name: `Update ${target}`, exact: true }).click()
    await page.locator('[data-plugin-id="recovered.plugin"]').waitFor()
    assert.equal(await row.count(), 0, "successful native loading replaces the package-only row")
    assert.equal(await page.locator(".plugin-control-row").count(), 2)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.calls.filter((call: any) => ["check", "update"].includes(call.type))), [
      { type: "check", location: { directory: "/repo" }, target },
      { type: "update", location: { directory: "/repo" }, targets: [target] },
    ])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("V2 plugin controls disable Project when it resolves to the Global document", async () => {
  const page = await browser.newPage({ viewport: { width: 520, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(url)

  await page.evaluate(() => (window as any).fixture.setTargets(["global"]))
  await page.evaluate(() => (window as any).fixture.show())
  await page.getByText("acme.reviewer", { exact: true }).waitFor()

  const row = page.locator('[data-plugin-id="acme.reviewer"]')
  assert.equal(await row.locator('[data-scope="global"] input[type="checkbox"]').isDisabled(), false)
  assert.equal(await row.locator('[data-scope="project"] input[type="checkbox"]').isDisabled(), true)
  const projectDescription = await row.locator('[data-scope="project"] input').getAttribute("aria-describedby")
  const noticeId = projectDescription?.split(" ").find((id) => id.endsWith("-notice"))
  assert.ok(noticeId)
  assert.equal(await page.locator(`[id="${noticeId}"]`).getAttribute("class"), "sr-only")
  assert.ok(projectDescription?.split(" ").includes(noticeId))
  assert.equal(await page.evaluate((ids) => ids!.split(" ").every(id => Boolean(document.getElementById(id))), projectDescription), true)
  assert.ok(!(await row.locator('[data-scope="global"] input').getAttribute("aria-describedby"))?.split(" ").includes(noticeId))

  const mutationsBefore = await page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.type === "mutation").length)
  await row.locator('[data-scope="project"] input[type="checkbox"]').click({ force: true })
  await page.waitForTimeout(200)
  assert.equal(
    await page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.type === "mutation").length),
    mutationsBefore,
    "a disabled Project switch must not mutate",
  )

  await page.evaluate(() => (window as any).fixture.setNarrow())
  await page.waitForTimeout(100)
  const narrowLane = await row.locator('[data-scope="global"]').boundingBox()
  assert.ok((narrowLane?.width ?? 48) <= 40, "narrow panels compact the switch lanes")
  await row.locator(".plugin-control-name").focus()
  await page.locator(".plugin-control-tooltip").waitFor()
  assert.match(await page.locator(".plugin-control-tooltip").innerText(), /Project controls are unavailable/)
  await row.locator("input").first().focus()
  await page.locator(".plugin-control-tooltip").waitFor({ state: "hidden" })
  if (process.env.CODENOMAD_PLUGIN_SCREENSHOTS) {
    await mkdir(process.env.CODENOMAD_PLUGIN_SCREENSHOTS, { recursive: true })
    await page.screenshot({ path: join(process.env.CODENOMAD_PLUGIN_SCREENSHOTS, "plugins-unavailable-narrow.png"), fullPage: true })
  }
  assert.deepEqual(errors, [])
  await page.close()
})

test("plugin rows retain focus through passive refresh and guarded pending mutations", async () => {
  const page = await browser.newPage({ viewport: { width: 520, height: 900 } })
  await page.goto(url)
  await page.evaluate(() => (window as any).fixture.show())
  const input = page.locator('[data-plugin-id="acme.reviewer"] [data-scope="global"] input')
  await input.waitFor()
  await input.focus()
  const original = await input.elementHandle()
  await page.evaluate(() => (window as any).fixture.eventBurst())
  assert.equal(await original!.evaluate((node) => node.isConnected && node === document.activeElement), true)

  await page.evaluate(() => (window as any).fixture.holdMutation())
  await input.press("Space")
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-busy") === "true")
  assert.equal(await input.isChecked(), true, "pending state retains the authoritative value")
  await input.press("Space")
  assert.equal(await page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.type === "mutation").length), 1)
  assert.equal(await input.isChecked(), true, "blocked repeat activation must not visually toggle")
  await input.click({ force: true })
  assert.equal(await page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.type === "mutation").length), 1)
  assert.equal(await input.isChecked(), true, "blocked pointer activation must not visually toggle")
  await page.evaluate(() => (window as any).fixture.releaseMutation())
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-busy") === "false")
  assert.equal(await original!.evaluate((node) => node.isConnected && node === document.activeElement), true)
  assert.equal(await input.isChecked(), false)
  await input.press("Tab")
  assert.equal(await page.locator('[data-plugin-id="acme.reviewer"] [data-scope="project"] input').evaluate((node) => node === document.activeElement), true)
  await input.focus()
  await page.evaluate(() => { (window as any).fixture.holdMutation(); (window as any).fixture.failMutation() })
  await input.press("Space")
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-busy") === "true")
  await page.evaluate(() => (window as any).fixture.releaseMutation())
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-busy") === "false")
  assert.equal(await original!.evaluate((node) => node.isConnected && node === document.activeElement), true)
  assert.equal(await input.isChecked(), false, "failed mutation retains the authoritative value")
  await page.close()
})

test("narrow layouts keep rows compact and reveal complete details on name focus", async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 1200 }, hasTouch: true })
  await page.goto(url)
  const details = await page.evaluate(() => {
    const fixture = (window as any).fixture
    fixture.setNarrow()
    const details = fixture.setLongDetails()
    fixture.show()
    return details
  })
  const row = page.locator(`[data-plugin-id="${details.id}"]`)
  await row.waitFor()
  for (const direction of ["ltr", "rtl"]) {
    await page.evaluate((locale) => (window as any).fixture.setLocale(locale), direction === "rtl" ? "he" : "fr")
    await page.locator(".plugin-control-scope-label").filter({ hasText: direction === "rtl" ? "פרויקט" : "Projet" }).waitFor()
    await page.evaluate((dir) => { document.documentElement.dir = dir }, direction)
    await row.locator(".plugin-control-name").focus()
    await page.locator(".plugin-control-tooltip").waitFor()
    const tooltip = page.locator(".plugin-control-tooltip")
    assert.ok((await tooltip.innerText()).includes(details.id))
    assert.ok((await tooltip.innerText()).includes(details.source))
    assert.equal(await tooltip.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true)
    await page.locator('[data-plugin-id="broken.plugin"] .plugin-control-name').focus()
    await page.waitForFunction((error) => [...document.querySelectorAll('[role="tooltip"]')].some((node) => node.textContent?.includes(error)), details.error)
    await row.locator("input").first().focus()
    await page.locator(".plugin-control-tooltip").waitFor({ state: "hidden" })
    assert.ok((await row.boundingBox())!.height <= 36, "long identities must not enlarge a compact row")
    assert.equal(await page.locator("main").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true)
    if (direction === "ltr") assert.deepEqual(await page.locator(".plugin-control-scope-label").allTextContents(), ["Global", "Projet"])
    if (process.env.CODENOMAD_PLUGIN_SCREENSHOTS) {
      await mkdir(process.env.CODENOMAD_PLUGIN_SCREENSHOTS, { recursive: true })
      await page.screenshot({ path: join(process.env.CODENOMAD_PLUGIN_SCREENSHOTS, `plugins-narrow-${direction}.png`), fullPage: true })
    }
  }
  await page.close()
})

for (const fail of [false, true]) {
  test(`disposed plugin surfaces suppress late mutation feedback, failure=${fail}`, async () => {
    const page = await browser.newPage({ viewport: { width: 520, height: 900 } })
    await page.goto(url)
    await page.evaluate((fail) => {
      const fixture = (window as any).fixture
      fixture.show()
      fixture.holdMutation()
      if (fail) fixture.failMutation()
    }, fail)
    const input = page.locator('[data-plugin-id="acme.reviewer"] [data-scope="project"] input')
    await input.click()
    await page.waitForFunction(() => document.querySelector('input[aria-busy="true"]'))
    await page.evaluate(() => (window as any).fixture.unmount())
    assert.equal(await page.locator(".plugin-controls").count(), 0)
    await page.evaluate(() => (window as any).fixture.releaseMutation())
    // Flush the deferred response and its async presentation continuation.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)))
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.toastHistory()), [])
    await page.close()
  })
}

for (const dispose of [false, true]) {
  test(`queued plugin reads wait for visible demand after hiding, disposed=${dispose}`, async () => {
    const page = await browser.newPage({ viewport: { width: 520, height: 900 } })
    await page.goto(url)
    await page.evaluate(() => (window as any).fixture.show())
    await page.locator('[data-plugin-id="acme.reviewer"]').waitFor()
    await page.evaluate(() => { (window as any).fixture.holdRead(); (window as any).fixture.invalidate() })
    await page.waitForFunction(() => (window as any).fixture.reads() === 2)
    await page.evaluate(() => (window as any).fixture.invalidate())
    await page.evaluate((dispose) => {
      const fixture = (window as any).fixture
      if (dispose) fixture.unmount()
      else fixture.hide()
      fixture.releaseRead()
    }, dispose)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)))
    assert.equal(await page.evaluate(() => (window as any).fixture.reads()), 2, "a queued read must not start after demand is withdrawn")
    await page.evaluate((dispose) => {
      const fixture = (window as any).fixture
      if (dispose) fixture.remount()
      else fixture.show()
    }, dispose)
    await page.waitForFunction(() => (window as any).fixture.reads() === 3)
    await page.locator('[data-plugin-id="acme.reviewer"]').waitFor()
    await page.close()
  })
}

test("healthy managed plugins stay out of all ordinary row routes while homonyms remain controllable", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(url)
    await page.evaluate(() => { (window as any).fixture.systemPlugins("active"); (window as any).fixture.show() })
    await page.locator('[data-plugin-id="codenomad.third-party"]').waitFor()
    assert.equal(await page.locator(".plugin-system-attention").count(), 0)
    assert.equal(await page.locator('[data-plugin-id="codenomad.design"], [data-package-target], [data-source-target]').count(), 0)
    assert.equal(await page.locator('.plugin-control-row input[type="checkbox"]').count(), 4)
    await page.locator('[data-plugin-id="codenomad.third-party"] [data-scope="project"] input').click()
    await page.waitForFunction(() => (window as any).fixture.calls.some((call: any) => call.type === "mutation" && call.pluginId === "codenomad.third-party"))
  } finally { await page.close() }
})

test("unproven and third-party no-ID local failures retain ordinary native-path rows", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(url)
    await page.evaluate(() => { (window as any).fixture.ordinaryLocalFailure(); (window as any).fixture.show() })
    await page.locator('[data-local-path="/thirdparty/plugin.ts"]').waitFor()
    assert.equal(await page.locator(".plugin-control-row").count(), 2)
    assert.equal(await page.locator(".plugin-system-attention").count(), 0)
    assert.equal(await page.locator('.plugin-control-row input[type="checkbox"]').count(), 0)
    for (const path of ["/thirdparty/plugin.ts", "/daemon/plugins/codenomad-design.js"]) {
      const row = page.locator(`[data-local-path="${path}"]`)
      assert.equal(await row.locator(".plugin-control-name").innerText(), path)
      await row.locator(".plugin-control-name").focus()
      await page.locator(".plugin-control-tooltip").waitFor()
      assert.match(await page.locator(".plugin-control-tooltip").innerText(), /Unproven local plugin load failed/)
      assert.match(await page.locator(".plugin-control-tooltip").innerText(), /err_local_native/)
      await page.locator("[data-plugin-refresh]").focus()
      await page.locator(".plugin-control-tooltip").waitFor({ state: "hidden" })
    }
  } finally { await page.close() }
})

for (const [ruleScope, expectedScope, writable] of [
  ["global", "global", ["global", "project"]],
  ["project", "project", ["global", "project"]],
  ["other", "project", ["global", "project"]],
  ["global", "project", ["project"]],
] as const) {
  test(`managed re-enable uses one exact positive rule: ${ruleScope} -> ${expectedScope}, targets=${writable}`, async () => {
    const page = await browser.newPage()
    try {
      await page.goto(url)
      await page.evaluate(({ ruleScope, writable }) => {
        const fixture = (window as any).fixture
        fixture.systemPlugins("disabled", ruleScope, false)
        fixture.setTargets(writable)
        fixture.holdMutation()
        fixture.show()
      }, { ruleScope, writable })
      const notice = page.getByRole("status", { name: "CodeNomad plugins need attention", exact: true })
      await notice.waitFor()
      assert.equal(await notice.getAttribute("aria-live"), "polite")
      const heading = await notice.getAttribute("aria-labelledby")
      assert.ok(heading)
      assert.equal(await page.locator(`[id="${heading}"]`).count(), 1)
      assert.equal(await notice.evaluate(node => Boolean(node.nextElementSibling?.classList.contains("plugin-controls-header"))), true)
      assert.equal(await page.locator(".plugin-control-row").count(), 0)
      assert.equal(await notice.locator(".plugin-system-attention-label bdi").innerText(), "codenomad.design")
      if (expectedScope !== ruleScope) {
        assert.equal(await notice.locator(".plugin-system-attention-scope").innerText(), "Project", "the override scope is visible when it differs from the disabling rule")
      } else {
        assert.equal(await notice.locator(".plugin-system-attention-scope").count(), 0, "matching action and rule scopes stay terse")
      }
      const info = notice.getByRole("button", { name: "Details for codenomad.design", exact: true })
      await info.click()
      await page.locator(".plugin-system-attention-details").waitFor()
      const configPath = ruleScope === "global" ? "/daemon/opencode.jsonc" : ruleScope === "project" ? "/repo/.opencode/opencode.jsonc" : "/ancestor/opencode.jsonc"
      assert.ok((await page.locator(".plugin-system-attention-details bdi").allTextContents()).includes(configPath))
      await page.keyboard.press("Escape")
      await page.locator(".plugin-system-attention-details").waitFor({ state: "hidden" })
      const button = notice.getByRole("button", { name: `Re-enable codenomad.design in ${expectedScope === "global" ? "Global" : "Project"}`, exact: true })
      await button.focus()
      const original = await button.elementHandle()
      await button.press("Enter")
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-busy") === "true")
      assert.equal(await button.getAttribute("aria-disabled"), "true")
      assert.equal(await button.evaluate(node => (node as HTMLButtonElement).disabled), false, "the busy button keeps keyboard focus")
      await button.press("Enter")
      await button.click({ force: true })
      assert.equal(await original!.evaluate(node => node.isConnected && node === document.activeElement), true)
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.type === "mutation")), [
        { type: "mutation", location: { directory: "/repo" }, pluginId: "codenomad.design", scope: expectedScope, enabled: true },
      ])
      await page.evaluate(() => (window as any).fixture.releaseMutation())
      await notice.getByText("codenomad.design — Loading not confirmed", { exact: true }).waitFor()
      assert.equal(await notice.getByRole("button", { name: /^Re-enable / }).count(), 0)
      await page.waitForFunction(() => document.activeElement?.hasAttribute("data-plugin-refresh"))
      // Focus inside the warning when runtime confirmation removes the whole block.
      await notice.locator(".plugin-system-attention-entry").evaluate(node => { node.setAttribute("tabindex", "-1"); (node as HTMLElement).focus() })
      await page.evaluate(() => (window as any).fixture.activateSystemPlugin())
      await notice.waitFor({ state: "detached" })
      await page.waitForFunction(() => document.activeElement?.hasAttribute("data-plugin-refresh"))
      assert.equal(await page.locator('[data-plugin-id="codenomad.design"]').count(), 0)
    } finally { await page.close() }
  })
}

for (const mode of ["failed", "failed-no-id"] as const) {
  test(`managed native failures expose details without activation or ordinary actions: ${mode}`, async () => {
    const page = await browser.newPage({ viewport: { width: 320, height: 600 } })
    try {
      await page.goto(url)
      await page.evaluate(mode => { (window as any).fixture.systemPlugins(mode, "project", false); (window as any).fixture.setNarrow(); (window as any).fixture.show() }, mode)
      const notice = page.getByRole("status", { name: "CodeNomad plugins need attention", exact: true })
      await notice.waitFor()
      const name = mode === "failed" ? "codenomad.design" : "@codenomad/design@1.0.0"
      assert.equal(await notice.getByRole("button", { name: /^Re-enable / }).count(), 0)
      assert.equal(await page.locator(".plugin-control-row").count(), 0)
      assert.equal(await notice.locator(".plugin-system-attention-label").innerText(), `${name} — Failed to load`)
      assert.equal(await notice.locator(".plugin-system-attention-label bdi").innerText(), name)
      assert.equal(await notice.locator(".plugin-system-attention-scope").innerText(), "Global")
      const details = notice.getByRole("button", { name: `Details for ${name}`, exact: true })
      await details.focus()
      await details.press("Enter")
      await page.getByText("Native system plugin failed safely", { exact: false }).waitFor()
      assert.match(await page.locator(".info-popover-text").innerText(), /err_system_native/)
      assert.match(await page.locator(".info-popover-text").innerText(), /Error reference in the OpenCode log: err_system_native/)
      const isolated = await page.locator(".plugin-system-attention-details bdi").allTextContents()
      for (const value of [name, "@codenomad/design@1.0.0", "/daemon/opencode.jsonc", "err_system_native"]) assert.ok(isolated.includes(value))
      await page.keyboard.press("Escape")
      await page.waitForFunction(label => document.activeElement?.getAttribute("aria-label") === label, `Details for ${name}`)
      assert.equal(await details.evaluate(node => node === document.activeElement), true)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.evaluate(() => (window as any).fixture.activateSystemPlugin())
      await notice.waitFor({ state: "detached" })
      await page.waitForFunction(() => document.activeElement?.hasAttribute("data-plugin-refresh"))
    } finally { await page.close() }
  })
}

test("managed mutation failures retain the warning and announce a new error across passive refresh", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(url)
    await page.evaluate(() => {
      const fixture = (window as any).fixture
      fixture.systemPlugins("disabled", "global", false)
      fixture.failMutation()
      fixture.show()
    })
    const notice = page.getByRole("status", { name: "CodeNomad plugins need attention", exact: true })
    const button = notice.getByRole("button", { name: "Re-enable codenomad.design in Global", exact: true })
    await button.click()
    await notice.getByRole("alert").waitFor()
    assert.match(await notice.getByRole("alert").innerText(), /codenomad.design/)
    assert.equal(await button.getAttribute("aria-busy"), "false")
    await page.evaluate(() => (window as any).fixture.invalidate())
    await page.waitForFunction(() => (window as any).fixture.reads() === 2)
    assert.equal(await notice.getByRole("alert").count(), 1)
    assert.match(await notice.innerText(), /Disabled in Global/)
    await button.click()
    await notice.getByText("codenomad.design — Loading not confirmed", { exact: true }).waitFor()
    assert.equal(await notice.getByRole("alert").count(), 0)
  } finally { await page.close() }
})

test("managed pre-write active inventory stays unconfirmed after re-enable until a native-event read", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(url)
    await page.evaluate(() => { (window as any).fixture.systemPlugins("disabled-active", "project", false); (window as any).fixture.show() })
    const notice = page.getByRole("status", { name: "CodeNomad plugins need attention", exact: true })
    await notice.getByRole("button", { name: "Re-enable codenomad.design in Project", exact: true }).click()
    await notice.getByText("codenomad.design — Loading not confirmed", { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => (window as any).fixture.reads()), 1, "a write response does not confirm runtime loading")
    await page.evaluate(() => (window as any).fixture.invalidate())
    await notice.waitFor({ state: "detached" })
    assert.equal(await page.evaluate(() => (window as any).fixture.reads()), 2)
  } finally { await page.close() }
})

test("managed pre-write failure stays unconfirmed until a fresh native failure is observed", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(url)
    await page.evaluate(() => { (window as any).fixture.systemPlugins("disabled-failed", "project", false); (window as any).fixture.show() })
    const notice = page.getByRole("status", { name: "CodeNomad plugins need attention", exact: true })
    await notice.getByRole("button", { name: "Re-enable codenomad.design in Project", exact: true }).click()
    await notice.getByText("codenomad.design — Loading not confirmed", { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => (window as any).fixture.reads()), 1)
    await page.evaluate(() => (window as any).fixture.invalidate())
    await notice.getByText("codenomad.design — Failed to load", { exact: true }).waitFor()
    assert.equal(await notice.getByRole("button", { name: /^Re-enable / }).count(), 0)
    await notice.getByRole("button", { name: "Details for codenomad.design", exact: true }).click()
    await page.getByText("Native system plugin failed safely", { exact: false }).waitFor()
    assert.match(await page.locator(".info-popover-text").innerText(), /err_system_native/)
  } finally { await page.close() }
})

test("managed runtime confirmation restores Refresh focus from an open details portal", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(url)
    await page.evaluate(() => { (window as any).fixture.systemLocalFailure(true); (window as any).fixture.show() })
    const notice = page.getByRole("status", { name: "CodeNomad plugins need attention", exact: true })
    await notice.getByRole("button", { name: "Details for codenomad.design", exact: true }).click()
    await page.waitForFunction(() => Boolean(document.activeElement?.closest(".info-popover-content")))
    await page.evaluate(() => (window as any).fixture.activateSystemPlugin())
    await notice.waitFor({ state: "detached" })
    await page.locator(".plugin-system-attention-details").waitFor({ state: "detached" })
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-plugin-refresh"))
  } finally { await page.close() }
})

for (const attached of [true, false]) {
  test(`managed no-ID local failures use proven identity or exact path without duplicate warnings, attached=${attached}`, async () => {
    const page = await browser.newPage()
    try {
      await page.goto(url)
      await page.evaluate(attached => { (window as any).fixture.systemLocalFailure(attached); (window as any).fixture.show() }, attached)
      const notice = page.getByRole("status", { name: "CodeNomad plugins need attention", exact: true })
      await notice.waitFor()
      assert.equal(await notice.locator(".plugin-system-attention-entry").count(), 1)
      const name = attached ? "codenomad.design" : "/daemon/plugins/codenomad-design.js"
      assert.equal(await notice.locator(".plugin-system-attention-label").innerText(), `${name} — Failed to load`)
      assert.equal(await notice.locator(".plugin-system-attention-label bdi").innerText(), name)
      assert.equal(await notice.locator(".plugin-system-attention-scope").innerText(), "Global")
      assert.equal(await notice.getByRole("button", { name: /^Re-enable / }).count(), 0)
      await notice.getByRole("button", { name: `Details for ${name}`, exact: true }).click()
      await page.getByText("Native system plugin failed safely", { exact: false }).waitFor()
      assert.match(await page.locator(".info-popover-text").innerText(), /err_system_native/)
      assert.ok((await page.locator(".plugin-system-attention-details bdi").allTextContents()).includes("/daemon/plugins/codenomad-design.js"))
    } finally { await page.close() }
  })
}

for (const mode of ["unconfirmed", "source-only"] as const) {
  test(`managed loading stays unconfirmed outside ordinary lists: ${mode}`, async () => {
    const page = await browser.newPage()
    try {
      await page.goto(url)
      await page.evaluate(mode => { (window as any).fixture.systemPlugins(mode, "project", false); (window as any).fixture.show() }, mode)
      const notice = page.getByRole("status", { name: "CodeNomad plugins need attention", exact: true })
      await notice.waitFor()
      assert.match(await notice.innerText(), /Loading not confirmed/)
      assert.equal(await page.locator(".plugin-control-row").count(), 0)
      assert.equal(await notice.getByRole("button", { name: /^Re-enable / }).count(), 0)
      assert.equal(await notice.getByRole("button").count(), 1, "every affected plugin has one information button")
      assert.equal(await notice.locator(".plugin-system-attention-scope").innerText(), "Global")
      const name = mode === "unconfirmed" ? "codenomad.design" : "@codenomad/design@1.0.0"
      assert.equal(await notice.locator(".plugin-system-attention-label bdi").innerText(), name)
      await notice.getByRole("button", { name: `Details for ${name}`, exact: true }).click()
      await page.locator(".plugin-system-attention-details").waitFor()
      assert.ok((await page.locator(".plugin-system-attention-details bdi").allTextContents()).includes("/daemon/opencode.jsonc"))
      await page.keyboard.press("Escape")
      await page.evaluate(() => { document.documentElement.dir = "rtl"; return (window as any).fixture.setLocale("he") })
      assert.equal(await page.locator(".plugin-system-attention-label bdi").innerText(), name)
      assert.equal(await page.locator(".plugin-system-attention-label bdi").getAttribute("dir"), null, "bdi retains native automatic isolation")
    } finally { await page.close() }
  })
}

for (const mode of ["failed", "unconfirmed"] as const) {
  test(`managed installation without configured scope prefers the Global installation target: ${mode}`, async () => {
    const page = await browser.newPage()
    try {
      await page.goto(url)
      await page.evaluate(mode => {
        const fixture = (window as any).fixture
        fixture.systemPlugins(mode, "project", false)
        fixture.clearSystemConfiguration()
        fixture.show()
      }, mode)
      const notice = page.getByRole("status", { name: "CodeNomad plugins need attention", exact: true })
      await notice.waitFor()
      assert.equal(await notice.locator(".plugin-system-attention-scope").innerText(), "Global")
      await notice.getByRole("button", { name: "Details for codenomad.design", exact: true }).click()
      await page.locator(".plugin-system-attention-details").waitFor()
      const paths = await page.locator(".plugin-system-attention-details bdi").allTextContents()
      assert.ok(paths.includes("/daemon/opencode.jsonc"))
      assert.ok(!paths.includes("/repo/.opencode/opencode.jsonc"), "available Project writes do not imply Project installation provenance")
    } finally { await page.close() }
  })
}
