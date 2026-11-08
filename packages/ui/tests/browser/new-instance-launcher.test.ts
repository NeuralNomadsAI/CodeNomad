import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
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
after(async () => { await browser?.close() })

async function prepare(width = 1100, home: boolean | 'blank' = false) {
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
  await page.goto(home ? `${url}?${home === 'blank' ? 'blank' : 'home'}` : url)
  await page.waitForFunction(() => Boolean((window as any).launcherFixture))
  return { page, errors, remoteRequests, calls: () => page.evaluate(() => [...(window as any).launcherFixture.calls]) }
}
// Creation belongs to the canonical selector.
const CREATE = ["Clone Git Repo", "New temporary tab", "New SideCar"]
const plus = (page: Page) => page.locator(".new-instance-button")
const launcher = (page: Page) => page.locator(".new-instance-launcher")
const options = (page: Page) => launcher(page).locator(".new-instance-launcher-recent-primary")
// Opening focuses the menu container; search is an explicit user choice.
const openedWithFocus = async (page: Page) => {
  await launcher(page).waitFor()
  try {
    await page.waitForFunction(() => document.activeElement?.classList.contains("recent-tabs-menu"))
    assert.equal(await launcher(page).getByRole('searchbox').evaluate(node => node === document.activeElement), false)
  } catch (error) {
    const state = await page.evaluate(() => ({ focus: document.activeElement?.outerHTML,
      search: document.querySelector(".new-instance-launcher-search-input")?.outerHTML }))
    throw new Error(`Launcher focus failed: ${JSON.stringify(state)}`, { cause: error })
  }
}

