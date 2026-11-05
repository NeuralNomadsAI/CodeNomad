import assert from "node:assert/strict"
import { test } from "node:test"
import { chromium } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { frMessages } from "../../src/lib/i18n/messages/fr"

test("worktree component silently fences unavailable actions and masks unrelated native errors", { timeout: 90_000 }, async t => {
  const fixture = await borrowFixture({ name: "worktree-open-refusal", routes: [{ path: "/worktree-open-refusal",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/worktrees.tsx"></script></body></html>' }] })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  t.after(async () => { await browser.close(); await fixture.close() })
  for (const host of ["electron", "tauri"]) {
    for (const failure of ["renderer", "native", "unrelated"]) {
      await t.test(`${host} ${failure}`, async () => {
        const page = await browser.newPage()
        page.on("pageerror", error => console.error(error))
        page.setDefaultTimeout(10_000)
        try {
          await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
          await page.addInitScript(`{
            const host = ${JSON.stringify(host)}, failure = ${JSON.stringify(failure)};
            const w = window;
            w.__CODENOMAD_RUNTIME_HOST__ = host
            w.__CODENOMAD_WINDOW_CONTEXT__ = "local"
            w.nativeCalls = 0
            const open = async () => {
              w.nativeCalls++
              const refusal = '{"code":"explicit_capability_unavailable","capability":"files","reason":{"code":"localOnly"}}'
              if (failure === "native") throw host === "electron" ? new Error("IPC failed: " + refusal) : refusal
              throw new Error("untrusted backend detail /host/private")
            }
            if (host === "electron") w.electronAPI = { openWorkspaceTarget: open }
            else w.__TAURI__ = { core: { invoke: open } }
          }`)
          await page.goto(fixture.url)
          await page.waitForFunction(() => !!(window as any).fixture)
          await page.evaluate(() => (window as any).fixture.updatePreferences({ locale: "fr" }))
          await page.waitForFunction(() => document.documentElement.lang === "fr")
          await page.locator(".selector-trigger").click()
          const open = page.getByRole("option", { name: /feature/ }).getByRole("button", { name: frMessages["instanceShell.worktree.openInFileManager.action"] })
          await open.waitFor()
          if (failure === "renderer") {
            // An already-rendered action must recheck the occurrence at dispatch.
            await page.evaluate(() => { (window as any).fixture.instance().binding = { serverId: "explicit-loopback", directory: "/repo" } })
          }
          await open.click()
          await page.getByRole("listbox").waitFor({ state: "detached" })
          if (failure === "unrelated") await page.waitForFunction(message => (window as any).fixture.getToastHistory().some((item: any) => item.message === message), frMessages["instanceShell.worktree.openInFileManager.error"])
          const result = await page.evaluate(() => ({ messages: (window as any).fixture.getToastHistory().map((item: any) => item.message), calls: (window as any).nativeCalls, moves: (window as any).fixture.calls }))
          assert.equal(result.messages.includes(frMessages["commands.openWorkspace.localOnly"]), false)
          assert.equal(result.messages.includes(frMessages["instanceShell.worktree.openInFileManager.error"]), failure === "unrelated")
          assert.equal(result.calls, failure === "renderer" ? 0 : 1)
          assert.deepEqual(result.moves, [])
          assert.ok(result.messages.every((message: string) => !message.includes("/host/private")))
        } finally { await page.close() }
      })
    }
  }
})
