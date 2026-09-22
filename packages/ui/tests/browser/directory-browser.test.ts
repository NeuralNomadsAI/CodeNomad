import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

interface Scenario {
  scope: "restricted" | "unrestricted"
  rootPath: string
  homePath: string
  parentPath?: string
}

let server: ViteDevServer, browser: Browser, url: string

function metadataFor(scenario: Scenario, requestedPath?: string | null) {
  let currentPath = requestedPath && requestedPath.length > 0 ? requestedPath : scenario.rootPath
  // Mirror the server: a relative initial path is canonicalized under homePath in
  // unrestricted mode and under rootPath in restricted mode.
  const isAbsolute = currentPath.startsWith("/") || /^[a-zA-Z]:/.test(currentPath)
  if (currentPath !== "." && !isAbsolute) {
    const base = scenario.scope === "unrestricted" ? scenario.homePath : scenario.rootPath
    currentPath = `${base}/${currentPath}`
  }
  return {
    entries: [],
    metadata: {
      scope: scenario.scope,
      currentPath,
      parentPath: scenario.parentPath,
      rootPath: scenario.rootPath,
      homePath: scenario.homePath,
      displayPath: currentPath,
      pathKind: "absolute" as const,
    },
  }
}

async function openFixture(page: Page, scenario: Scenario, query: string): Promise<string[]> {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(String(error)))
  await page.route("**/api/filesystem**", (route) => {
    const request = new URL(route.request().url())
    let requested = request.searchParams.get("path")
    if (!requested && route.request().method() === "POST") {
      try {
        const body = JSON.parse(route.request().postData() ?? "{}")
        requested = body.path
      } catch {
        requested = undefined
      }
    }
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(metadataFor(scenario, requested)),
    })
  })
  await page.goto(`${url}?${query}`)
  await page.locator(".directory-browser-current-path").waitFor()
  return errors
}

const shortcutCount = (page: Page) => page.locator(".directory-browser-shortcut").count()
const pathValue = (page: Page) => page.locator(".directory-browser-current-path").inputValue()

before(async () => {
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("../..", import.meta.url)),
    logLevel: "error",
    plugins: [
      solid(),
      {
        name: "directory-browser-fixture",
        configureServer(s) {
          s.middlewares.use("/directory-browser-fixture", async (_req, res) => {
            res.setHeader("Content-Type", "text/html")
            res.end(
              await s.transformIndexHtml(
                "/directory-browser-fixture",
                '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/directory-browser.tsx"></script></body></html>',
              ),
            )
          })
        },
      },
    ],
    resolve: { dedupe: ["solid-js"] },
    optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/directory-browser-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})

after(async () => {
  await browser?.close()
  await server?.close()
})

test("restricted scope shows only the start-directory shortcut and dedupes the initial path", async () => {
  const page = await browser.newPage()
  const errors = await openFixture(page, { scope: "restricted", rootPath: "/ws", homePath: "/home" }, "initialPath=/ws&mode=directories")
  try {
    // rootPath === initialPath, so the start-directory and initial shortcuts collapse into one.
    assert.equal(await shortcutCount(page), 1)
    // That single shortcut targets /ws, which is also the current path, so it is disabled.
    assert.equal(await page.locator(".directory-browser-shortcut").first().isDisabled(), true)
  } finally {
    assert.deepEqual(errors, [])
    await page.close()
  }
})

test("unrestricted scope shows start-directory, user-home and initial-path shortcuts", async () => {
  const page = await browser.newPage()
  const errors = await openFixture(
    page,
    { scope: "unrestricted", rootPath: "/cwd", homePath: "/home" },
    "initialPath=/projects/start&mode=directories",
  )
  try {
    // rootPath + home + initial path, all distinct.
    assert.equal(await shortcutCount(page), 3)
    // Second shortcut is the home button; clicking it returns to /home.
    await page.locator(".directory-browser-shortcut").nth(1).click()
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>(".directory-browser-current-path")?.value === "/home",
    )
    assert.equal(await pathValue(page), "/home")
  } finally {
    assert.deepEqual(errors, [])
    await page.close()
  }
})

test("edited path field is synced (not left stale) after using a shortcut", async () => {
  const page = await browser.newPage()
  const errors = await openFixture(
    page,
    { scope: "restricted", rootPath: "/ws", homePath: "/home", parentPath: "/ws" },
    "initialPath=/ws/sub&mode=directories",
  )
  try {
    const field = page.locator(".directory-browser-current-path")
    await field.fill("/ws/sub/typed")
    // The start-directory shortcut is the first one in restricted mode.
    await page.locator(".directory-browser-shortcut").first().click()
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>(".directory-browser-current-path")?.value === "/ws",
    )
    assert.equal(await pathValue(page), "/ws")
  } finally {
    assert.deepEqual(errors, [])
    await page.close()
  }
})

