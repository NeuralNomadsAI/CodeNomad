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
  rejectedPath?: string
  delayedPath?: string
}

let server: ViteDevServer, browser: Browser, url: string

function metadataFor(scenario: Scenario, requestedPath?: string | null) {
  let currentPath = requestedPath || scenario.rootPath
  if (currentPath === ".") currentPath = scenario.rootPath
  if (currentPath !== "." && !currentPath.startsWith("/") && !/^[a-zA-Z]:/.test(currentPath)) {
    currentPath = `${scenario.scope === "unrestricted" ? scenario.homePath : scenario.rootPath}/${currentPath}`
  }
  const relative = currentPath === scenario.rootPath ? "." : currentPath.slice(scenario.rootPath.length).replace(/^\//, "")
  const parentPath = scenario.scope === "restricted"
    ? relative === "." ? undefined : relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "."
    : currentPath === "/" ? undefined : currentPath.includes("/") ? currentPath.slice(0, currentPath.lastIndexOf("/")) || "/" : undefined
  const entries = currentPath.endsWith("/start") ? ["projects", "pictures"].map((name) => ({
    name, type: "directory" as const,
    path: scenario.scope === "restricted" ? `${relative}/${name}` : `${currentPath}/${name}`,
    absolutePath: `${currentPath}/${name}`,
  })) : []
  return {
    entries,
    metadata: {
      scope: scenario.scope, currentPath: scenario.scope === "restricted" ? relative : currentPath,
      parentPath, rootPath: scenario.rootPath, homePath: scenario.homePath,
      displayPath: currentPath, pathKind: scenario.scope === "restricted" ? "relative" as const : "absolute" as const,
    },
  }
}

async function openFixture(page: Page, scenario: Scenario, query: string): Promise<string[]> {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(String(error)))
  await page.route("**/api/filesystem**", async (route) => {
    const request = new URL(route.request().url())
    let requested = request.searchParams.get("path")
    if (!requested && route.request().method() === "POST") {
      requested = JSON.parse(route.request().postData() ?? "{}").path
    }
    if (requested === scenario.rejectedPath) {
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Missing folder" }) })
    }
    if (requested === scenario.delayedPath) await new Promise((resolve) => setTimeout(resolve, 600))
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(metadataFor(scenario, requested)) })
  })
  await page.goto(`${url}?${query}`)
  await page.locator(".directory-browser-current-path").waitFor()
  return errors
}

const field = (page: Page) => page.locator(".directory-browser-current-path")
const options = (page: Page) => page.locator(".directory-browser-destination")

before(async () => {
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("../..", import.meta.url)),
    logLevel: "error",
    plugins: [solid(), {
      name: "directory-browser-fixture",
      configureServer(s) {
        s.middlewares.use("/directory-browser-fixture", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await s.transformIndexHtml("/directory-browser-fixture",
            '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/directory-browser.tsx"></script></body></html>'))
        })
      },
    }],
    resolve: { dedupe: ["solid-js"] },
    optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/directory-browser-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})

after(async () => { await browser?.close(); await server?.close() })

test("restricted browser offers parent and loaded children without the server-root shortcut", async () => {
  const page = await browser.newPage()
  const errors = await openFixture(page, { scope: "restricted", rootPath: "/ws", homePath: "/home" }, "initialPath=/ws/start&mode=directories")
  try {
    await field(page).focus()
    assert.deepEqual(await options(page).allTextContents(), ["Dossier parent"])
    await field(page).fill("/ws/start/pro")
    assert.deepEqual(await options(page).allTextContents(), ["Dossier parent", "projects"])
    await options(page).filter({ hasText: "projects" }).click()
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>(".directory-browser-current-path")?.value === "/ws/start/projects")
    await field(page).click()
    assert.match(await options(page).first().innerText(), /Revenir à start/)
    await options(page).first().click()
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>(".directory-browser-current-path")?.value === "/ws/start")
    assert.equal(await field(page).inputValue(), "/ws/start")
  } finally { assert.deepEqual(errors, []); await page.close() }
})

test("typing filters children; arrow and Enter navigate, while Enter with no selection submits the typed path", async () => {
  const page = await browser.newPage()
  const errors = await openFixture(page, { scope: "restricted", rootPath: "/ws", homePath: "/home" }, "initialPath=/ws/start&mode=directories")
  try {
    await field(page).fill("/ws/start/pic")
    assert.deepEqual(await options(page).allTextContents(), ["Dossier parent", "pictures"])
    await field(page).press("ArrowDown")
    await field(page).press("ArrowDown")
    assert.equal(await field(page).getAttribute("aria-expanded"), "true")
    assert.equal(await field(page).getAttribute("aria-activedescendant"), await options(page).nth(1).getAttribute("id"))
    await field(page).press("Enter")
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>(".directory-browser-current-path")?.value === "/ws/start/pictures")
    assert.equal(await field(page).inputValue(), "/ws/start/pictures")
    await field(page).fill("/ws/other")
    await field(page).press("Enter")
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>(".directory-browser-current-path")?.value === "/ws/other")
    assert.equal(await field(page).inputValue(), "/ws/other")
  } finally { assert.deepEqual(errors, []); await page.close() }
})

