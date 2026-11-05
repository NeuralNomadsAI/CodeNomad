import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  const fixture = await borrowFixture({
      name: "new-instance-launcher",
      routes: [
        { path: "/fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/new-instance-launcher.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await cache?.dispose() })

async function prepare(width = 1100, home = false) {
  const page = await browser.newPage({ viewport: { width, height: 760 }, locale: "en-US" })
  const errors: string[] = []
  const remoteRequests: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("request", request => {
    if (/\/api\/remote-/.test(request.url())) remoteRequests.push(request.url())
  })
  // Local native-window capabilities, without any real host or user state.
  await page.addInitScript(() => {
    (window as any).__CODENOMAD_RUNTIME_HOST__ = "electron"
    window.__CODENOMAD_WINDOW_CONTEXT__ = "local"
  })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.goto(home ? `${url}?home` : url)
  await page.waitForFunction(() => Boolean((window as any).launcherFixture))
  return { page, errors, remoteRequests, calls: () => page.evaluate(() => [...(window as any).launcherFixture.calls]) }
}
// The home page's creation buttons; the launcher keeps the first two.
const CREATE = ["Clone Git Repo", "New temporary tab", "New SideCar"]
const LAUNCHER_CREATE = CREATE.slice(0, 2)
const plus = (page: Page) => page.locator(".new-instance-button")
const launcher = (page: Page) => page.locator(".new-instance-launcher")
const options = (page: Page) => launcher(page).getByRole("option")
// The popup focuses its search field on the next frame; type once it has focus.
const openedWithFocus = async (page: Page) => {
  await launcher(page).waitFor()
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "combobox")
}

test("a click keeps the full home page while a long press opens the launcher", async () => {
  const { page, errors, remoteRequests, calls } = await prepare()
  try {
    await plus(page).click()
    assert.deepEqual(await calls(), ["home"])
    assert.equal(await launcher(page).count(), 0)
    assert.match((await plus(page).getAttribute("title")) ?? "", /long press or right-click/)

    const box = (await plus(page).boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await launcher(page).waitFor()
    await page.mouse.up()
    // The release that ends a long press is not a second, home-page click.
    assert.deepEqual(await calls(), ["home"])
    assert.equal(await plus(page).getAttribute("aria-expanded"), "true")
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("role")), "combobox")
    await page.waitForFunction(() => document.querySelectorAll(".new-instance-launcher [role=option]").length === 15)
    assert.equal(await options(page).first().getAttribute("aria-selected"), "true")
    assert.match(await options(page).first().innerText(), /CodeNomad[\s\S]*open/)
    assert.match(await options(page).nth(2).innerText(), /Blender tools/)
    assert.equal(await launcher(page).locator("footer, .new-instance-launcher-servers").count(), 0)
    assert.equal(await launcher(page).getByRole("button", { name: /Remote servers|Open SideCar|Full home page|Add a server/ }).count(), 0)
    // Browse stays folded: listing saved CodeNomad servers reads and probes nothing.
    assert.equal(await launcher(page).getByRole("heading").innerText(), "Open a tab")
    const recentToggle = launcher(page).getByRole("button", { name: "Recent", exact: true })
    assert.equal(await recentToggle.innerText(), "RECENT")
    assert.equal(await recentToggle.getAttribute("aria-expanded"), "true")
    assert.deepEqual(await launcher(page).getByRole("button").allTextContents(), ["Recent", "Browse", ...LAUNCHER_CREATE])
    assert.equal(await launcher(page).getByRole("button", { name: "Browse", exact: true }).getAttribute("aria-expanded"), "false")
    assert.deepEqual(remoteRequests, [], "saved profiles do not trigger launcher remote reads or probes")
    if (process.env.CODENOMAD_LAUNCHER_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_LAUNCHER_CAPTURE })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("typing filters recent projects and the keyboard opens or switches to them", async () => {
  const { page, errors, calls } = await prepare()
  try {
    await plus(page).click({ button: "right" })
    await openedWithFocus(page)
    await page.keyboard.type("blend")
    await page.waitForFunction(() => document.querySelectorAll(".new-instance-launcher [role=option]").length === 1)
    await page.keyboard.press("Enter")
    await launcher(page).waitFor({ state: "detached" })
    assert.deepEqual(await calls(), ["folder:D:/blender"])

    await plus(page).focus()
    await page.keyboard.press("Alt+ArrowDown")
    await openedWithFocus(page)
    await page.keyboard.type("zzz")
    await launcher(page).getByText("No project matches.").waitFor()
    await page.keyboard.press("Control+A")
    await page.keyboard.press("Backspace")
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("ArrowUp")
    // An already open project switches to its tab instead of opening a duplicate.
    await page.keyboard.press("Enter")
    await launcher(page).waitFor({ state: "detached" })
    assert.deepEqual((await calls()).at(-1), "existing:codenomad-tab:D:/CodeNomad")

    await plus(page).click({ button: "right" })
    await launcher(page).waitFor()
    await page.keyboard.press("Escape")
    await launcher(page).waitFor({ state: "detached" })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("project actions stay available in a narrow launcher and close it before running", async () => {
  const { page, errors, calls } = await prepare(390)
  try {
    // Exercise the real browser folder picker rather than a native OS dialog.
    await page.evaluate(() => { (window as any).__CODENOMAD_RUNTIME_HOST__ = "web" })
    for (const name of ["This computer", "New temporary tab", "Clone Git Repo"]) {
      await plus(page).click({ button: "right" })
      await launcher(page).waitFor()
      const width = await launcher(page).evaluate(el => el.getBoundingClientRect().width)
      assert.ok(width <= 390, `launcher fits a narrow window (${width}px)`)
      assert.equal(await launcher(page).locator("footer").count(), 0)
      if (name === "New temporary tab" && process.env.CODENOMAD_LAUNCHER_NARROW_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_LAUNCHER_NARROW_CAPTURE })
      // This computer's folders are browsed from the Browse section.
      if (name === "This computer") await launcher(page).getByRole("button", { name: "Browse", exact: true }).click()
      await launcher(page).getByRole("button", { name, exact: true }).click()
      await launcher(page).waitFor({ state: "detached" })
      if (name === "New temporary tab") assert.equal((await calls()).at(-1), "temporary")
      else {
        await page.getByRole("dialog").getByRole("heading", { name: name === "This computer" ? "Select Workspace" : "Clone Git Repository", exact: true }).waitFor()
        await page.keyboard.press("Escape")
        await page.getByRole("dialog").waitFor({ state: "detached" })
      }
    }
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a clone is suggested as the repository's folder beside the last clone, a browsed folder holds it and a typed path wins", async () => {
  const { page, errors, calls } = await prepare()
  try {
    const clones: Array<{ destinationPath: string }> = []
    await page.route("**/api/workspaces/clone", async route => {
      const body = route.request().postDataJSON()
      clones.push(body)
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ path: body.destinationPath }) })
    })
    const dialog = page.getByRole("dialog")
    const url = dialog.getByRole("textbox").nth(0)
    const destination = dialog.getByRole("textbox").nth(1)
    const openClone = async () => {
      await plus(page).click({ button: "right" })
      await launcher(page).getByRole("button", { name: /^Clone/ }).click()
      await dialog.getByRole("heading", { name: "Clone Git Repository", exact: true }).waitFor()
    }

    await openClone()
    // Without a previous clone: beside the most recent project (D:/CodeNomad).
    await url.fill("https://github.com/pascalandr/open-design")
    assert.equal(await destination.inputValue(), "D:/open-design")
    // The native folder picker; a string, so the compiled test adds no helpers the page lacks.
    await page.evaluate(`window.browsedFrom = []; window.electronAPI = { openDialog: async (options) => {
      window.browsedFrom.push(options.defaultPath)
      return { paths: ["C:\\\\GITHUB"] }
    } }`)
    await dialog.getByRole("button", { name: "Browse", exact: true }).click()
    await page.waitForFunction(() => (window as any).browsedFrom.length === 1)
    assert.equal(await destination.inputValue(), "C:\\GITHUB\\open-design")
    assert.deepEqual(await page.evaluate(() => (window as any).browsedFrom), ["D:/"], "the picker opens where the folder will be created")
    await destination.fill("C:\\GITHUB\\design-fork")
    await url.fill("https://github.com/pascalandr/open-design.git")
    assert.equal(await destination.inputValue(), "C:\\GITHUB\\design-fork", "a typed path is kept")
    // The next clone is suggested before the server confirms what to remember.
    await page.evaluate(`window.holdStatePatches = true`)
    await dialog.getByRole("button", { name: "Clone", exact: true }).click()
    await dialog.waitFor({ state: "detached" })
    assert.deepEqual(clones.map(clone => clone.destinationPath), ["C:\\GITHUB\\design-fork"])
    assert.equal((await calls()).at(-1), "folder:C:\\GITHUB\\design-fork")

    // The folder above the last clone is remembered for the next one.
    await openClone()
    await url.fill("git@github.com:user/next.git")
    assert.equal(await destination.inputValue(), "C:\\GITHUB\\next")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("dismissal returns focus, aborted long presses keep keyboard activation, and the active row stays visible", async () => {
  const { page, errors, calls } = await prepare()
  try {
    for (const key of ["Alt+ArrowDown", "Shift+F10", "ContextMenu"]) {
      await plus(page).focus()
      await page.keyboard.press(key)
      await openedWithFocus(page)
      await page.keyboard.press("Escape")
      await launcher(page).waitFor({ state: "detached" })
      await page.waitForFunction(() => document.activeElement?.classList.contains("new-instance-button"))
    }

    // Long press, then release away from the button: no click ends it.
    const box = (await plus(page).boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await launcher(page).waitFor()
    await page.mouse.move(10, 400)
    await page.mouse.up()
    await page.keyboard.press("Escape")
    await launcher(page).waitFor({ state: "detached" })
    await plus(page).focus()
    await page.keyboard.press("Enter")
    assert.deepEqual(await calls(), ["home"])

    await page.keyboard.press("Alt+ArrowDown")
    await openedWithFocus(page)
    await page.keyboard.press("ArrowUp")
    await page.keyboard.type("project")
    await page.waitForFunction(() => document.querySelectorAll(".new-instance-launcher [role=option]").length === 12)
    const visible = await page.evaluate(() => {
      const list = document.querySelector(".new-instance-launcher-recents")!.getBoundingClientRect()
      const id = document.querySelector(".new-instance-launcher-search-input")!.getAttribute("aria-activedescendant")!
      const row = document.getElementById(id)!.getBoundingClientRect()
      return row.top >= list.top - 1 && row.bottom <= list.bottom + 1
    })
    assert.equal(visible, true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a touch long press opens the launcher and keeps it open after the finger lifts", async () => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 760 }, locale: "en-US" })
  const page = await context.newPage()
  try {
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).launcherFixture))
    const box = (await plus(page).boundingBox())!
    const cdp = await context.newCDPSession(page)
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] })
    await launcher(page).waitFor()
    await page.waitForTimeout(400)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    await page.waitForTimeout(400)
    assert.equal(await launcher(page).count(), 1)
    assert.deepEqual(await page.evaluate(() => [...(window as any).launcherFixture.calls]), [])
  } finally { await context.close() }
})
test("closing returns focus only after Escape and never steals it from another surface", async () => {
  const { page, errors } = await prepare()
  try {
    const focused = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName)
    // Another window takes focus while the launcher is open (the command palette, for example).
    await plus(page).focus()
    await page.keyboard.press("Alt+ArrowDown")
    await openedWithFocus(page)
    await page.evaluate(() => (document.getElementById("other-surface") as HTMLInputElement).focus())
    await launcher(page).waitFor({ state: "detached" })
    await page.keyboard.type("kept")
    assert.equal(await page.locator("#other-surface").inputValue(), "kept")
    assert.equal(await focused(), "other-surface")

    // The app closes it (the home page opened): focus does not land on the covered button.
    await plus(page).focus()
    await page.keyboard.press("Alt+ArrowDown")
    await openedWithFocus(page)
    await page.evaluate(() => (window as any).launcherFixture.close())
    await launcher(page).waitFor({ state: "detached" })
    assert.notEqual(await focused(), "new-tab-button new-instance-button")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("the new-instance button follows the last tab like a browser", async () => {
  const { page, errors } = await prepare()
  try {
    const gap = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll(".tab-strip-tabs > *")]
      const last = tabs[tabs.length - 1].getBoundingClientRect()
      const plus = document.querySelector(".new-instance-button")!.getBoundingClientRect()
      const actions = document.querySelector(".tab-bar-actions")!.getBoundingClientRect()
      return { afterTab: plus.left - last.right, beforeActions: actions.left - plus.right }
    })
    assert.ok(gap.afterTab >= 0 && gap.afterTab < 24, `button sits right after the last tab (${gap.afterTab}px)`)
    assert.ok(gap.beforeActions > 200, `free space stays between the button and the bar actions (${gap.beforeActions}px)`)
    if (process.env.CODENOMAD_LAUNCHER_TABS_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_LAUNCHER_TABS_CAPTURE, clip: { x: 0, y: 0, width: 1100, height: 60 } })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

// Browse's rows, in order, once unfolded with the keyboard; focus walks them and Escape folds it back.
async function browseByKeyboard(page: Page, scope: ReturnType<Page["locator"]>) {
  const toggle = scope.getByRole("button", { name: "Browse", exact: true })
  assert.equal(await toggle.getAttribute("aria-expanded"), "false")
  // The chevron sits before the title.
  assert.equal(await toggle.evaluate(el => el.firstElementChild?.classList.contains("disclosure-chevron")), true)
  await toggle.focus()
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => document.activeElement?.textContent === "This computer")
  const rows = await scope.locator(".browse-menu-row").allTextContents()
  await page.keyboard.press("ArrowDown")
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Open a project on Saved remote")
  await page.keyboard.press("ArrowDown")
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Server address or link", "the address field comes last")
  await page.keyboard.press("ArrowDown")
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "This computer", "the rows wrap around")
  await page.keyboard.press("Escape")
  await page.waitForFunction(() => document.activeElement?.textContent === "Browse")
  assert.equal(await toggle.getAttribute("aria-expanded"), "false")
  return rows
}

test("the home page's Recent and Browse tabs match the launcher's sections, which keeps two creation buttons", async () => {
  const home = await prepare(1100, true)
  const tabs = await prepare()
  try {
    const { page, errors } = home
    // The old framed Browse button, Servers tab, Connect and Open SideCar buttons are gone.
    assert.equal(await page.getByRole("button", { name: /^(Browse Folders|Servers|Remotes|Connect CodeNomad Server|Open SideCar)/ }).count(), 0)
    // Left: only the creation buttons, then the OpenCode settings.
    const actions = page.locator(".folder-home-actions-column")
    const order = await actions.locator("button").evaluateAll(buttons => buttons.map(button => button.textContent?.trim()))
    assert.deepEqual(order.slice(0, 5), [...CREATE, "OpenCode"])

    // Right: two tabs, Recent tabs first, with the launcher's search.
    const tabList = page.getByRole("tablist")
    assert.deepEqual(await tabList.getByRole("tab").allTextContents(), ["Recent", "Browse"])
    const recentTab = tabList.getByRole("tab", { name: "Recent" })
    assert.equal(await recentTab.getAttribute("aria-selected"), "true")
    const search = page.getByRole("textbox", { name: "Search recent projects" })
    await search.fill("blend")
    await page.waitForFunction(() => document.querySelectorAll(".folder-home-recent-item").length === 1)
    await search.fill("")
    // Arrow keys move between the tabs; Browse is a list without a disclosure.
    await recentTab.focus()
    await page.keyboard.press("ArrowRight")
    const browseTab = tabList.getByRole("tab", { name: "Browse" })
    assert.equal(await browseTab.getAttribute("aria-selected"), "true")
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Browse")
    const panel = page.getByRole("tabpanel", { name: "Browse" })
    assert.equal(await panel.locator(".browse-menu-toggle").count(), 0)
    const homeRows = await panel.locator(".browse-menu-row").allTextContents()
    assert.deepEqual(homeRows, ["This computer", "Saved remote"])
    await panel.getByRole("textbox", { name: "Server address or link" }).waitFor()
    await panel.getByRole("button", { name: "This computer" }).focus()
    await page.keyboard.press("ArrowDown")
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Open a project on Saved remote")

    await plus(tabs.page).click({ button: "right" })
    await openedWithFocus(tabs.page)
    assert.deepEqual(await launcher(tabs.page).locator(".new-instance-launcher-actions button").allTextContents(), LAUNCHER_CREATE)
    const launcherRows = await browseByKeyboard(tabs.page, launcher(tabs.page))
    assert.equal(await launcher(tabs.page).count(), 1, "Escape folds Browse without closing the launcher")
    assert.deepEqual(launcherRows, homeRows)
    assert.deepEqual([...errors, ...tabs.errors], [])
  } finally { await home.page.close(); await tabs.page.close() }
})

test("the launcher's Recent section folds like Browse: Escape folds it without closing, typing or an arrow unfolds it", async () => {
  const { page, errors } = await prepare()
  try {
    await plus(page).click({ button: "right" })
    await openedWithFocus(page)
    const toggle = launcher(page).getByRole("button", { name: "Recent", exact: true })
    // The chevron sits before the title, as in Browse.
    assert.equal(await toggle.evaluate(el => el.firstElementChild?.classList.contains("disclosure-chevron")), true)
    await toggle.focus()
    await page.keyboard.press("Escape")
    assert.equal(await toggle.getAttribute("aria-expanded"), "false")
    assert.equal(await options(page).count(), 0)
    assert.equal(await launcher(page).count(), 1, "Escape folds Recent without closing the launcher")
    // Escape on a folded section closes the launcher as usual.
    await page.keyboard.press("Escape")
    await launcher(page).waitFor({ state: "detached" })

    // The section stays folded in this window; the search's first arrow unfolds it.
    await plus(page).click({ button: "right" })
    await openedWithFocus(page)
    assert.equal(await toggle.getAttribute("aria-expanded"), "false")
    await page.keyboard.press("ArrowDown")
    assert.equal(await toggle.getAttribute("aria-expanded"), "true")
    await page.waitForFunction(() => document.querySelectorAll(".new-instance-launcher [role=option]").length > 0)
    await toggle.click()
    await page.getByRole("combobox").fill("blend")
    assert.equal(await toggle.getAttribute("aria-expanded"), "true", "typing unfolds it")
    await page.waitForFunction(() => document.querySelectorAll(".new-instance-launcher [role=option]").length === 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})