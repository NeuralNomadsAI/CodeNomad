import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string

before(async () => {
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("../..", import.meta.url)),
    logLevel: "error",
    plugins: [solid(), {
      name: "interruption-selection-fixture",
      configureServer(server) {
        server.middlewares.use("/fixture", async (_request, response) => {
          response.setHeader("Content-Type", "text/html")
          response.end(await server.transformIndexHtml("/fixture",
            '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/interruption-dock.tsx"></script></body></html>'))
        })
      },
    }],
    resolve: { dedupe: ["solid-js"] },
    optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})

after(async () => { await browser?.close(); await server?.close() })

test("a question retains its draft while a different conversation receives a permission", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  page.setDefaultTimeout(15000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 })
    await page.waitForFunction(() => Boolean((window as any).fixture?.snapshot().ids.length), undefined, { timeout: 60000 })
    await page.evaluate(() => (window as any).fixture.ask())
    const answer = page.locator('.interruption-dock input[type="text"]:visible')
    await answer.fill("Draft before switching")

    // The unrelated session cannot expose or focus the first conversation's editor.
    await page.evaluate(() => {
      const fixture = (window as any).fixture
      fixture.activationFrames.pause()
      fixture.switch("other")
    })
    await page.waitForFunction(() => (window as any).fixture.activationFrames.pending() === 1)
    assert.equal(await answer.count(), 0)
    assert.equal(await page.locator('.interruption-editor[hidden][inert] input').inputValue(), "Draft before switching")
    await page.evaluate(() => (window as any).fixture.activationFrames.flush())
    assert.equal(await page.locator('.prompt-input').evaluate(element => element === document.activeElement), true)

    const pending = await page.evaluate(async modulePath => {
      const { addPermissionToQueue, getPermissionQueue } = await import(/* @vite-ignore */ modulePath)
      addPermissionToQueue("interruptions", {
        id: "permission-other", sessionID: "other", action: "bash", resources: ["git status"], metadata: {},
      })
      return getPermissionQueue("interruptions").map((request: { id: string; sessionID: string }) => ({
        id: request.id, sessionID: request.sessionID,
      }))
    }, "/src/stores/instances.ts")

    assert.deepEqual(pending, [{ id: "permission-other", sessionID: "other" }])
    assert.equal(await answer.count(), 0)
    assert.equal(await page.locator(".prompt-input").inputValue(), "")
    assert.equal(await page.locator(".interruption-session").innerText(), "Other session")
    assert.equal(await page.locator(".interruption-position").count(), 0)
    await page.evaluate(() => (window as any).fixture.switch("s"))
    assert.equal(await answer.inputValue(), "Draft before switching")
    await answer.fill("Continue the original answer")
    await page.evaluate(() => (window as any).fixture.activationFrames.flush())
    assert.equal(await answer.evaluate(element => element === document.activeElement), true)
    assert.equal(await page.locator(".interruption-session").innerText(), "Main session")
    assert.equal(await page.locator(".interruption-position").count(), 0)
    assert.equal(await page.getByRole("button", { name: "Next request", exact: true }).count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

async function withActivationPage(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 })
    await page.waitForFunction(() => Boolean((window as any).fixture?.snapshot().ids.length), undefined, { timeout: 60000 })
    await page.evaluate(() => {
      const fixture = (window as any).fixture
      fixture.active(false)
      fixture.activationFrames.pause()
      ;(document.activeElement as HTMLElement)?.blur()
    })
    await run(page)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
}

async function activate(page: Page, conversation: boolean) {
  await page.evaluate(conversation => {
    const fixture = (window as any).fixture
    fixture.active(false)
    ;(document.activeElement as HTMLElement)?.blur()
    fixture.conversationFocus(conversation)
    fixture.active(true)
  }, conversation)
  await page.waitForFunction(() => (window as any).fixture.activationFrames.pending() === 1)
}