test("Escape restores an unsubmitted edit without dismissing the dialog", async () => {
  const page = await browser.newPage()
  const errors = await openFixture(page, { scope: "restricted", rootPath: "/ws", homePath: "/home" }, "initialPath=/ws/start&mode=directories")
  try {
    await field(page).fill("/ws/unsubmitted")
    await field(page).press("Escape")
    assert.equal(await field(page).inputValue(), "/ws/start")
    assert.equal(await page.getByRole("dialog").count(), 1)
    assert.equal(await options(page).count(), 0)
  } finally { assert.deepEqual(errors, []); await page.close() }
})

test("unrestricted relative start is offered by canonical home path after navigating away", async () => {
  const page = await browser.newPage()
  const errors = await openFixture(page, { scope: "unrestricted", rootPath: "/srv", homePath: "/home/user" }, "initialPath=projects&mode=files")
  try {
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>(".directory-browser-current-path")?.value === "/home/user/projects")
    assert.equal(await page.locator(".directory-browser-new-folder").count(), 0)
    await field(page).focus()
    assert.equal((await options(page).allTextContents()).includes("Accueil"), true)
    await options(page).filter({ hasText: "Accueil" }).click()
    await field(page).click()
    assert.match(await options(page).first().innerText(), /Revenir à projects/)
    await options(page).first().click()
    assert.equal(await field(page).inputValue(), "/home/user/projects")
  } finally { assert.deepEqual(errors, []); await page.close() }
})

test("failed start falls back without offering a broken return", async () => {
  const page = await browser.newPage()
  const errors = await openFixture(page, { scope: "restricted", rootPath: "/ws", homePath: "/home", rejectedPath: "/missing" }, "initialPath=/missing")
  try {
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>(".directory-browser-current-path")?.value === "/ws")
    await field(page).focus()
    assert.equal(await options(page).count(), 0)
  } finally { assert.deepEqual(errors, []); await page.close() }
})

test("reopening clears the previous start destination", async () => {
  const page = await browser.newPage()
  const errors = await openFixture(page, { scope: "restricted", rootPath: "/ws", homePath: "/home" }, "initialPath=/ws/start")
  try {
    await page.evaluate(() => (window as any).directoryBrowserFixture.close())
    await page.evaluate(() => (window as any).directoryBrowserFixture.setInitialPath(""))
    await page.evaluate(() => (window as any).directoryBrowserFixture.open())
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>(".directory-browser-current-path")?.value === "/ws")
    await field(page).focus()
    assert.equal(await options(page).count(), 0)
  } finally { assert.deepEqual(errors, []); await page.close() }
})

test("a navigation finishing after close and reopen cannot replace the new location", async () => {
  const page = await browser.newPage()
  const errors = await openFixture(page,
    { scope: "restricted", rootPath: "/ws", homePath: "/home", delayedPath: "/ws/start/projects" },
    "initialPath=/ws/start")
  try {
    const request = page.waitForRequest((request) => request.url().includes("start%2Fprojects"))
    await field(page).fill("/ws/start/pro")
    await options(page).filter({ hasText: "projects" }).click()
    await request
    await page.evaluate(() => (window as any).directoryBrowserFixture.close())
    await page.evaluate(() => (window as any).directoryBrowserFixture.setInitialPath(""))
    await page.evaluate(() => (window as any).directoryBrowserFixture.open())
    await page.waitForTimeout(800)
    assert.equal(await field(page).inputValue(), "/ws")
    await field(page).click()
    assert.equal(await options(page).count(), 0)
  } finally { assert.deepEqual(errors, []); await page.close() }
})

for (const mode of ["directories", "files"] as const) {
  for (const width of [600, 360]) {
  test(`address dropdown stays inside the dialog and Open occupies its own row at ${width}px (${mode})`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors = await openFixture(page, { scope: "unrestricted", rootPath: "/srv", homePath: "/home" }, `initialPath=/srv/start&mode=${mode}`)
    try {
      await field(page).focus()
      const address = await page.locator(".directory-browser-address").boundingBox()
      const dropdown = await page.locator(".directory-browser-destinations").boundingBox()
      const current = await page.locator(".directory-browser-current").boundingBox()
      const open = await page.locator(".directory-browser-open-path").boundingBox()
      assert.ok(address && dropdown && current && open)
      assert.ok(dropdown.x >= current.x - 2 && dropdown.x + dropdown.width <= current.x + current.width + 2)
      assert.ok(open.y >= address.y + address.height)
      assert.ok(open.y >= dropdown.y + dropdown.height, "Open must stay reachable below the suggestions")
      assert.ok(Math.abs(open.x - current.x) < 2 && Math.abs(open.x + open.width - current.x - current.width) < 2)
      if (mode === "files") assert.ok(open.y - address.y - address.height < 50, "file mode must not reserve a new-folder row")
    } finally { assert.deepEqual(errors, []); await page.close() }
  })
  }
}
