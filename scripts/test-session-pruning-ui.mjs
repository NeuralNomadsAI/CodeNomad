import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { createRequire } from "node:module"
import { tsImport } from "tsx/esm/api"
import replyFrom from "@fastify/reply-from"
import pino from "pino"

// Called only by the explicit, isolated native fixture (never service discovery).
export async function testPruningUI({ client, baseUrl, root, location, generate, busy, connection }) {
  const uiRoot = fileURLToPath(new URL("../packages/ui/", import.meta.url))
  const requireUI = createRequire(path.join(uiRoot, "package.json"))
  const { chromium } = requireUI("playwright")
  const { createServer } = await import("vite")
  const { default: solid } = await import("vite-plugin-solid")
  const { default: Fastify } = await import("fastify")
  const { registerSessionPruningRoutes } = await tsImport("../packages/server/src/server/routes/session-pruning.ts", import.meta.url)
  const { registerInstanceProxyRoutes } = await tsImport("../packages/server/src/server/http-server.ts", import.meta.url)
  const { createRuntimeFetch } = await tsImport("../packages/server/src/opencode/compatibility/transport.ts", import.meta.url)
  const { rememberRuntime } = await tsImport("../packages/server/src/opencode/compatibility/runtime.ts", import.meta.url)
  const { locationRequestOptions } = await tsImport("../packages/server/src/opencode/compatibility/location.ts", import.meta.url)
  const endpoint = connection?.endpoint ?? { url: baseUrl, auth: { type: "basic", username: "opencode", password: "isolated-pruning-fixture" } }
  if (!connection) rememberRuntime(endpoint, { ...await client.server.info(), discovery: "info" })
  const runtimeFetch = connection?.fetch ?? createRuntimeFetch(endpoint)
  const owns = candidate => path.resolve(candidate) === path.resolve(location.directory)
  const workspaceManager = {
    get: () => ({ id: "pruning-ui", path: location.directory }),
    getSharedServiceEndpoint: async () => endpoint,
    ...(connection ? { getSharedServiceConnection: async () => connection } : {}),
    getInstanceAuthorizationHeader: () => `Basic ${Buffer.from("opencode:isolated-pruning-fixture").toString("base64")}`,
    getServiceDirectory: () => location.directory,
    getServiceLocation: () => location,
    getWorktrees: async () => ({ worktrees: [] }),
    getSharedServiceClient: async () => client,
    getSessionEnvironment: async () => {
      const { sessionEnvironment } = await tsImport("../packages/server/src/workspaces/session-environment.ts", import.meta.url)
      return sessionEnvironment({})
    },
    getSharedServiceFetch: async () => runtimeFetch,
    getWorktreeIdentityForPath: async (_id, directory) => owns(directory) ? "isolated-fixture" : undefined,
    ownsDirectory: async (_id, directory) => owns(directory),
    ownsPath: async (_id, candidate) => owns(candidate),
    ownsLocation: async (id, candidate) => id === "pruning-ui" && owns(candidate.directory) && candidate.workspaceID === location.workspaceID,
  }
  const dependencies = { workspaceManager, worktreeDeletionFence: { enter: () => () => {} }, logger: pino({ level: "silent" }) }
  const broker = Fastify()
  await broker.register(replyFrom)
  registerSessionPruningRoutes(broker, dependencies)
  registerInstanceProxyRoutes(broker, dependencies)
  // Like production's multiplexed stream, the server owns the native subscriber.
  // No generic event/RPC path is added to the guarded instance proxy for tests.
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
  const server = await createServer({
    configFile: false, root: uiRoot, logLevel: "error", plugins: [solid(), {
      name: "native-pruning-fixture",
      configureServer(server) {
        server.middlewares.use("/fixture", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await server.transformIndexHtml("/fixture", '<html><body><div id="root" style="display:flex;flex-direction:column;height:900px;width:1200px"></div><script type="module" src="/tests/browser/fixtures/pruning.tsx"></script></body></html>'))
        })
      },
    }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null, proxy: {
      "/workspaces/pruning-ui/instance": { target: `http://127.0.0.1:${broker.server.address().port}` },
      "/api/workspaces/pruning-ui/session-pruning": { target: `http://127.0.0.1:${broker.server.address().port}` },
      "/api/workspaces/pruning-ui/session-history": { target: `http://127.0.0.1:${broker.server.address().port}` },
      "/fixture-events": { target: `http://127.0.0.1:${broker.server.address().port}` },
    } },
  })
  let browser, page
  const pageErrors = []
  try {
    await server.listen()
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
    const session = await client.session.create({ location }, locationRequestOptions(location))
    await generate(session.id)
    page = await browser.newPage({ viewport: { width: 1250, height: 950 }, locale: "en-US" })
    page.on("pageerror", error => { pageErrors.push(error.message); console.error("UI error:", error.message) })
    page.on("response", async response => {
      if (response.url().includes("/session-pruning/prune")) console.log("UI broker", response.status(), await response.text())
    })
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/fixture?session=${session.id}`)
    await page.waitForFunction(() => Boolean(window.fixture), { timeout: 30_000 })
    await page.evaluate(() => window.fixture.preferences())
    await page.waitForFunction(() => window.fixture.eventsReady())
    await page.evaluate(() => window.fixture.reload())
    await generate(session.id)
    await page.waitForFunction(() => window.fixture.snapshot().filter(message => message.role === "assistant").length >= 6 && window.fixture.snapshot().every(message => message.status === "complete"))
    await page.screenshot({ path: path.join(root, "ui-before.png"), fullPage: true })
    const before = (await client.message.list({ sessionID: session.id, limit: 100, order: "asc" })).data
    const tools = before.filter(message => message.type === "assistant" && message.content.some(part => part.type === "tool"))
    const selected = tools.at(-1)
    const tool = selected.content.find(part => part.type === "tool")
    const row = page.locator(`.tool-call[data-message-id="${selected.id}"][data-part-id="${tool.id}"]`)
    // Expand the first collapsed tools group, then use the actual per-tool trash button.
    const expand = page.locator(".message-exploration-group .message-technical-group-toggle")
    for (const button of await expand.all()) if (await button.getAttribute("aria-expanded") === "false") await button.click()
    await row.locator(".tool-call-header").first().hover()
    const finish = await busy(session.id)
    try {
      await page.waitForFunction(() => window.fixture.snapshot().some(message => Object.values(message.parts).some(part => part.data.text === "Keep this request in flight")))
      await row.getByRole("button", { name: "Delete", exact: true }).focus()
      await row.getByRole("button", { name: "Delete", exact: true }).click()
      await page.getByRole("dialog").waitFor()
      assert.match(await page.getByRole("dialog").textContent(), /storage is busy/)
      assert.deepEqual((await client.session.message.get({ sessionID: session.id, messageID: selected.id })).content, selected.content)
      await page.screenshot({ path: path.join(root, "ui-busy.png") })
      await page.getByRole("dialog").getByRole("button", { name: "OK", exact: true }).click()
    } finally { await finish() }
    console.log("PASS: UI active-session refusal explains busy and preserves content")
    const clickDelete = async (locator, messageIDs) => {
      await locator.hover()
      const responses = messageIDs.map(messageID => page.waitForResponse(response =>
        response.url().includes("/session-pruning/prune") && response.request().postDataJSON().messageID === messageID))
      await locator.getByRole("button", { name: "Delete", exact: true }).focus()
      await locator.getByRole("button", { name: "Delete", exact: true }).click()
      for (const response of responses) assert.equal((await (await response).json()).status, "pruned")
    }
    await clickDelete(row.locator(".tool-call-header"), [selected.id])
    const updated = await client.session.message.get({ sessionID: session.id, messageID: selected.id })
    assert.deepEqual(updated.content, selected.content.filter(part => part !== tool), "single tool deleted persistently")
    await page.waitForFunction(id => !window.fixture.snapshot().find(message => message.id === id.message)?.partIds.includes(id.part), { message: selected.id, part: tool.id })
    console.log("PASS: UI single tool deletion")
    const reasoning = page.locator(`.message-reasoning-card[data-part-id="${selected.id}-reasoning-0"]`)
    await clickDelete(reasoning.locator(".message-reasoning-header"), [selected.id])
    assert.deepEqual((await client.session.message.get({ sessionID: session.id, messageID: selected.id })).content, updated.content.filter(part => part.type !== "reasoning"))
    await page.waitForFunction(id => {
      const message = window.fixture.snapshot().find(message => message.id === id)
      return message && message.partIds.every(part => message.parts[part].data.type !== "reasoning")
    }, selected.id)
    console.log("PASS: UI single reasoning deletion")

    const groupTarget = tools.at(-2)
    const group = page.locator(`.message-stream-block[data-message-id="${groupTarget.id}"] .message-exploration-group`).first()
    // A collapsed group exposes a single trash action for every member.
    const toggle = group.locator(".message-technical-group-toggle").first()
    if (await toggle.getAttribute("aria-expanded") === "true") await toggle.click()
    // Deleting the selected reasoning joined these tools across two messages.
    // The first RPC acknowledgement is only partial group completion. Starting
    // response cleanup there races the second prune and correctly fails its
    // stale-selection guard. Await and verify every member of the rendered group.
    await clickDelete(group.locator(".message-technical-group-header").first(), [groupTarget.id, selected.id])
    await page.waitForFunction(ids => ids.every(id => {
      const message = window.fixture.snapshot().find(message => message.id === id)
      return message && message.partIds.every(part => message.parts[part].data.type !== "tool")
    }), [groupTarget.id, selected.id])
    assert.deepEqual((await client.session.message.get({ sessionID: session.id, messageID: groupTarget.id })).content, groupTarget.content.filter(part => part.type !== "tool"))
    assert.deepEqual((await client.session.message.get({ sessionID: session.id, messageID: selected.id })).content, [])
    console.log("PASS: UI whole tool group deletion")

    const responseAction = page.getByRole("button", { name: "Remove tools and reasoning from this response", exact: true }).last()
    await responseAction.locator('xpath=ancestor::div[contains(@class,"message-item-header-row")][1]').hover()
    await responseAction.focus()
    await responseAction.click()
    await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click()
    await page.waitForFunction(ids => ids.every(id => window.fixture.snapshot().find(message => message.id === id)?.partIds.length === 0), [groupTarget.id, selected.id])
    console.log("PASS: UI response cleanup after cross-message group deletion")

    const firstGroup = page.locator(`.message-stream-block[data-message-id="${tools[0].id}"] .message-exploration-group`).first()
    const firstToggle = firstGroup.locator(".message-technical-group-toggle").first()
    if (await firstToggle.getAttribute("aria-expanded") === "true") await firstToggle.click()
    await clickDelete(firstGroup.locator(".message-technical-group-header").first(), [tools[0].id])
    // Removing intervening tools joins the two adjacent reasoning blocks into a group.
    const thoughts = page.locator(`.message-stream-block[data-message-id="${tools[0].id}"] .message-reasoning-group`).first()
    const thoughtsToggle = thoughts.locator(".message-technical-group-toggle").first()
    if (await thoughtsToggle.getAttribute("aria-expanded") === "true") await thoughtsToggle.click()
    await clickDelete(thoughts.locator(".message-technical-group-header").first(), tools.slice(0, 2).map(message => message.id))
    await page.waitForFunction(ids => ids.every(id => {
      const message = window.fixture.snapshot().find(message => message.id === id)
      return message && message.partIds.every(part => message.parts[part].data.type !== "reasoning")
    }), tools.slice(0, 2).map(message => message.id))
    console.log("PASS: UI reasoning group deletion across messages")

    await generate(session.id)
    const fresh = (await client.message.list({ sessionID: session.id, limit: 100, order: "asc" })).data
    const freshTechnical = fresh.filter(message => !before.some(original => original.id === message.id)
      && message.type === "assistant" && message.content.some(part => part.type === "tool"))
    assert.equal(freshTechnical.length, 2)
    await page.waitForFunction(ids => ids.every(id => window.fixture.snapshot().some(message => message.id === id && message.status === "complete")), fresh.map(message => message.id))
    await responseAction.locator('xpath=ancestor::div[contains(@class,"message-item-header-row")][1]').hover()
    await responseAction.focus()
    await responseAction.click()
    assert.match(await page.getByRole("dialog").textContent(), /Tool outputs: 4; reasoning blocks: 2/)
    await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click()
    await page.waitForFunction(ids => ids.every(id => window.fixture.snapshot().find(message => message.id === id)?.partIds.length === 0), freshTechnical.map(message => message.id))
    for (const message of freshTechnical) assert.deepEqual((await client.session.message.get({ sessionID: session.id, messageID: message.id })).content, [])
    console.log("PASS: UI response confirmation removes both tools and reasoning across messages")

    await generate(session.id)
    const all = (await client.message.list({ sessionID: session.id, limit: 100, order: "asc" })).data
    await page.waitForFunction(ids => ids.every(id => window.fixture.snapshot().some(message => message.id === id && message.status === "complete")), all.map(message => message.id))
    await page.getByRole("button", { name: "Remove Session Tools and Reasoning", exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click()
    await page.waitForFunction(() => window.fixture.snapshot().filter(message => message.role === "assistant").every(message => message.partIds.every(id => !["tool", "reasoning"].includes(message.parts[id].data.type))))
    const after = (await client.message.list({ sessionID: session.id, limit: 100, order: "asc" })).data
    assert(after.filter(message => message.type === "assistant").every(message => message.content.every(part => !["tool", "reasoning"].includes(part.type))))
    for (const original of [...before, ...all]) {
      const current = after.find(message => message.id === original.id)
      assert.deepEqual(current, original.type === "assistant" ? { ...original, content: original.content.filter(part => !["tool", "reasoning"].includes(part.type)) } : original)
    }
    assert.deepEqual(await page.getByRole("dialog").allTextContents(), [], "Cleanup must finish without a failure dialog")
    await page.reload()
    // The real app opens its history after the shared event transport connects.
    // Do the same here: server.connected retires pre-connection load authority.
    await page.waitForFunction(() => window.fixture?.eventsReady())
    await page.evaluate(() => window.fixture.reload())
    await page.getByText("Retain this conclusion", { exact: true }).first().waitFor()
    assert.equal(await page.locator(".tool-call, .message-reasoning-card").count(), 0)
    assert.deepEqual(pageErrors, [], "Rendered native operations must not produce browser errors")
    await page.screenshot({ path: path.join(root, "ui-after.png"), fullPage: true })
    console.log("PASS: UI whole-session command, confirmation, native persistence and reload; final text preserved")
  } catch (error) {
    if (page) {
      console.error("UI dialogs", await page.getByRole("dialog").allTextContents())
      await page.screenshot({ path: path.join(root, "ui-failure.png"), fullPage: true })
    }
    throw error
  } finally {
    await browser?.close()
    await server.close()
    await broker.close()
  }
}