for (const conversation of [false, true]) {
  const mode = conversation ? "conversation" : "composer"
  test(`deferred ${mode} activation respects inputs, dock focus and a newly opened modal`, async () => {
    await withActivationPage(async page => {
      await page.evaluate(() => (window as any).fixture.ask())
      for (const target of ["input", "textarea", "select", "editable", "dock", "dock-button", "modal"]) {
        await activate(page, conversation)
        const preserved = await page.evaluate(target => {
          let control: HTMLElement
          if (target === "dock" || target === "dock-button") {
            control = document.querySelector(target === "dock" ? ".interruption-dock" : ".interruption-toggle")!
          } else {
            control = document.createElement(target === "editable" || target === "modal" ? "div" : target)
            control.id = "competing-focus"
            if (target === "editable") control.contentEditable = "true"
            if (target === "modal") {
              control.setAttribute("role", "dialog")
              control.setAttribute("aria-modal", "true")
            }
            document.body.append(control)
          }
          if (target !== "modal") control.focus()
          const focused = document.activeElement
          ;(window as any).fixture.activationFrames.flush()
          return focused === document.activeElement
        }, target)
        assert.equal(preserved, true, `${mode} must preserve ${target} ownership`)
        await page.evaluate(() => document.getElementById("competing-focus")?.remove())
      }
    })
  })

  test(`ordinary ${mode} activation still focuses the requested surface`, async () => {
    await withActivationPage(async page => {
      await activate(page, conversation)
      const handled = await page.evaluate(() => {
        const fixture = (window as any).fixture
        const before = fixture.focusHandled()
        fixture.activationFrames.flush()
        return fixture.focusHandled() - before
      })
      assert.equal(handled, conversation ? 1 : 0)
      assert.equal(await page.locator(conversation ? ".message-stream" : ".prompt-input")
        .evaluate(element => element === document.activeElement), true)
    })
  })
}

test("inactive, disposed and superseded activation frames cannot reclaim focus", async () => {
  await withActivationPage(async page => {
    await activate(page, false)
    await page.evaluate(() => (window as any).fixture.active(false))
    assert.equal(await page.evaluate(() => (window as any).fixture.activationFrames.cancelled()), 1)
    assert.equal(await page.evaluate(() => {
      ;(window as any).fixture.activationFrames.flush(true)
      return document.activeElement === document.body
    }), true, "an inactive callback must be inert even if already dispatched")

    await activate(page, false)
    await page.evaluate(() => {
      const fixture = (window as any).fixture
      fixture.active(false)
      fixture.active(true)
    })
    await page.waitForFunction(() => (window as any).fixture.activationFrames.pending() === 1)
    assert.equal(await page.evaluate(() => {
      ;(window as any).fixture.activationFrames.flush(true)
      return document.activeElement === document.body
    }), true, "an old activation must not become valid again after reactivation")
    await page.evaluate(() => (window as any).fixture.activationFrames.flush())
    assert.equal(await page.locator(".prompt-input").evaluate(element => element === document.activeElement), true)

    await activate(page, false)
    await page.evaluate(() => (window as any).fixture.switch("other"))
    await page.waitForFunction(() => (window as any).fixture.activationFrames.pending() === 1)
    assert.equal(await page.evaluate(() => {
      ;(window as any).fixture.activationFrames.flush(true)
      return document.activeElement === document.body
    }), true, "a disposed pane must not focus its detached composer")
    await page.evaluate(() => (window as any).fixture.activationFrames.flush())
    assert.equal(await page.locator(".prompt-input").evaluate(element => element === document.activeElement), true)
  })
})

test("phone activation does not summon the composer keyboard", async () => {
  await withActivationPage(async page => {
    await page.evaluate(() => {
      const fixture = (window as any).fixture
      fixture.phone(true)
      fixture.active(true)
    })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    assert.equal(await page.evaluate(() => (window as any).fixture.activationFrames.pending()), 0)
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true)
    await activate(page, true)
    await page.evaluate(() => (window as any).fixture.activationFrames.flush())
    assert.equal(await page.locator(".message-stream").evaluate(element => element === document.activeElement), true)
  })
})
