import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

const root = fileURLToPath(new URL("../..", import.meta.url))
let server: ViteDevServer, browser: Browser, baseUrl: string
before(async () => {
  server = await createServer({
    configFile: false, root, logLevel: "error", plugins: [solid(), {
      name: "browser-fixture",
      configureServer(server) {
        server.middlewares.use("/fixture", async (req, res) => {
          const name = req.url?.includes("navigation") ? "navigation" : req.url?.includes("undo") ? "undo" : "session"
          res.setHeader("Content-Type", "text/html")
          res.end(await server.transformIndexHtml("/fixture", `<html><body><div id="root" style="display:flex;height:700px;width:1100px"></div><script type="module" src="/tests/browser/fixtures/${name}.tsx"></script></body></html>`))
        })
      },
    }],
    resolve: { dedupe: ["solid-js"] },
    optimizeDeps: { exclude: ["lucide-solid"] },
    // Tests own a fixed source snapshot; desktop builds must not trigger HMR
    // navigation while a browser assertion is in progress.
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  baseUrl = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function open(name: string, run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: route.request().url().includes("events") ? "text/event-stream" : "application/json", body: "" }))
  try {
    await page.goto(`${baseUrl}/fixture?${name}`)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await run(page)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
}

test("new-session reply renders live after optimistic-send reordering, and survives a return", async () => {
  await open("session", async page => {
    const prompt = page.locator("textarea:visible").first()
    await prompt.fill("test")
    await prompt.press("Enter")
    await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("test"))
    await page.evaluate(() => (window as any).fixture.start())
    await page.evaluate(() => (window as any).fixture.delta("Live response"))
    await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("Live response"))
    await page.evaluate(() => (window as any).fixture.delta(" must remain visible"))
    await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("must remain visible"))
    await page.evaluate(() => (window as any).fixture.end("Live response must remain visible"))
    await page.evaluate(() => (window as any).fixture.switchAway())
    await page.evaluate(() => (window as any).fixture.return())
    await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("must remain visible"))
    assert.equal(await page.locator('.message-stream-block[data-message-id="msg_assistant"]').count(), 1)
  })
})

test("long list reaches its actual end, appends beyond the initial range, and stays bounded", async () => {
  await open("navigation", async page => {
    await page.evaluate(() => (window as any).fixture.bottom())
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-virtual-follow-key="row-199"]')
      return el && el.getBoundingClientRect().bottom <= 701
    })
    await page.evaluate(() => (window as any).fixture.append())
    await page.waitForFunction(() => document.querySelector('[data-virtual-follow-key="row-200"]'))
    assert.ok(await page.locator("[data-virtual-follow-key]").count() < 60)
  })
})

test("an evicted empty assistant cannot donate its cached block to a rehydrated answer", async () => {
  await open("session", async page => {
    const prompt = page.locator("textarea:visible").first()
    await prompt.fill("test")
    await prompt.press("Enter")
    await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("test"))
    await page.evaluate(() => (window as any).fixture.startEmpty())
    await page.waitForFunction(() => document.querySelector('[data-virtual-follow-key="msg_assistant"]'))
    await page.evaluate(() => (window as any).fixture.dropAssistant())
    await page.evaluate(() => (window as any).fixture.restoreAssistant("Restored answer is visible"))
    await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("Restored answer is visible"))
    await page.evaluate(() => (window as any).fixture.switchAway())
    await page.evaluate(() => (window as any).fixture.return())
    await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("Restored answer is visible"))
  })
})

test("SessionView retains an escaped position inside a long assistant reply on return", async () => {
  await open("session", async page => {
    const prompt = page.locator("textarea:visible").first()
    await prompt.fill("test")
    await prompt.press("Enter")
    await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("test"))
    await page.evaluate(() => (window as any).fixture.start())
    const reply = "Paragraph for a long response and reader position.\n\n".repeat(180) + "Final response marker."
    await page.evaluate(text => { (window as any).fixture.delta(text); (window as any).fixture.end(text) }, reply)
    await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("Final response marker."))
    await page.locator(".message-stream").hover()
    await page.mouse.wheel(0, -100000)
    await page.waitForFunction(() => document.querySelector(".message-stream")?.scrollTop === 0)
    await page.mouse.wheel(0, 1400)
    await page.waitForFunction(() => (document.querySelector(".message-stream")?.scrollTop ?? 0) > 1000)
    await page.evaluate(`new Promise(resolve => { let n = 30; const frame = () => --n ? requestAnimationFrame(frame) : resolve(); requestAnimationFrame(frame) })`)
    const top = await page.locator(".message-stream").evaluate(el => el.scrollTop)
    await page.evaluate(() => (window as any).fixture.switchAway())
    await page.evaluate(() => (window as any).fixture.return())
    await page.waitForFunction(top => Math.abs((document.querySelector(".message-stream")?.scrollTop ?? 0) - top) < 4, top)
    await page.evaluate(`new Promise(resolve => { let n = 30; const frame = () => --n ? requestAnimationFrame(frame) : resolve(); requestAnimationFrame(frame) })`)
    assert.ok(Math.abs(await page.locator(".message-stream").evaluate(el => el.scrollTop) - top) < 4)
  })
})

