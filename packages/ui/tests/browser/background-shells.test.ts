import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let fixture: { browser: Awaited<ReturnType<typeof chromium.launch>>; url: string; close(): Promise<void> }
before(async () => {
  const page = await borrowFixture({ name: "background-shells", routes: [{ path: "/fixture", html:
    '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/background-shells.tsx"></script></body></html>' },
    { path: "/ansi", html: `<html><body><div id="root"></div><script type="module">
      import { createComponent, createSignal } from "solid-js";
      import { render } from "solid-js/web";
      import { ConfigProvider } from "/src/stores/preferences";
      import { I18nProvider } from "/src/lib/i18n";
      import { ThemeProvider } from "/src/lib/theme";
      import { serverApi } from "/src/lib/api-client";
      import { bashRenderer } from "/src/components/tool-call/renderers/bash";
      import "/src/index.css";
      serverApi.fetchConfigOwner = async () => ({ settings: { locale: "en" } });
      serverApi.fetchStateOwner = async () => ({});
      const [state, setState] = createSignal({ status: "running", input: {}, metadata: { output: "initial" } });
      render(() => createComponent(ConfigProvider, { get children() {
        return createComponent(I18nProvider, { get children() {
          return createComponent(ThemeProvider, { get children() {
            return bashRenderer.renderBody({ toolState: state, renderMarkdown: () => null, textRevealTarget: () => undefined });
          } });
        } });
      } }), document.getElementById("root"));
      window.ansiFixture = { setState };
    </script></body></html>` }] })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  fixture = { browser, url: page.url, close: () => browser.close() }
})
after(async () => { await fixture?.close() })

for (const initiallyUnavailable of [false, true]) test(`a WSL project without a selected conversation refreshes on native/host events (initial failure: ${initiallyUnavailable})`, async () => {
  const page = await fixture.browser.newPage({ locale: "en-US" })
  const host = "\\\\wsl.localhost\\Ubuntu\\home\\user\\repo", native = "/home/user/repo"
  let present = false
  let failInitialRead = initiallyUnavailable
  try {
    await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
    await page.route("**/api/**", route => {
      const url = new URL(route.request().url())
      if (!url.pathname.endsWith("/background-shells")) return route.fulfill({ json: {} })
      assert.equal(url.searchParams.get("directory"), host, "the demand keeps its host-side identity")
      if (failInitialRead) {
        failInitialRead = false
        return route.fulfill({ status: 502, json: { error: "native inventory unavailable" } })
      }
      return route.fulfill({ json: { location: { directory: native }, data: present ? [{ id: "sh_wsl", command: "build in WSL",
        cwd: native, shell: "bash", file: "/tmp/log", status: "running", metadata: {}, time: { started: 1 } }] : [] } })
    })
    await page.goto(fixture.url + "?wsl=1")
    await page.getByText(initiallyUnavailable ? "Failed to load background shells." : "No background shells.", { exact: true }).waitFor()
    for (const directory of [native, host]) {
      present = true
      await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/background-shells")),
        page.evaluate(directory => (window as any).fixture.event("session.tool.success", directory), directory),
      ])
      await page.locator(".status-process-card").waitFor()
      present = false
      await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/background-shells")),
        page.evaluate(directory => (window as any).fixture.event("shell.exited", directory), directory),
      ])
      await page.locator(".status-process-card").waitFor({ state: "detached" })
    }
  } finally { await page.close() }
})

