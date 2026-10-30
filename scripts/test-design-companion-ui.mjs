// Browser half of scripts/test-design-companion-native.mjs: the S8 path (AC-52) through the real
// Design extension, right panel, API 4 routes and channel, composer and transcript, against the
// isolated runtime; and the transcript's relative Markdown image of a read image (AC-54).
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { tsImport } from "tsx/esm/api"
import replyFrom from "@fastify/reply-from"
import pino from "pino"
import { loadPruningUIDependencies } from "./test-session-pruning-ui.mjs"

const load = file => tsImport(`../packages/server/src/${file}`, import.meta.url)
// Vite loads before the native preamble (see test-session-pruning-ui.mjs).
export const loadDesignCompanionUIDependencies = () => loadPruningUIDependencies()

export async function testDesignCompanionUI({ cli, client, url, password, root, location, sessionID, designZip, until, idle }) {
  const { uiRoot, chromium, createServer, solid, Fastify } = await loadPruningUIDependencies()
  const { registerInstanceProxyRoutes } = await load("server/http-server.ts")
  const { OpenCodeCliService } = await load("workspaces/opencode-cli-service.ts")
  const { OpenCodeSharedService } = await load("workspaces/opencode-service.ts")
  const { PanelExtensionStore } = await load("panel-extensions/store.ts")
  const { readPanelExtensionArchive } = await load("panel-extensions/archive.ts")
  const { registerPanelExtensionRoutes } = await load("server/routes/panel-extensions.ts")
  const { registerPanelExtensionApi4Routes } = await load("server/routes/panel-extension-api4.ts")
  const { WorktreeDeletionFence } = await load("workspaces/worktree-session-evacuation.ts")
  const { PluginControls } = await load("opencode/plugin-controls.ts")
  const { ImageSettings } = await load("opencode/image-settings.ts")

  const instanceId = "design-ui", directory = location.directory
  // The production shared-service connection; its lifecycle answers from the isolated daemon
  // and never runs a service command.
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const lifecycle = new OpenCodeCliService({ label: "Isolated Design companion", timeoutMs: 5000, command: args => ({ command: cli, args, options: {} }) },
    { execFile: async (_file, args) => ({ stdout: args.join(" ") === "service get password" ? password : url, stderr: "" }) })
  const sharedService = new OpenCodeSharedService()
  await sharedService.client({ kind: "lifecycle", identity: "isolated-design-companion", lifecycle })
  const connection = await sharedService.acquire()
  const endpoint = connection.endpoint, runtimeFetch = connection.fetch
  const owns = candidate => path.resolve(candidate) === path.resolve(directory)
  const workspaceManager = {
    get: id => id === instanceId ? { id, path: directory } : undefined,
    getSharedServiceEndpoint: async () => endpoint, getSharedServiceConnection: async () => connection,
    getInstanceAuthorizationHeader: () => authorization,
    getServiceDirectory: () => directory, getServiceLocation: () => location, getWorktrees: async () => ({ worktrees: [] }),
    getSharedServiceClient: async () => connection.client, getSharedServiceFetch: async () => runtimeFetch, desktopPluginsReady: async () => {},
    getSessionEnvironment: async () => (await load("workspaces/session-environment.ts")).sessionEnvironment({}),
    getWorktreeIdentityForPath: async (_id, candidate) => owns(candidate) ? "isolated-fixture" : undefined,
    getServiceDirectoryForPath: async (_id, candidate) => owns(candidate) ? directory : undefined,
    ownsDirectory: async (_id, candidate) => owns(candidate), ownsPath: async (_id, candidate) => owns(candidate),
    ownsLocation: async (id, candidate) => id === instanceId && owns(candidate.directory) && candidate.workspaceID === location.workspaceID,
    getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
    getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id, value) => value,
  }
  const logger = pino({ level: process.env.CODENOMAD_FIXTURE_LOG_LEVEL || "silent" })
  const store = new PanelExtensionStore(path.join(root, "panel-extensions"))
  const installed = await readPanelExtensionArchive(await readFile(designZip))
  assert.equal(installed.manifest.id, "neuralnomads.design")
  await store.install(installed)
  await store.activate(installed.manifest.id, installed.digest, true)
  const worktreeDeletionFence = new WorktreeDeletionFence()
  const imageSettings = new ImageSettings(new PluginControls({ workspaceManager, worktreeDeletionFence, logger }), workspaceManager)
  const broker = Fastify()
  await broker.register(replyFrom)
  registerInstanceProxyRoutes(broker, { workspaceManager, worktreeDeletionFence: { enter: () => () => {} }, logger })
  registerPanelExtensionRoutes(broker, { store, workspaceManager })
  registerPanelExtensionApi4Routes(broker, { store, workspaceManager, worktreeDeletionFence, imageSettings })
  // Like production's multiplexed stream, the server owns the native subscriber.
  broker.get("/fixture-events", async (request, reply) => {
    const abort = new AbortController()
    reply.hijack()
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
    reply.raw.on("close", () => abort.abort())
    try {
      for await (const event of client.event.subscribe({ signal: abort.signal })) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
    } catch (error) { if (!abort.signal.aborted) reply.raw.destroy(error) }
    finally { reply.raw.end() }
  })
  await broker.listen({ host: "127.0.0.1", port: 0 })
  const brokerUrl = `http://127.0.0.1:${broker.server.address().port}`
  const server = await createServer({
    configFile: false, root: uiRoot, logLevel: "error", plugins: [solid(), {
      name: "design-companion-fixture",
      configureServer(vite) {
        vite.middlewares.use("/fixture", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await vite.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/design-companion.tsx"></script></body></html>'))
        })
      },
    }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null, proxy: {
      [`/workspaces/${instanceId}/instance`]: { target: brokerUrl }, "/api/panel-extensions": { target: brokerUrl }, "/fixture-events": { target: brokerUrl },
    } },
  })
  let browser, page
  const pageErrors = []
  try {
    await server.listen()
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
    page = await browser.newPage({ viewport: { width: 1400, height: 950 }, locale: "en-US" })
    page.on("pageerror", error => { pageErrors.push(error.message); console.error("UI error:", error.stack ?? error.message) })
    page.on("response", response => { if (response.status() >= 400) console.error("UI response", response.status(), response.request().method(), response.url()) })
    page.on("console", message => { if (message.type() === "error") console.error("UI console:", message.text().slice(0, 500)) })
    // The host's own event transport stays steady, as in the browser suite; native events
    // reach the page through the fixture stream only.
    await page.addInitScript(() => {
      const Native = window.EventSource
      window.EventSource = class extends Native {
        constructor(url, init) {
          if (String(url).includes("/fixture-events")) super(url, init)
          else return { readyState: 1, addEventListener() {}, removeEventListener() {}, close() {} }
        }
      }
    })
    // Every other host route answers empty, as in the browser suite.
    await page.route(url => url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/panel-extensions"),
      route => route.fulfill({ json: { entries: [], files: [], records: [], messages: [], data: [] } }))
    const before = (await client.message.list({ sessionID, limit: 200, order: "asc" })).data.length
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/fixture?session=${sessionID}&directory=${encodeURIComponent(directory)}`)
    await page.waitForFunction(() => Boolean(window.fixture?.eventsReady()), undefined, { timeout: 60_000 })
    await page.getByRole("tab", { name: "Design", exact: true }).click()
    const frame = page.frameLocator("iframe[title='Design']")

    // S8: the completed generation without read-back, and its request prefilled, never sent.
    const unread = frame.locator('li.gen[data-state="no-read"]')
    await unread.getByText("No read-back image attached", { exact: true }).waitFor({ timeout: 30_000 })
    assert.equal(await frame.locator('.tile[data-origin="unverifiable"]').count(), 0)
    assert.equal(await frame.locator(".tile").count(), 3, "the three proven images are in the gallery")
    await unread.getByRole("button", { name: "Ask the agent to show it", exact: true }).click()
    const expected = "Read the generated image `.codenomad/design/icon/icon-mono-a.png` and show it here with your critique."
    await page.waitForFunction(text => window.fixture.snapshot().draft === text, expected, { timeout: 20_000 })
    await page.waitForFunction(() => window.fixture.snapshot().focused)
    assert.equal((await client.message.list({ sessionID, limit: 200, order: "asc" })).data.length, before, "prefilling sends nothing")
    await page.screenshot({ path: path.join(root, "ui-prefilled.png") })

    // The user sends it from the real composer.
    await page.locator("button.send-button").click()
    await until("the scripted model's late read-back", async () => (await client.message.list({ sessionID, limit: 200, order: "asc" })).data
      .some(message => message.type === "assistant" && message.content.some(part => part.type === "text" && part.text.includes("Here it is"))), 120_000)
    await idle()
    const sent = (await client.message.list({ sessionID, limit: 200, order: "asc" })).data.filter(message => message.type === "user")
    assert.equal(sent.at(-1)?.text ?? sent.at(-1)?.content?.find?.(part => part.type === "text")?.text, expected, "the prefilled request is what was sent")

    // The late read appears in the panel with its pixels and an unverifiable origin.
    const fileUri = `data:image/png;base64,${(await readFile(path.join(directory, ".codenomad", "design", "icon", "icon-mono-a.png"))).toString("base64")}`
    const late = frame.locator('.tile[data-origin="unverifiable"]')
    await late.filter({ hasText: "icon-mono-a" }).waitFor({ timeout: 30_000 })
    assert.match(await late.textContent(), /origin not verifiable/)
    const preview = late.locator(".preview img")
    await preview.waitFor({ timeout: 20_000 })
    // Decoded in the image's own document (the frame's `blob:` URLs belong to its opaque origin).
    const samePixels = image => image.evaluate(async (element, file) => {
      const draw = async source => {
        const decoded = new Image(); decoded.src = source; await decoded.decode()
        const canvas = document.createElement("canvas"); canvas.width = decoded.naturalWidth; canvas.height = decoded.naturalHeight
        const context = canvas.getContext("2d"); context.drawImage(decoded, 0, 0)
        return { size: [canvas.width, canvas.height], data: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data) }
      }
      const [shown, expected] = [await draw(element.src), await draw(file)]
      return JSON.stringify(shown.size) === JSON.stringify(expected.size) && shown.data.every((value, index) => value === expected.data[index])
    }, fileUri)
    assert.equal(await samePixels(preview), true, "the panel shows the file's pixels")
    await late.click()
    const detail = frame.locator("#selection")
    await detail.getByText("origin not verifiable", { exact: true }).waitFor()
    assert.equal(await detail.locator("dd.prompt").count(), 0, "an unverifiable image shows no prompt")
    assert.doesNotMatch(await detail.textContent(), /Monochrome app icon/)
    await page.screenshot({ path: path.join(root, "ui-late-read.png") })
    console.log("PASS AC-52 browser: no read-back shown, request prefilled and sent from the composer, late read with pixels and unverifiable origin in the panel")

    // AC-54: the answer's relative Markdown image shows the read image in the real transcript.
    const answer = page.locator(".markdown-local-image[data-local-image='.codenomad/design/icon/icon-mono-a.png']")
    await page.waitForFunction(() => {
      const image = document.querySelector("img.markdown-local-image[data-local-image='.codenomad/design/icon/icon-mono-a.png']")
      return Boolean(image?.complete && image.naturalWidth === 16)
    }, undefined, { timeout: 30_000 })
    assert.equal(await answer.count(), 1)
    assert.equal(await samePixels(answer), true, "the transcript shows the read file's pixels")
    assert.equal(await page.locator("span.markdown-local-image").count(), 0, "no unresolved local-image label")
    await page.screenshot({ path: path.join(root, "ui-transcript.png") })
    console.log("PASS AC-54: relative Markdown ![](.codenomad/design/...) of a read image renders it in the real transcript")
    assert.deepEqual(pageErrors, [], "no browser errors")
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(root, "ui-failure.png"), fullPage: true }).catch(() => {})
      console.error("UI sessions:", JSON.stringify(await page.evaluate(() => window.fixture?.sessions?.()).catch(String)).slice(0, 2000))
    }
    throw error
  } finally {
    await browser?.close()
    await server.close()
    await broker.close()
    await sharedService.shutdown()
  }
}