test('blank creation stays above the columns, keeps its actions, and shares compact new-session branding', async () => {
  const { page, errors, calls } = await prepare(1100, 'blank')
  try {
    const root = page.locator('.folder-home-root--blank')
    const actions = root.locator('.folder-home-blank-actions')
    await actions.getByRole('button', { name: 'Temporary', exact: true }).waitFor()
    assert.deepEqual(await actions.getByRole('button').allTextContents(), ['Temporary', 'Clone'])
    const brand = (await root.locator('.folder-home-hero').boundingBox())!
    const controls = (await actions.boundingBox())!
    const columns = (await root.locator('.folder-home-main').boundingBox())!
    assert.ok(brand.y + brand.height <= controls.y && controls.y + controls.height < columns.y)
    assert.ok(controls.y - (brand.y + brand.height) < columns.y - (controls.y + controls.height), 'creation actions stay closer to the brand than the columns')
    for (const button of await actions.getByRole('button').all()) {
      const padding = await button.evaluate(node => ({ left: parseFloat(getComputedStyle(node).paddingLeft), right: parseFloat(getComputedStyle(node).paddingRight) }))
      assert.ok(padding.left > 0 && padding.right > 0, 'shared small-button padding surrounds the icons')
    }
    const source = root.locator('.folder-home-list-column .panel-header .folder-home-recent-source')
    assert.equal(await source.innerText(), '')
    assert.equal(await source.getByRole('img', { name: 'This computer', exact: true }).count(), 1)
    assert.equal(await source.locator('svg.lucide-laptop').count(), 1)
    assert.equal(await source.getByRole('img').getAttribute('title'), 'This computer')
    const styles = await page.evaluate(() => ['.folder-home-root--blank', '.session-center-column'].map(selector => {
        const logo = getComputedStyle(document.querySelector(`${selector} .empty-state-logo`)!)
        const title = getComputedStyle(document.querySelector(`${selector} .empty-state-brand-title`)!)
        return { height: logo.height, fontSize: title.fontSize, lineHeight: title.lineHeight, weight: title.fontWeight }
    }))
    assert.deepEqual(styles[0], styles[1], 'same real new-session component classes and shared sizing rules')
    assert.equal(await actions.getByRole('button', { name: 'Clone', exact: true }).getAttribute('title'), 'Clone Git Repo')
    assert.equal(await actions.locator('svg').count(), 2)
    assert.equal(await actions.locator('button').first().evaluate(node => getComputedStyle(node).borderRadius), '0px')
    await actions.getByRole('button', { name: 'Temporary', exact: true }).click()
    assert.deepEqual(await calls(), ['temporary'])
    await actions.getByRole('button', { name: 'Clone', exact: true }).click()
    await page.getByRole('dialog').waitFor()
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.evaluate(() => (window as any).launcherFixture.setLoading(true))
    assert.equal(await actions.locator('button:disabled').count(), 2)
    await page.evaluate(async () => { (window as any).launcherFixture.setLoading(false); await (window as any).launcherFixture.setLocale('fr') })
    await actions.getByRole('button', { name: 'Temporaire', exact: true }).waitFor()
    assert.deepEqual(await actions.getByRole('button').allTextContents(), ['Temporaire', 'Cloner'])
    assert.equal(await source.getByRole('img', { name: 'Cet ordinateur', exact: true }).count(), 1)
    assert.equal(await source.getByRole('img').getAttribute('title'), 'Cet ordinateur')
    if (process.env.CODENOMAD_BLANK_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_BLANK_CAPTURE })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('opening the context menu focuses its container, not search, and arrows and Escape remain available', async () => {
  const { page, errors } = await prepare()
  try {
    await plus(page).click({ button: 'right' })
    await openedWithFocus(page)
    await page.keyboard.press('ArrowDown')
    assert.equal(await options(page).first().evaluate(node => document.activeElement === node), true)
    await page.keyboard.press('Escape')
    await launcher(page).waitFor({ state: 'detached' })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

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
    await openedWithFocus(page)
    await page.waitForFunction(() => document.querySelectorAll(".new-instance-launcher-recent-primary").length === 15)
    assert.match(await options(page).first().innerText(), /CodeNomad/)
    assert.match(await options(page).nth(2).innerText(), /Blender tools/)
    assert.equal(await launcher(page).locator(".browse-menu, .new-tab-actions, .new-instance-launcher-servers").count(), 0)
    assert.equal(await launcher(page).getByRole("button", { name: /Remote servers|Open SideCar|Full home page|Add a server/ }).count(), 0)
    assert.equal(await launcher(page).getByRole("heading").innerText(), "Recent tabs")
    assert.equal(await launcher(page).getByRole("button", { name: "Open another project…", exact: true }).count(), 0)
    assert.equal(await launcher(page).getByRole("button", { name: /^(Recent|Browse|Clone Git Repo)$/ }).count(), 0)
    assert.equal(await launcher(page).getByRole("searchbox").getAttribute("placeholder"), "Search recent tabs…")
    const subtleBorder = await launcher(page).evaluate(node => {
      const probe = document.createElement('span')
      probe.style.borderBottom = '1px solid var(--border-row)'
      node.append(probe)
      const color = getComputedStyle(probe).borderBottomColor
      probe.remove()
      return color
    })
    assert.deepEqual(await launcher(page).locator('.window-header, .window-toolbar, .new-instance-launcher-recent').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).borderBottomColor)), Array(17).fill(subtleBorder))
    assert.deepEqual(remoteRequests, [], "saved profiles do not trigger launcher remote reads or probes")
    if (process.env.CODENOMAD_LAUNCHER_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_LAUNCHER_CAPTURE })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("typing and Enter open a new occurrence; the separate Open action joins the existing one", async () => {
  const { page, errors, calls } = await prepare()
  try {
    await plus(page).click({ button: "right" })
    await openedWithFocus(page)
    await launcher(page).getByRole('searchbox').focus()
    await page.keyboard.type("blend")
    await page.waitForFunction(() => document.querySelectorAll(".new-instance-launcher-recent-primary").length === 1)
    await page.keyboard.press("Enter")
    await launcher(page).waitFor({ state: "detached" })
    assert.deepEqual(await calls(), ["folder:D:/blender"])

    await plus(page).focus()
    await page.keyboard.press("Alt+ArrowDown")
    await openedWithFocus(page)
    await launcher(page).getByRole('searchbox').focus()
    await page.keyboard.type("zzz")
    await launcher(page).getByText("No project matches.").waitFor()
    await page.keyboard.press("Control+A")
    await page.keyboard.press("Backspace")
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("ArrowUp")
    await page.keyboard.press("Home")
    // Enter on the primary row opens another occurrence even when already open.
    await page.keyboard.press("Enter")
    await launcher(page).waitFor({ state: "detached" })
    assert.deepEqual((await calls()).at(-1), "folder:D:/CodeNomad")

    await plus(page).click({ button: "right" })
    await openedWithFocus(page)
    const join = launcher(page).locator('.new-instance-launcher-recent[data-open="true"] .folder-home-open-instance-button')
    assert.equal(await join.innerText(), "OPEN")
    assert.equal(await join.getAttribute('title'), 'Switch to open project')
    await join.focus()
    await page.keyboard.press("Enter")
    await launcher(page).waitFor({ state: "detached" })
    assert.equal((await calls()).at(-1), "existing:codenomad-tab:D:/CodeNomad")

    await plus(page).click({ button: "right" })
    await launcher(page).waitFor()
    await page.keyboard.press("Escape")
    await launcher(page).waitFor({ state: "detached" })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a narrow quick launcher's title-bar temporary button runs the existing action", async () => {
  const { page, errors, calls } = await prepare(390)
  try {
      await plus(page).click({ button: "right" })
      await launcher(page).waitFor()
      const width = await launcher(page).evaluate(el => el.getBoundingClientRect().width)
      assert.ok(width <= 390, `launcher fits a narrow window (${width}px)`)
      assert.equal(await launcher(page).locator(".browse-menu, input[type=password], [data-server-add-field]").count(), 0)
      if (process.env.CODENOMAD_LAUNCHER_NARROW_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_LAUNCHER_NARROW_CAPTURE })
      const temporary = launcher(page).locator(".window-header").getByRole("button", { name: "New temporary tab", exact: true })
      assert.match((await temporary.getAttribute("class"))!, /window-icon-button/)
      assert.equal(await temporary.evaluate(node => getComputedStyle(node).borderTopWidth), '1px')
      await temporary.click()
      await launcher(page).waitFor({ state: "detached" })
      assert.deepEqual(await calls(), ["temporary"])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a clone is suggested as the repository's folder beside the last clone, a browsed folder holds it and a typed path wins", async () => {
  const { page, errors, calls } = await prepare(1100, true)
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
      await page.getByRole("button", { name: "Clone Git Repo", exact: true }).click()
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
    await launcher(page).getByRole('searchbox').focus()
    await page.keyboard.type("project")
    await page.waitForFunction(() => document.querySelectorAll(".new-instance-launcher-recent-primary").length === 12)
    const visible = await page.evaluate(() => {
      const list = document.querySelector(".new-instance-launcher-recents")!.getBoundingClientRect()
      const row = document.querySelector(".new-instance-launcher-recent-primary")!.getBoundingClientRect()
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

test("Home owns browsing and creation; quick recents contain neither", async () => {
  const home = await prepare(1100, true)
  const tabs = await prepare()
  try {
    const { page, errors } = home
    // The old framed Browse button, Servers tab, Connect and Open SideCar buttons are gone.
    assert.equal(await page.getByRole("button", { name: /^(Browse Folders|Servers|Remotes|Connect CodeNomad Server|Open SideCar)/ }).count(), 0)
    const actions = page.locator(".folder-home-creation-actions")
    assert.deepEqual(await actions.getByRole("button").allTextContents(), CREATE)

    // Right: two tabs, Recent tabs first; search stays in the quick launcher.
    const tabList = page.getByRole("tablist")
    assert.deepEqual(await tabList.getByRole("tab").allTextContents(), ["Recent tabs15 items", "Browse2 items"])
    const recentTab = tabList.getByRole("tab", { name: "Recent tabs" })
    assert.equal(await recentTab.getAttribute("aria-selected"), "true")
    assert.equal(await recentTab.evaluate(node => (node as HTMLElement).style.backgroundColor), 'var(--surface-secondary)')
    assert.equal(await tabList.getByRole('tab', { name: 'Browse', exact: true }).evaluate(node => (node as HTMLElement).style.backgroundColor), 'var(--surface-control)')
    const selectedBackground = await recentTab.evaluate(node => getComputedStyle(node).backgroundColor)
    const unselectedBackground = await tabList.getByRole('tab', { name: 'Browse', exact: true }).evaluate(node => getComputedStyle(node).backgroundColor)
    assert.notEqual(selectedBackground, unselectedBackground)
    await recentTab.hover()
    assert.notEqual(await recentTab.evaluate(node => getComputedStyle(node).backgroundImage), 'none')
    await page.mouse.move(5, 700)
    assert.equal(await recentTab.evaluate(node => getComputedStyle(node).backgroundImage), 'none')
    assert.equal(await page.getByRole('searchbox').count(), 0)
    assert.equal(await page.locator('.folder-home-recent-item').count(), 15)
    // Arrow keys move between the tabs; Browse is a list without a disclosure.
    await recentTab.focus()
    await page.keyboard.press("ArrowRight")
    const browseTab = tabList.getByRole("tab", { name: "Browse" })
    assert.equal(await browseTab.getAttribute("aria-selected"), "true")
    await page.waitForFunction(({ selected, unselected }) =>
      getComputedStyle(document.querySelector('[data-home-tab="browse"]')!).backgroundColor === selected &&
      getComputedStyle(document.querySelector('[data-home-tab="recent"]')!).backgroundColor === unselected,
      { selected: selectedBackground, unselected: unselectedBackground })
    assert.equal(await browseTab.evaluate(node => getComputedStyle(node).backgroundColor), selectedBackground)
    assert.equal(await recentTab.evaluate(node => getComputedStyle(node).backgroundColor), unselectedBackground)
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Browse")
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
    assert.equal(await launcher(tabs.page).locator(".browse-menu-row, .new-tab-actions, [data-server-add-field]").count(), 0)
    assert.equal(await launcher(tabs.page).getByRole("button", { name: "Open another project…", exact: true }).count(), 0)
    assert.deepEqual([...errors, ...tabs.errors], [])
  } finally { await home.page.close(); await tabs.page.close() }
})

test("quick recents are always visible and Escape dismisses them in one step", async () => {
  const { page, errors } = await prepare()
  try {
    await plus(page).click({ button: "right" })
    await openedWithFocus(page)
    assert.equal(await options(page).count(), 15)
    await page.keyboard.press("Escape")
    await launcher(page).waitFor({ state: "detached" })

    await plus(page).click({ button: "right" })
    await openedWithFocus(page)
    await launcher(page).getByRole("searchbox").fill("blend")
    await page.waitForFunction(() => document.querySelectorAll(".new-instance-launcher-recent-primary").length === 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("recent hover clears on pointer exit and keyboard highlighting is limited to keyboard navigation", async () => {
  const home = await prepare(1100, true)
  const quick = await prepare()
  try {
    const row = home.page.locator('.folder-home-recent-item').first()
    const openBadge = row.locator('.folder-home-open-instance-button')
    assert.equal(await openBadge.getAttribute('title'), 'Switch to open project')
    assert.equal(await openBadge.evaluate(node => getComputedStyle(node).textTransform), 'uppercase')
    const background = () => row.evaluate(node => getComputedStyle(node).backgroundColor)
    await home.page.mouse.move(5, 700)
    const idle = await background()
    await row.locator('.folder-home-recent-primary-action').hover({ position: { x: 10, y: 10 } })
    await home.page.waitForFunction(() => getComputedStyle(document.querySelector('.folder-home-recent-item')!).backgroundColor !== 'rgba(0, 0, 0, 0)')
    assert.notEqual(await background(), idle)
    await home.page.mouse.move(5, 700)
    await home.page.waitForFunction(() => getComputedStyle(document.querySelector('.folder-home-recent-item')!).backgroundColor === 'rgba(0, 0, 0, 0)')
    assert.equal(await background(), idle)
    assert.equal(await row.locator('.folder-home-recent-primary-action').evaluate(node => getComputedStyle(node).boxShadow), 'none')
    assert.equal(await row.evaluate(node => node.classList.contains('panel-list-item-highlight')), false)
    await row.locator('.folder-home-recent-primary-action').focus()
    await home.page.keyboard.press('Home')
    assert.equal(await row.evaluate(node => node.classList.contains('panel-list-item-highlight')), true)
    await row.locator('.folder-home-recent-primary-action').hover({ position: { x: 10, y: 10 } })
    await home.page.mouse.move(5, 700)
    await home.page.waitForFunction(() => getComputedStyle(document.querySelector('.folder-home-recent-item')!).backgroundColor === 'rgba(0, 0, 0, 0)')
    assert.equal(await background(), idle)

    await plus(quick.page).click({ button: 'right' })
    await openedWithFocus(quick.page)
    const option = options(quick.page).first()
    assert.equal(await launcher(quick.page).locator('.folder-home-open-instance-button').evaluate(node => getComputedStyle(node).textTransform), 'uppercase')
    const optionBackground = () => option.evaluate(node => getComputedStyle(node).backgroundColor)
    const optionIdle = await optionBackground()
    await option.hover()
    assert.notEqual(await optionBackground(), optionIdle)
    await quick.page.mouse.move(1090, 700)
    assert.equal(await optionBackground(), optionIdle)
    assert.equal(await option.evaluate(node => getComputedStyle(node).outlineStyle), 'none')
    await quick.page.keyboard.press('ArrowDown')
    assert.equal(await option.evaluate(node => node.matches(':focus-visible')), true)
    await option.hover()
    await quick.page.mouse.move(1090, 700)
    assert.equal(await optionBackground(), optionIdle)
    assert.deepEqual([...home.errors, ...quick.errors], [])
  } finally { await home.page.close(); await quick.page.close() }
})