test("files mode hides the new-folder action but keeps the shortcuts and open button", async () => {
  const page = await browser.newPage()
  const errors = await openFixture(page, { scope: "restricted", rootPath: "/ws", homePath: "/home" }, "initialPath=/ws&mode=files")
  try {
    assert.equal(await shortcutCount(page), 1)
    assert.equal(await page.locator(".directory-browser-new-folder").count(), 0)
    assert.equal(await page.locator(".directory-browser-open-path").count(), 1)
  } finally {
    assert.deepEqual(errors, [])
    await page.close()
  }
})

test("two-column breakpoint keeps the open button on its own full-width row (directory mode)", async () => {
  const page = await browser.newPage()
  const errors = await openFixture(
    page,
    { scope: "unrestricted", rootPath: "/cwd", homePath: "/home" },
    "initialPath=/projects/start&mode=directories",
  )
  try {
    await page.setViewportSize({ width: 600, height: 900 })
    assert.equal(await shortcutCount(page), 3)
    assert.equal(await page.locator(".directory-browser-open-path").count(), 1)
    const currentBox = await page.locator(".directory-browser-current").boundingBox()
    const openBox = await page.locator(".directory-browser-open-path").boundingBox()
    assert.ok(currentBox && openBox, "layout boxes must be measurable")
    // Open spans the full grid row, so its left/right edges align with the grid container.
    assert.ok(Math.abs(openBox.x - currentBox.x) <= 2, `open left ${openBox.x} should match grid left ${currentBox.x}`)
    assert.ok(
      Math.abs(openBox.x + openBox.width - (currentBox.x + currentBox.width)) <= 2,
      `open right ${openBox.x + openBox.width} should match grid right ${currentBox.x + currentBox.width}`,
    )
  } finally {
    assert.deepEqual(errors, [])
    await page.close()
  }
})

test("two-column breakpoint keeps the open button on its own full-width row (file mode)", async () => {
  const page = await browser.newPage()
  const errors = await openFixture(
    page,
    { scope: "unrestricted", rootPath: "/cwd", homePath: "/home" },
    "initialPath=/projects/start&mode=files",
  )
  try {
    await page.setViewportSize({ width: 600, height: 900 })
    assert.equal(await shortcutCount(page), 3)
    assert.equal(await page.locator(".directory-browser-new-folder").count(), 0)
    const currentBox = await page.locator(".directory-browser-current").boundingBox()
    const openBox = await page.locator(".directory-browser-open-path").boundingBox()
    assert.ok(currentBox && openBox, "layout boxes must be measurable")
    assert.ok(Math.abs(openBox.x - currentBox.x) <= 2, `open left ${openBox.x} should match grid left ${currentBox.x}`)
    assert.ok(
      Math.abs(openBox.x + openBox.width - (currentBox.x + currentBox.width)) <= 2,
      `open right ${openBox.x + openBox.width} should match grid right ${currentBox.x + currentBox.width}`,
    )
  } finally {
    assert.deepEqual(errors, [])
    await page.close()
  }
})

test("unrestricted relative initial path is canonicalized under homePath, not rootPath", async () => {
  const page = await browser.newPage()
  const errors = await openFixture(
    page,
    { scope: "unrestricted", rootPath: "/srv/start", homePath: "/home/user" },
    "initialPath=projects&mode=directories",
  )
  try {
    // The dialog opens at the server-canonicalized location (/home/user/projects), captured as the initial target.
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>(".directory-browser-current-path")?.value === "/home/user/projects",
    )
    assert.equal(await pathValue(page), "/home/user/projects")
    assert.equal(await shortcutCount(page), 3)
    // Navigate to the start directory, then the Initial Path shortcut must return to the captured target.
    await page.locator(".directory-browser-shortcut").nth(0).click()
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>(".directory-browser-current-path")?.value === "/srv/start",
    )
    await page.locator(".directory-browser-shortcut").nth(2).click()
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>(".directory-browser-current-path")?.value === "/home/user/projects",
    )
    assert.equal(await pathValue(page), "/home/user/projects")
  } finally {
    assert.deepEqual(errors, [])
    await page.close()
  }
})

test("initial shortcut is cleared when the dialog reopens without an initial path", async () => {
  const page = await browser.newPage()
  const errors = await openFixture(
    page,
    { scope: "restricted", rootPath: "/ws", homePath: "/home" },
    "initialPath=/ws/start&mode=directories",
  )
  try {
    // First opening captures /ws/start, so root + initial are present (2 shortcuts).
    await page.waitForFunction(() => document.querySelectorAll(".directory-browser-shortcut").length === 2)
    // Close, drop the initial path, and reopen the same mounted dialog.
    await page.evaluate(() => (window as any).directoryBrowserFixture.close())
    await page.evaluate(() => (window as any).directoryBrowserFixture.setInitialPath(""))
    await page.evaluate(() => (window as any).directoryBrowserFixture.open())
    // After reopen with no initial path, only the start-directory shortcut remains.
    await page.waitForFunction(() => document.querySelectorAll(".directory-browser-shortcut").length === 1)
    assert.equal(await shortcutCount(page), 1)
  } finally {
    assert.deepEqual(errors, [])
    await page.close()
  }
})