test("compact shell rows, native output and stop target the displayed background shell", async () => {
  const page = await fixture.browser.newPage({ viewport: { width: 1000, height: 700 }, locale: "en-US" })
  const errors: string[] = [], deleted: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  const shell = { id: "sh_bg", command: "pwsh -NoProfile -File build.ps1 " + "long-argument ".repeat(20),
    cwd: "/tmp/build", shell: "pwsh", file: "/tmp/output", pid: 42, metadata: { sessionID: "ses_own" }, time: { started: 1 }, status: "running" }
  let present = true, output = "plain output\nsecond line", listReads = 0
  try {
    await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
    await page.route("**/api/**", route => {
      const request = route.request(), url = new URL(request.url())
      let body: unknown = {}
      if (url.pathname.endsWith("/background-shells")) { listReads++; body = { data: present ? [shell] : [] } }
      else if (url.pathname.endsWith("/shell/sh_bg/output")) {
        const cursor = Number(url.searchParams.get("cursor"))
        body = { location: { directory: "/repo" }, data: { output: output.slice(cursor), cursor: output.length, size: output.length, truncated: false } }
      } else if (url.pathname.endsWith("/shell/sh_bg") && request.method() === "DELETE") {
        deleted.push(url.searchParams.get("location[directory]")!)
        present = false
        return route.fulfill({ status: 204 })
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) })
    })
    await page.goto(fixture.url)
    const row = page.locator(".status-process-card")
    await row.waitFor()
    for (const dir of ["ltr", "rtl"]) {
      await page.locator("aside").evaluate((el, dir) => { el.style.width = "220px"; el.dir = dir }, dir)
      const geometry = await row.evaluate(el => ({ height: el.getBoundingClientRect().height, overflow: el.scrollWidth > el.clientWidth }))
      assert.ok(geometry.height <= 38, `one compact row, got ${geometry.height}px`)
      assert.equal(geometry.overflow, false)
    }
    await row.getByRole("button", { name: "View output", exact: true }).click()
    await page.getByRole("dialog").locator("pre").filter({ hasText: "plain output" }).waitFor()
    assert.equal(await page.getByRole("dialog").locator("pre").textContent(), output)
    await page.getByRole("button", { name: "Close", exact: true }).click()
    output = "\u001b[31mred output\u001b[0m"
    await row.getByRole("button", { name: "View output", exact: true }).click()
    await page.getByRole("dialog").locator("pre").filter({ hasText: "red output" }).waitFor()
    assert.equal(await page.getByRole("dialog").locator("pre").textContent(), "red output")
    await page.getByRole("button", { name: "Close", exact: true }).click()
    const count = listReads
    const originalRow = await row.elementHandle()
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/background-shells")),
      page.evaluate(() => (window as any).fixture.event("session.tool.success")),
    ])
    assert.ok(listReads > count)
    assert.equal(await originalRow!.evaluate(el => el.isConnected), true, "passive refresh preserves row actions")
    await row.getByRole("button", { name: "Stop and remove", exact: true }).click()
    await page.getByRole("alertdialog").getByRole("button", { name: "Stop and remove", exact: true }).click()
    await row.waitFor({ state: "detached" })
    assert.deepEqual(deleted, ["/repo"])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("displayed ANSI output follows effective contrast without restarting reads or revealing hidden text", async () => {
  const page = await fixture.browser.newPage({ locale: "en-US" })
  const errors: string[] = [], cursors: number[] = []
  page.on("pageerror", error => errors.push(error.message))
  const output = "\x1b[31mred\x1b[2mdim\x1b[8msecret\x1b[0m"
  const shell = { id: "sh_contrast", command: "contrast output", cwd: "/repo", shell: "bash",
    file: "/log", status: "running", metadata: {}, time: { started: 1 } }
  try {
    await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
    await page.route("**/api/**", route => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith("/background-shells")) return route.fulfill({ json: { data: [shell] } })
      if (url.pathname.endsWith("/shell/sh_contrast/output")) {
        const cursor = Number(url.searchParams.get("cursor"))
        cursors.push(cursor)
        return route.fulfill({ json: { data: { output: output.slice(cursor), cursor: output.length, size: output.length, truncated: false } } })
      }
      return route.fulfill({ json: {} })
    })
    await page.emulateMedia({ contrast: "no-preference", forcedColors: "none" })
    await page.goto(fixture.url)
    await page.getByRole("button", { name: "View output", exact: true }).click()
    const pre = page.getByRole("dialog").locator("pre")
    await pre.filter({ hasText: "red" }).waitFor()
    assert.match(await pre.innerHTML(), /opacity: 0.7/)
    const close = page.getByRole("button", { name: "Close", exact: true })
    await close.focus()
    const originalPre = await pre.elementHandle()
    await page.emulateMedia({ contrast: "more" })
    await page.waitForFunction(() => {
      const spans = [...document.querySelectorAll<HTMLSpanElement>('[role="dialog"] pre span')]
      return spans.length === 3 && spans[1].style.opacity === "" && spans[0].style.color !== spans[1].style.color
    })
    const strengths = await pre.evaluate(async element => {
      const { contrastRatio } = await import("/src/lib/color-contrast.ts" as string)
      const { resolveCssColor } = await import("/src/lib/css-color.ts" as string)
      const background = resolveCssColor("--surface-inset", "background").toUpperCase()
      return [...element.children].slice(0, 2).map(span => {
        const hex = "#" + getComputedStyle(span).color.match(/\d+/g)!.slice(0, 3).map(n => Number(n).toString(16).padStart(2, "0")).join("").toUpperCase()
        return contrastRatio(hex, background)
      })
    })
    assert.ok(strengths[1] >= 7.5 && strengths[0] > strengths[1], `readable dim tier: ${strengths}`)
    assert.equal(await originalPre!.evaluate(element => element.isConnected), true)
    assert.equal(await close.evaluate(element => element === document.activeElement), true)
    await page.emulateMedia({ forcedColors: "active" })
    await page.waitForFunction(() => {
      const hidden = document.querySelector('[role="dialog"] pre span:last-child')
      return document.documentElement.dataset.contrast !== "more" && hidden && getComputedStyle(hidden).visibility === "hidden"
    })
    assert.equal(await close.evaluate(element => element === document.activeElement), true)
    await page.emulateMedia({ contrast: "no-preference", forcedColors: "none" })
    await page.waitForFunction(() => document.querySelector<HTMLSpanElement>('[role="dialog"] pre span:nth-child(2)')?.style.opacity === "0.7")
    assert.equal(await pre.textContent(), "reddimsecret")
    assert.equal(cursors.filter(cursor => cursor === 0).length, 1, "theme refresh keeps the output cursor")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("running and completed bash ANSI repaint on contrast changes and continue streaming", async () => {
  const page = await fixture.browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const output = "\x1b[31mregular\x1b[2mdim\x1b[8msecret\x1b[0m"
  const setOutput = (status: string, text: string) => page.evaluate(({ status, text }) =>
    (window as any).ansiFixture.setState({ status, input: {}, output: text, metadata: { output: text } }), { status, text })
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.emulateMedia({ contrast: "no-preference", forcedColors: "none" })
    await page.goto(fixture.url.replace(/\/fixture$/, "/ansi"))
    await page.waitForFunction(() => Boolean((window as any).ansiFixture))
    for (const status of ["running", "completed"]) {
      await setOutput(status, output)
      const pre = page.locator(".tool-call-ansi")
      await pre.filter({ hasText: "regular" }).waitFor()
      assert.match(await pre.innerHTML(), /opacity: 0.7/)
      await page.emulateMedia({ contrast: "more" })
      await page.waitForFunction(() => {
        const spans = document.querySelectorAll<HTMLSpanElement>(".tool-call-ansi span")
        return spans.length === 3 && !spans[1].style.opacity && spans[0].style.color !== spans[1].style.color
      })
      assert.equal(await pre.locator("span").last().evaluate(element => getComputedStyle(element).visibility), "hidden")
      await setOutput(status, output + "\x1b[32mnext")
      await pre.filter({ hasText: "next" }).waitFor()
      assert.equal(await pre.textContent(), "regulardimsecretnext")
      await page.emulateMedia({ contrast: "no-preference" })
      await page.waitForFunction(() => document.querySelector<HTMLSpanElement>(".tool-call-ansi span:nth-child(2)")?.style.opacity === "0.7")
    }
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
