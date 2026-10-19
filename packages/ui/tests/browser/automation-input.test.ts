import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { launchAutomationBrowser, openAutomationPage } from "./automation-session"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { prepareInterruptionDock } from "./fixtures/interruption-dock-preparation"

// Trusted pointer, wheel and keyboard input from the real codenomad.act controller.
let server: ViteDevServer, automation: Awaited<ReturnType<typeof launchAutomationBrowser>>, base: string

const INPUTS = `<!doctype html><html lang="en"><body style="margin:0"><main>
  <form id="search"><label>Query <input id="query"></label><button>Go</button></form>
  <button id="hover-target">Hover me</button><output id="hover-state">idle</output>
  <button id="menu-trigger" aria-haspopup="menu">Open menu</button><div id="menu" role="menu" hidden><button role="menuitem" id="item">Menu item</button></div>
  <div id="scroller" role="region" aria-label="Scroller" style="height:100px;overflow:auto"><div style="height:2000px">tall</div></div>
  <div style="position:relative;height:200px">
    <div id="handle" role="button" aria-label="Handle" style="position:absolute;left:20px;top:20px;width:40px;height:40px;background:#888"></div>
    <div id="zone" role="region" aria-label="Drop zone" style="position:absolute;left:300px;top:20px;width:100px;height:100px;border:1px solid"></div>
  </div>
  <div style="position:relative"><button id="under">Under</button>
    <div id="cover" style="position:absolute;inset:0;background:#fff8" aria-label="Cover"></div></div>
  <p id="later"></p>
</main><script>
  const marked = () => Boolean(globalThis.__codenomadAutomationDepth) || (globalThis.__codenomadAutomationInputUntil || 0) > Date.now()
  window.log = []
  for (const type of ["keydown", "pointerdown", "click"]) document.addEventListener(type, event => {
    window.log.push(type + ":" + (event.target.id || event.target.tagName) + ":" + (event.key || "") + ":" + event.isTrusted + ":" + marked())
  }, true)
  document.getElementById("search").addEventListener("submit", event => { event.preventDefault(); window.log.push("submit:" + query.value) })
  document.getElementById("hover-target").addEventListener("pointerenter", () => { document.getElementById("hover-state").textContent = "hovered" })
  // Opens on pointerdown only, like Kobalte menus: a programmatic click never opens it.
  document.getElementById("menu-trigger").addEventListener("pointerdown", () => { document.getElementById("menu").hidden = false })
  document.getElementById("item").addEventListener("click", () => window.log.push("menu-item"))
  let dragging = false
  const handle = document.getElementById("handle"), zone = document.getElementById("zone")
  handle.addEventListener("pointerdown", event => { dragging = true; handle.setPointerCapture(event.pointerId) })
  handle.addEventListener("pointermove", event => { if (dragging) { handle.style.left = (event.clientX - 20) + "px"; handle.style.top = (event.clientY - handle.offsetParent.getBoundingClientRect().top - 20) + "px" } })
  handle.addEventListener("pointerup", event => {
    dragging = false
    const box = zone.getBoundingClientRect()
    window.dropped = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom
  })
  setTimeout(() => { document.getElementById("later").textContent = "Ready now" }, 600)
</script></body></html>`

