import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser, type Page, type Route } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { PermissionReceipt } from "../../../server/src/api-types"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "receipt-fixture", configureServer(vite) {
      vite.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await vite.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/permission-receipts.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

const receipt = (requestId: string, decision: PermissionReceipt["decision"], extra: Partial<PermissionReceipt> = {}): PermissionReceipt => ({
  requestId, sessionId: "session-a", decision, origin: "codenomad", action: "shell", resources: ["echo hello"],
  source: { messageId: "message-a", callId: "call-a" }, resolvedAt: 10, ...extra,
})
const fulfill = (route: Route, receipts: PermissionReceipt[], next?: string) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ receipts, next }) })
async function prepare(page: Page, handler: (route: Route) => unknown) {
  const errors: string[] = []
  let uiState = {}
  page.on("pageerror", error => { errors.push(error.message); console.error(error) })
  await page.addInitScript(() => {
    ;(window as any).EventSource = class {
      static OPEN = 1; readyState = 1
      addEventListener() {} removeEventListener() {} close() {}
    }
  })
  await page.route("**/api/**", route => {
    if (new URL(route.request().url()).pathname.endsWith("/permission-receipts")) return handler(route)
    if (new URL(route.request().url()).pathname === "/api/storage/state/ui") {
      if (route.request().method() === "PATCH") uiState = { ...uiState, ...route.request().postDataJSON() }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(uiState) })
    }
    return route.fulfill({ contentType: "application/json", body: "{}" })
  })
  return errors
}
async function waitRequests(requests: Route[], count: number) {
  const deadline = Date.now() + 5000
  while (requests.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(requests.length, count)
}

test("durable HTTP receipts survive reload, show every outcome outside hidden tools, and paginate unanchored decisions", async () => {
  const page = await browser.newPage()
  try {
    const requests: string[] = []
    const stored = [receipt("once", "once"), receipt("always", "always", { origin: "yolo" }),
      receipt("reject", "reject", { origin: "native", reason: "Ne supprime pas les fichiers.", requestMessage: "Accès au dossier" })]
    const errors = await prepare(page, route => {
      const query = new URL(route.request().url()).searchParams
      requests.push(query.toString())
      if (query.has("messageId")) return fulfill(route, [...stored, stored[0]])
      return query.has("cursor") ? fulfill(route, [receipt("session-2", "always", { source: undefined })])
        : fulfill(route, [receipt("session-1", "once", { source: undefined })], "page-2")
    })
    await page.goto(url)
    const anchored = page.locator('[data-permission-message="message-a"]')
    await anchored.getByText("Autorisé une fois", { exact: true }).waitFor()
    await anchored.getByText("Toujours autorisé", { exact: true }).waitFor()
    await anchored.getByText("Refusé", { exact: true }).waitFor()
    assert.equal(await anchored.locator("li").count(), 3)
    assert.equal(await page.locator(".tool-call").count(), 0)
    assert.equal(await anchored.getByText("Décision native", { exact: true }).count(), 1)
    assert.equal(await anchored.getByText("Automatique · Yolo", { exact: true }).count(), 1)
    const unanchored = page.locator('[data-permission-message="unanchored"]')
    await unanchored.locator("summary").click()
    await unanchored.getByRole("button", { name: "Charger d’autres décisions" }).click()
    await unanchored.getByText("Toujours autorisé", { exact: true }).waitFor()
    assert.ok(requests.some(query => query.includes("cursor=page-2")))
    if (process.env.CODENOMAD_RECEIPTS_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_RECEIPTS_CAPTURE })
    await page.reload()
    await anchored.getByText("Ne supprime pas les fichiers.", { exact: true }).waitFor()
    assert.equal(await anchored.locator("li").count(), 3)
    await page.goto(`${url}?toolOnly`)
    await anchored.getByText("Autorisé une fois", { exact: true }).waitFor()
    assert.equal(await page.locator(".tool-call").count(), 0, "a tool-only message keeps its receipts when tools are hidden")
    assert.ok(requests.every(query => query.includes("messageId=message-a") || query.includes("unanchored=true")), "only mounted message and unanchored scopes are queried")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("an empty bounded scan page keeps pagination reachable until a receipt is found", async () => {
  const page = await browser.newPage()
  try {
    const errors = await prepare(page, route => new URL(route.request().url()).searchParams.has("cursor")
      ? fulfill(route, [receipt("after-empty-page", "once")])
      : fulfill(route, [], "next-scan"))
    await page.goto(`${url}?direct`)
    const more = page.getByRole("button", { name: "Charger d’autres décisions" })
    await more.click()
    await page.getByText("Autorisé une fois", { exact: true }).waitFor()
    assert.equal(await page.locator('[data-permission-request="after-empty-page"]').count(), 1)
    assert.equal(await more.count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("event bursts reconcile authoritatively with a trailing read, retry preserves snapshots, and stale routes cannot publish", async () => {
  const page = await browser.newPage()
  try {
    const requests: Route[] = []
    const errors = await prepare(page, route => { requests.push(route) })
    await page.goto(`${url}?direct`)
    await waitRequests(requests, 1)
    await fulfill(requests[0], [receipt("one", "once")])
    await page.getByText("Autorisé une fois", { exact: true }).waitFor()
    await page.evaluate(() => (window as any).receiptFixture.event())
    await waitRequests(requests, 2)
    await page.evaluate(() => { for (let i = 0; i < 10; i++) (window as any).receiptFixture.event() })
    await fulfill(requests[1], [receipt("one", "once")])
    await waitRequests(requests, 3)
    await fulfill(requests[2], [receipt("one", "reject", { reason: "Dernière décision" })])
    await page.getByText("Dernière décision", { exact: true }).waitFor()
    await page.evaluate(() => (window as any).receiptFixture.reconnect())
    await waitRequests(requests, 4)
    await requests[3].fulfill({ status: 503, contentType: "application/json", body: '{"error":"offline"}' })
    await page.getByRole("button", { name: "Réessayer" }).waitFor()
    assert.equal(await page.getByText("Dernière décision", { exact: true }).count(), 1)
    await page.getByRole("button", { name: "Réessayer" }).click()
    await waitRequests(requests, 5)
    await page.evaluate(() => (window as any).receiptFixture.select({ instanceId: "other", sessionId: "session-b", messageId: "message-b" }))
    await waitRequests(requests, 6)
    assert.match(requests[5].request().url(), /workspaces\/other\/sessions\/session-b\/permission-receipts\?messageId=message-b/)
    await fulfill(requests[5], [receipt("new", "always", { sessionId: "session-b", source: { messageId: "message-b", callId: "call-b" } })])
    await page.getByText("Toujours autorisé", { exact: true }).waitFor()
    await fulfill(requests[4], [receipt("late", "reject", { reason: "Obsolète" })])
    await page.waitForTimeout(50)
    assert.equal(await page.getByText("Obsolète", { exact: true }).count(), 0)
    await page.evaluate(() => (window as any).receiptFixture.active(false))
    await page.evaluate(() => (window as any).receiptFixture.event())
    await page.waitForTimeout(50)
    assert.equal(requests.length, 6)
    await page.evaluate(() => (window as any).receiptFixture.active(true))
    await waitRequests(requests, 7)
    await fulfill(requests[6], [])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const width of [393, 1100]) for (const theme of ["light", "dark"] as const) {
  test(`long permission resources and reasons wrap with reachable pagination at ${width}px in ${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } })
    try {
      const resource = `D:/workspace/${"long-directory-name-without-spaces/".repeat(9)}release.json`
      const reason = "Ne supprime pas les fichiers de publication. Vérifie les différences et conserve les modifications locales avant de demander une nouvelle autorisation. ".repeat(4)
      const errors = await prepare(page, route => {
        const query = new URL(route.request().url()).searchParams
        const source = query.has("messageId") ? { messageId: "message-a", callId: "call-a" } : undefined
        return fulfill(route, [receipt(query.has("cursor") ? "second" : "long", "reject", {
          source, resources: [resource], reason, origin: "native", requestMessage: "Accès aux fichiers de publication",
        })], query.has("cursor") ? undefined : "next-page")
      })
      await page.goto(url)
      await page.waitForFunction(() => Boolean((window as any).receiptFixture))
      await page.evaluate(theme => (window as any).receiptFixture.theme(theme), theme)
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme)
      const output = process.env.CODENOMAD_RECEIPTS_CAPTURES ?? join(tmpdir(), "opencode")
      await mkdir(output, { recursive: true })
      for (const scope of ["unanchored", "message-a"]) {
        const section = page.locator(`[data-permission-message="${scope}"]`)
        if (scope === "unanchored") await section.locator("summary").click()
        const more = section.getByRole("button", { name: "Charger d’autres décisions" })
        await more.scrollIntoViewIfNeeded()
        const metrics = await section.evaluate(section => {
          const button = section.querySelector("button")!
          const rect = button.getBoundingClientRect()
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          return {
            documentFits: document.documentElement.scrollWidth <= innerWidth,
            contentFits: [section, ...section.querySelectorAll("code, p")].every(element => element.scrollWidth <= element.clientWidth),
            buttonFits: rect.x >= 0 && rect.right <= innerWidth && rect.y >= 0 && rect.bottom <= innerHeight,
            buttonReachable: Boolean(hit && button.contains(hit)),
          }
        })
        assert.deepEqual(metrics, { documentFits: true, contentFits: true, buttonFits: true, buttonReachable: true })
        await page.screenshot({ path: join(output, `permission-receipts-${width}-${theme}-${scope}.png`) })
        await more.click()
        await section.locator('[data-permission-request="second"]').waitFor()
        assert.equal(await section.locator("li").count(), 2)
        assert.equal(await more.count(), 0)
        if (scope === "unanchored") await section.locator("summary").click()
      }
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}
