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
  const currentPath = requestedPath && requestedPath.length > 0 ? requestedPath : scenario.rootPath
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

async function openFixture(page: Page, scenario: Scenario, query: string) {
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

test("restricted scope shows only the workspace-root shortcut and dedupes the initial path", async () => {
  const page = await browser.newPage()
  try {
    const scenario: Scenario = { scope: "restricted", rootPath: "/ws", homePath: "/home" }
    // initialPath equals rootPath, so the workspace + initial shortcuts collapse into one.
    await openFixture(page, scenario, "initialPath=/ws&mode=directories")
    assert.equal(await shortcutCount(page), 1)
    await page.locator(".directory-browser-shortcut").first().click()
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>(".directory-browser-current-path")?.value === "/ws",
    )
    assert.equal(await pathValue(page), "/ws")
  } finally {
    await page.close()
  }
})

test("unrestricted scope shows start-directory, user-home and initial-path shortcuts", async () => {
  const page = await browser.newPage()
  try {
    const scenario: Scenario = { scope: "unrestricted", rootPath: "/cwd", homePath: "/home" }
    await openFixture(page, scenario, "initialPath=/projects/start&mode=directories")
    // Start directory (rootPath) + home (unrestricted) + initial path, all distinct.
    assert.equal(await shortcutCount(page), 3)
    // Second shortcut is the home button; clicking it returns to /home.
    await page.locator(".directory-browser-shortcut").nth(1).click()
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>(".directory-browser-current-path")?.value === "/home",
    )
    assert.equal(await pathValue(page), "/home")
  } finally {
    await page.close()
  }
})

test("edited path field is synced (not left stale) after using a shortcut", async () => {
  const page = await browser.newPage()
  try {
    const scenario: Scenario = { scope: "restricted", rootPath: "/ws", homePath: "/home", parentPath: "/ws" }
    await openFixture(page, scenario, "initialPath=/ws/sub&mode=directories")
    // Edit the path field without submitting it.
    const field = page.locator(".directory-browser-current-path")
    await field.fill("/ws/sub/typed")
    // The workspace-root shortcut is the only one in restricted mode.
    await page.locator(".directory-browser-shortcut").first().click()
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>(".directory-browser-current-path")?.value === "/ws",
    )
    assert.equal(await pathValue(page), "/ws")
  } finally {
    await page.close()
  }
})

test("files mode hides the new-folder action but keeps the shortcuts and open button", async () => {
  const page = await browser.newPage()
  try {
    const scenario: Scenario = { scope: "restricted", rootPath: "/ws", homePath: "/home" }
    await openFixture(page, scenario, "initialPath=/ws&mode=files")
    assert.equal(await shortcutCount(page), 1)
    assert.equal(await page.locator(".directory-browser-new-folder").count(), 0)
    assert.equal(await page.locator(".directory-browser-open-path").count(), 1)
  } finally {
    await page.close()
  }
})

test("shortcuts and open button remain laid out at narrow widths", async () => {
  const page = await browser.newPage()
  try {
    await page.setViewportSize({ width: 360, height: 800 })
    const scenario: Scenario = { scope: "unrestricted", rootPath: "/cwd", homePath: "/home" }
    await openFixture(page, scenario, "initialPath=/projects/start&mode=directories")
    assert.equal(await shortcutCount(page), 3)
    assert.equal(await page.locator(".directory-browser-open-path").count(), 1)
    // Open button should span the full row at this width, not half.
    const box = await page.locator(".directory-browser-open-path").boundingBox()
    assert.ok(box !== null && box.width >= 300, `open button width ${box?.width} should fill the row`)
  } finally {
    await page.close()
  }
})