test("returning to a long list preserves the escaped reader anchor", async () => {
  await open("navigation", async page => {
    await page.waitForFunction(() => document.querySelector('[data-virtual-follow-key="row-10"]'))
    await page.locator(".message-stream").hover()
    await page.mouse.wheel(0, 2400)
    await page.waitForFunction(() => (document.querySelector(".message-stream")?.scrollTop ?? 0) > 2000)
    // Let wheel/ResizeObserver/follow state settle before snapshot capture.
    await page.evaluate(`new Promise(resolve => {
      let frames = 30
      const tick = () => --frames ? requestAnimationFrame(tick) : resolve()
      requestAnimationFrame(tick)
    })`)
    const before = await page.evaluate(() => (window as any).fixture.snapshot())
    assert.equal(before.atBottom, false)
    await page.evaluate(() => (window as any).fixture.switchAway())
    await page.evaluate(() => (window as any).fixture.return())
    await page.waitForFunction(top => Math.abs((document.querySelector(".message-stream")?.scrollTop ?? 0) - top) < 2, before.scrollTop)
    await page.waitForFunction(key => (window as any).fixture.snapshot()?.anchorKey === key, before.anchorKey)
    const after = await page.evaluate(() => (window as any).fixture.snapshot())
    assert.equal(after.anchorKey, before.anchorKey)
    assert.ok(Math.abs(after.anchorOffset - before.anchorOffset) < 2)
  })
})

for (const [sendFollowUp, busy] of [[false, false], [true, false], [false, true]]) {
  test(`undo excludes its prompt and every later exchange across return and cold reload (${sendFollowUp ? "with" : "without"} another send, ${busy ? "busy" : "idle"})`, async () => {
    await open(busy ? "undo-busy" : "undo", async page => {
      await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("Later answer"))
      const message = page.locator('.message-stream-block[data-message-id="msg_03"]')
      await message.hover()
      await message.getByRole("button", { name: "Undo changes up to here (deletes messages)", exact: true }).click()
      if (busy) {
        await page.waitForFunction(() => (window as any).fixture.snapshot().waitCalls === 1)
        assert.equal(await message.count(), 1, "Interruption acceptance must not masquerade as completed undo")
        assert.equal(await page.locator("textarea:visible").first().inputValue(), "")
        await page.evaluate(() => (window as any).fixture.settle())
      }
      await page.waitForFunction(() => (document.querySelector("textarea") as HTMLTextAreaElement)?.value === "Undo this prompt")
      const assertUndone = async () => {
        await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("Earlier answer"))
        assert.equal(await page.locator('.message-stream-block[data-message-id="msg_03"], .message-stream-block[data-message-id="msg_04"], .message-stream-block[data-message-id="msg_05"], .message-stream-block[data-message-id="msg_06"]').count(), 0)
      }
      await assertUndone()
      assert.equal((await page.evaluate(() => (window as any).fixture.snapshot())).prompts, 0)
      if (sendFollowUp) {
        const prompt = page.locator("textarea:visible").first()
        await prompt.fill("Replacement prompt")
        await prompt.press("Enter")
        await page.waitForFunction(() => (window as any).fixture.snapshot().prompts === 1)
      }
      await page.evaluate(() => (window as any).fixture.switchAway())
      await page.evaluate(() => (window as any).fixture.return())
      await assertUndone()
      await page.reload()
      await page.waitForFunction(() => Boolean((window as any).fixture))
      await assertUndone()
      const state = await page.evaluate(() => (window as any).fixture.snapshot())
      assert.equal(state.prompts, sendFollowUp ? 1 : 0)
      assert.equal(state.nativeCount, sendFollowUp ? 3 : 6)
      assert.deepEqual(state.revert, sendFollowUp ? null : { messageID: "msg_03" })
      if (sendFollowUp) await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("Replacement prompt"))
    })
  })
}
