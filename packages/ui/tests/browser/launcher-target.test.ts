// prototype-1236: mixed recents (R12) and the shared "Remote project" disclosure on the home page and in the launcher (R27, R18).
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "launcher-target", routes: [{ path: "/fixture",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/launcher-target.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

async function open(view: "home" | "launcher" = "home", longContext = false) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(() => {
    (window as any).__CODENOMAD_RUNTIME_HOST__ = "electron"
    window.__CODENOMAD_WINDOW_CONTEXT__ = "local"
  })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  const query = new URLSearchParams()
  if (view === "launcher") query.set("launcher", "")
  if (longContext) query.set("longContext", "")
  await page.goto(`${url}?${query}`)
  await page.waitForFunction(() => Boolean((window as any).launcherTarget))
  const calls = () => page.evaluate(() => [...(window as any).launcherTarget.calls] as string[])
  const waitCall = (call: string) => page.waitForFunction((value) => (window as any).launcherTarget.calls.includes(value), call)
  if (view === "launcher") {
    await page.getByRole("button", { name: "New instance", exact: true }).click()
    await page.locator(".new-instance-launcher").waitFor()
  }
  const toggle = page.getByRole("button", { name: "Remotes", exact: true })
  const menu = page.getByRole("group", { name: "Remotes", exact: true })
  return { page, errors, calls, waitCall, toggle, menu }
}

const focused = (page: Page) => page.evaluate(() => {
  const active = document.activeElement as HTMLElement | null
  return active?.dataset.remoteServer ?? active?.dataset.remoteFolder ?? active?.getAttribute("aria-label") ?? active?.textContent?.trim() ?? ""
})

test("one recent list mixes local and server projects; a click reopens the server and path directly", async () => {
  const f = await open()
  try {
    const rows = f.page.locator(".folder-home-recent-item")
    await rows.first().waitFor()
    assert.equal(await rows.count(), 2, "a removed server's recent project is hidden")
    assert.equal(await rows.first().getAttribute("data-server-id"), "oc-lab")
    assert.match(await rows.first().innerText(), /Lab/)
    assert.equal(await rows.nth(1).getAttribute("data-server-id"), null)
    await rows.first().locator(".folder-home-recent-primary-action").click()
    await rows.nth(1).locator(".folder-home-recent-primary-action").click()
    assert.deepEqual(await f.calls(), ["open:oc-lab:/srv/app", "open:local:D:/local-project"])
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

for (const view of ["home", "launcher"] as const) {
  test(`${view}: REMOTES is a borderless Recents-style heading, with only a leading disclosure chevron`, async () => {
    const f = await open(view)
    try {
      const style = await f.toggle.evaluate((element) => {
        const css = getComputedStyle(element)
        const recent = document.querySelector(".new-instance-launcher-section-title")
        return { border: css.borderTopWidth, background: css.backgroundColor, transform: css.textTransform,
          size: css.fontSize, spacing: css.letterSpacing, weight: css.fontWeight,
          recentSize: recent && getComputedStyle(recent).fontSize, recentSpacing: recent && getComputedStyle(recent).letterSpacing,
          first: element.firstElementChild?.tagName.toLowerCase(), chevron: element.firstElementChild?.classList.contains("disclosure-chevron") }
      })
      assert.equal(style.border, "0px")
      assert.equal(style.background, "rgba(0, 0, 0, 0)")
      assert.equal(style.transform, "uppercase")
      assert.equal(style.first, "svg")
      assert.equal(style.chevron, true)
      assert.equal(await f.toggle.locator("svg").count(), 1, "no server icon in the title")
      if (view === "launcher") {
        assert.equal(style.size, style.recentSize)
        assert.equal(style.spacing, style.recentSpacing)
      }
      await f.toggle.click()
      const server = f.menu.getByRole("button", { name: "Open a project on Lab", exact: true })
      assert.equal(await server.locator("button, [role=button]").count(), 0, "no nested buttons")
      assert.equal(await server.locator(".lucide-chevron-right").count(), 0, "server rows navigate rather than disclose")
      assert.equal(await server.locator(".window-action").innerText(), "Project")
      assert.equal(await server.locator(".lucide-server").count(), 1, "server row keeps its icon")
      await server.locator(".window-action").click()
      await f.menu.locator("[data-remote-folder]").first().waitFor()
      assert.equal(await f.menu.locator(".remote-project-header .remote-project-name").innerText(), "Lab")
      assert.deepEqual(f.errors, [])
    } finally { await f.page.close() }
  })

  test(`${view}: Remote project lists OpenCode servers and browses a server's folders in place with the mouse`, async () => {
    const f = await open(view)
    try {
      if (view === "home") {
        assert.equal(await f.page.getByRole("combobox", { name: "Servers", exact: true }).count(), 0, "no target selector")
        assert.equal(await f.page.getByRole("button", { name: "Clone Git Repo", exact: true }).count(), 1)
      }
      await f.toggle.click()
      const lab = f.menu.locator('[data-remote-server="oc-lab"]')
      await lab.waitFor()
      assert.equal(await f.menu.locator("[data-remote-server]").count(), 1, "CodeNomad servers stay out of the list")
      await lab.click()
      await f.menu.locator('[data-remote-folder="/srv/app/app"]').waitFor()
      assert.ok((await f.calls()).includes("list:oc-lab:/srv/app"), "starts from the server's latest project")
      await f.menu.locator('[data-remote-folder="/srv/app/lib"]').click()
      await f.menu.locator('[data-remote-folder="/srv/app/lib/app"]').waitFor()
      await f.menu.getByRole("button", { name: "Parent folder", exact: true }).click()
      await f.menu.locator('[data-remote-folder="/srv/app/lib"]').waitFor()
      assert.equal(await f.page.locator("[role='dialog']:not(.new-instance-launcher), .directory-browser-list").count(), 0, "no floating window")
      await f.menu.getByRole("button", { name: "Open", exact: true }).click()
      await f.waitCall("open:oc-lab:/srv/app")
      if (view === "launcher") await f.page.locator(".new-instance-launcher").waitFor({ state: "detached" })
      assert.deepEqual(f.errors, [])
    } finally { await f.page.close() }
  })

  test(`${view}: the disclosure is fully keyboard driven with stable focus`, async () => {
    const f = await open(view)
    try {
      await f.toggle.focus()
      await f.page.keyboard.press("Enter")
      await f.page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset.remoteServer === "oc-lab")
      await f.page.keyboard.press("ArrowDown")
      assert.equal(await focused(f.page), "Add server", "the paste field follows the servers")
      await f.page.keyboard.press("ArrowUp")
      assert.equal(await focused(f.page), "oc-lab")
      await f.page.keyboard.press("ArrowRight")
      await f.page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset.remoteFolder === "/srv/app/app")
      await f.page.keyboard.press("ArrowDown")
      assert.equal(await focused(f.page), "/srv/app/lib")
      await f.page.keyboard.press("Enter")
      await f.waitCall("list:oc-lab:/srv/app/lib")
      await f.page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset.remoteFolder === "/srv/app/lib/app")
      await f.page.keyboard.press("Backspace")
      await f.page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset.remoteFolder === "/srv/app/lib")
      assert.equal(await f.menu.locator(".remote-project-header .remote-project-name").innerText(), "Lab")
      await f.menu.getByRole("button", { name: "Back to servers", exact: true }).click()
      await f.menu.getByRole("button", { name: "Open a project on Lab", exact: true }).press("Enter")
      await f.menu.locator('[data-remote-folder="/srv/app/app"]').waitFor()
      await f.page.keyboard.press("Escape")
      await f.page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset.remoteServer === "oc-lab")
      if (view === "launcher") assert.equal(await f.page.locator(".new-instance-launcher").count(), 1, "Escape goes up, the launcher stays")
      await f.page.keyboard.press("Escape")
      assert.equal(await f.toggle.getAttribute("aria-expanded"), "false")
      assert.equal(await f.toggle.evaluate((element) => element === document.activeElement), true)
      assert.deepEqual(f.errors, [])
    } finally { await f.page.close() }
  })

  test(`${view}: pasting a pairing link adds the server, which shows at once; an invalid address shows the ordinary error`, async () => {
    const f = await open(view)
    try {
      await f.toggle.click()
      const field = f.menu.getByRole("textbox", { name: "Add server", exact: true })
      await field.fill("not a link")
      await field.press("Enter")
      await f.menu.getByText("Could not connect to the remote server.", { exact: true }).waitFor()
      await field.fill("")
      await field.evaluate((element) => {
        const data = new DataTransfer()
        data.setData("text", "http://127.0.0.1:4555/auth/connect/pasted-code")
        element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }))
      })
      await f.waitCall("add:http://127.0.0.1:4555/auth/connect/pasted-code")
      await f.waitCall("list:oc-new:")
      await f.menu.getByText("127.0.0.1", { exact: true }).waitFor()
      await f.menu.getByRole("button", { name: "Back to servers", exact: true }).click()
      await f.menu.locator('[data-remote-server="oc-new"]').waitFor()
      assert.equal(await f.menu.locator("[data-remote-server]").count(), 2)
      assert.deepEqual(f.errors, [])
    } finally { await f.page.close() }
  })

  test(`${view}: a long bidi server name remains visible in the navigation row beside a long path, also in RTL`, async () => {
    const f = await open(view, true)
    try {
      await f.page.setViewportSize({ width: 390, height: 850 })
      await f.toggle.click()
      const server = f.menu.locator('[data-remote-server="oc-lab"]')
      const fullName = await server.locator("bdi").innerText()
      await server.click()
      await f.menu.locator("[data-remote-folder]").first().waitFor()
      for (const direction of ["ltr", "rtl"]) {
        await f.page.evaluate((dir) => document.documentElement.dir = dir, direction)
        for (const folder of ["app", "lib"]) {
          const header = f.menu.locator(".remote-project-header")
          const name = header.locator("bdi")
          await name.waitFor({ state: "visible" })
          assert.equal(await name.textContent(), fullName)
          assert.equal(await name.getAttribute("title"), fullName)
          assert.equal(await name.getAttribute("dir"), "auto")
          const geometry = await header.evaluate((element) => {
            const name = element.querySelector("bdi")!
            const path = element.querySelector(".remote-project-path")!
            return { name: name.getBoundingClientRect().width, path: path.getBoundingClientRect().width,
              isolated: getComputedStyle(name).unicodeBidi, overflow: element.scrollWidth > element.clientWidth }
          })
          assert.ok(geometry.name > 30, "server has reserved space instead of yielding it all to the path")
          assert.ok(geometry.path > 0)
          assert.equal(geometry.overflow, false)
          assert.equal(geometry.isolated, "isolate")
          await f.menu.locator("[data-remote-folder]").filter({ hasText: new RegExp(`^${folder}$`) }).click()
          await f.page.waitForFunction(() => !document.querySelector(".remote-project-menu[aria-busy=true]"))
          assert.equal(await name.textContent(), fullName)
          await f.menu.getByRole("button", { name: "Parent folder", exact: true }).click()
          await f.page.waitForFunction(() => !document.querySelector(".remote-project-menu[aria-busy=true]"))
        }
      }
      await f.page.keyboard.press("Escape")
      await server.waitFor()
      assert.equal(await server.locator("bdi").textContent(), fullName)
      assert.deepEqual(f.errors, [])
    } finally { await f.page.close() }
  })
}

test("a server is removed from its row's context menu, after the standard confirmation", async () => {
  const f = await open()
  try {
    await f.toggle.click()
    await f.menu.locator('[data-remote-server="oc-lab"]').click({ button: "right" })
    await f.page.getByRole("menuitem", { name: "Remove saved server" }).click()
    const confirm = f.page.getByRole("dialog").filter({ hasText: "Remove Lab?" })
    await confirm.getByRole("button", { name: "Remove saved server" }).click()
    await f.waitCall("remove:oc-lab")
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("the Servers tab keeps remote CodeNomad servers only (R18)", async () => {
  const f = await open()
  try {
    await f.page.getByText("Servers", { exact: true }).click()
    await f.page.getByText("Saved remote", { exact: true }).waitFor()
    assert.equal(await f.page.locator(".panel-list-item").filter({ hasText: "Lab" }).count(), 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})