before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [solid(), shutdown.plugin, { name: "automation-input", configureServer(s) {
      s.middlewares.use("/automation-inputs", (_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(INPUTS) })
      s.middlewares.use("/automation-dock", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/automation-dock", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/interruption-dock.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server)
  await server.listen()
  await prepareInterruptionDock(server)
  base = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`
  automation = await launchAutomationBrowser()
})

after(async () => {
  await automation?.close()
  await server?.close()
})

const log = (page: import("playwright").Page) => page.evaluate(() => (window as any).log.splice(0) as string[])

test("keys, hover, wheel, drag and pointer clicks behave like a user and are always marked as automation", async () => {
  const run = await openAutomationPage(automation, `${base}/automation-inputs`)
  try {
    const { page, act, refFor } = run
    const query = await refFor(/textbox "Query"/)
    await act({ action: "type", ref: query, text: "hello" })
    await log(page)
    assert.deepEqual(await act({ action: "press", key: "Enter", ref: query }), { focused: "input \"Query\"" })
    assert.deepEqual(await log(page), ["keydown:query:Enter:true:true", "click:BUTTON::true:true", "submit:hello"],
      "a trusted Enter submits the form through its default button; the key and the implicit click are both marked")
    assert.deepEqual(await act({ action: "press", key: "Tab" }), { focused: "button \"Go\"" }, "Tab moves focus like a keyboard")
    assert.equal(await page.evaluate(() => (globalThis as any).__codenomadAutomationInputUntil), 0, "the mark is cleared after each action")

    await act({ action: "hover", ref: await refFor(/button "Hover me"/) })
    assert.equal(await page.textContent("#hover-state"), "hovered")

    await log(page)
    await act({ action: "click", ref: await refFor(/button "Open menu"/) })
    assert.deepEqual((await log(page)).filter(entry => entry.startsWith("pointerdown")), ["pointerdown:menu-trigger::true:true"])
    await act({ action: "click", ref: await refFor(/menuitem "Menu item"/, "Menu item") })
    assert.ok((await log(page)).includes("menu-item"), "a pointerdown-only menu opens and its item is clickable")

    await act({ action: "scroll", ref: await refFor(/region "Scroller"/), direction: "down", amount: 500 })
    await page.waitForFunction(() => document.getElementById("scroller")!.scrollTop > 0)

    await act({ action: "drag", ref: await refFor(/button "Handle"/), to: await refFor(/region "Drop zone"/) })
    assert.equal(await page.evaluate(() => (window as any).dropped), true)

    await assert.rejects(act({ action: "click", ref: await refFor(/button "Under"/) }), /is covered by div "Cover"/)
    assert.deepEqual((await log(page)).filter(entry => entry.includes("under")), [], "a covered element receives nothing")

    assert.equal((await act({ action: "wait", text: "Ready now", timeout: 5_000 })).found, true)
    assert.equal((await act({ action: "wait", text: "Hover me", gone: true, timeout: 300 }).catch(error => error.message)), "\"Hover me\" is still shown after 300 ms")
    await assert.rejects(act({ action: "press", key: "Hyper+Q" }), /Unknown modifier "Hyper"/)
  } finally { await run.close() }
})

/** Answers the real InterruptionDock question and returns the human-answer header it sent. */
async function answerDock(via: "click" | "press" | "human"): Promise<unknown> {
  const run = await openAutomationPage(automation, `${base}/automation-dock`, async page => {
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  })
  try {
    const { page, act, refFor } = run
    await page.waitForFunction(() => Boolean((window as any).fixture?.snapshot().ids.length))
    await page.evaluate(() => (window as any).fixture.ask())
    const field = page.locator('.interruption-dock input[type="text"]:visible')
    await field.waitFor()
    if (via === "human") {
      await field.fill("Human answer")
      await page.locator('.interruption-dock button[type="submit"]:visible').click()
    } else {
      const ref = await refFor(/textbox/, "textbox")
      await act({ action: "type", ref, text: `Automation ${via}` })
      if (via === "press") await act({ action: "press", key: "Enter", ref })
      else await act({ action: "click", ref: await refFor(/button "Submit"/, "Submit") })
    }
    await page.waitForFunction(() => (window as any).fixture.replies.length === 1)
    const sent = await page.evaluate(() => ({ answer: (window as any).fixture.replies[0].answer, options: (window as any).fixture.replyOptions[0] }))
    assert.deepEqual(sent.answer, { q0: via === "human" ? "Human answer" : `Automation ${via}` })
    return sent.options?.headers?.["x-codenomad-human-answer"]
  } finally { await run.close() }
}

test("a dock answer given through trusted automation clicks or keys never carries the human-answer mark", async () => {
  assert.equal(await answerDock("click"), undefined, "a trusted automation click is not a human answer")
  assert.equal(await answerDock("press"), undefined, "a trusted automation Enter is not a human answer")
  assert.equal(await answerDock("human"), "1", "control: a real user click on the same dock is")
})
