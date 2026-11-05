import assert from "node:assert/strict"
import { test } from "node:test"
import { chromium } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

test("shared native opener refuses explicit and missing project scope before either bridge", { timeout: 90_000 }, async t => {
  const fixture = await borrowFixture({ name: "native-workspace-open", routes: [{ path: "/workspace-open",
    html: '<html><body><script type="module" src="/tests/browser/fixtures/workspace-open.ts"></script></body></html>' }] })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  t.after(async () => { await browser.close(); await fixture.close() })
  for (const host of ["electron", "tauri"]) {
    const page = await browser.newPage()
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    await page.addInitScript(`
      window.__CODENOMAD_RUNTIME_HOST__ = ${JSON.stringify(host)};
      window.__CODENOMAD_WINDOW_CONTEXT__ = "local";
      window.nativeCalls = [];
      const record = request => { window.nativeCalls.push(request); return Promise.resolve(); };
      if (${JSON.stringify(host)} === "electron") window.electronAPI = { openWorkspaceTarget: record };
      else window.__TAURI__ = { core: { invoke: (_cmd, request) => record(request) } };
    `)
    await page.goto(fixture.url)
    await page.waitForFunction(() => !!(window as any).workspaceOpenFixture)
    assert.deepEqual(await page.evaluate(() => ({ host: (window as any).__CODENOMAD_RUNTIME_HOST__, electron: typeof (window as any).electronAPI?.openWorkspaceTarget, tauri: typeof (window as any).__TAURI__?.core?.invoke })),
      { host, electron: host === "electron" ? "function" : "undefined", tauri: host === "tauri" ? "function" : "undefined" })
    const result = await page.evaluate(async () => {
      const { canOpenWorkspacePaths: can, openWorkspacePath: open } = (window as any).workspaceOpenFixture
      const refused: string[] = []
      for (const instanceId of ["loopback", "remote", "unknown", "stale", "capability-only", "unavailable"]) {
        if (can(instanceId)) throw new Error(`allowed ${instanceId}`)
        for (const target of ["default", "reveal", "terminal", "editor"]) {
          for (const worktreeSlug of ["root", "branch"]) {
            try { await open({ target, instanceId, worktreeSlug, path: "file.txt", editor: "vscode" }) }
            catch (error) { refused.push(String(error)); continue }
            throw new Error("bridge was reached")
          }
        }
      }
      const before = (window as any).nativeCalls.length
      for (const instanceId of ["legacy", "local"]) {
        if (!can(instanceId)) throw new Error(`refused ${instanceId}`)
        await open({ target: "default", instanceId, worktreeSlug: "root" })
      }
      return { global: can(), before, refused, calls: (window as any).nativeCalls }
    })
    assert.equal(result.global, true)
    assert.equal(result.before, 0)
    assert.equal(result.refused.length, 48)
    assert.ok(result.refused.every(message => message.includes("shared local OpenCode")))
    assert.equal(result.calls.length, 2)
    const refusal = await page.evaluate(`(async () => {
      const reject = () => Promise.reject('{"code":"explicit_capability_unavailable","capability":"files","reason":{"code":"localOnly"}}');
      if (window.electronAPI) window.electronAPI.openWorkspaceTarget = reject;
      else window.__TAURI__.core.invoke = reject;
      try { await window.workspaceOpenFixture.openWorkspacePath({ target: "editor", instanceId: "local", worktreeSlug: "root", editor: "vscode" }); }
      catch (error) { return { message: String(error), code: error.code, reason: error.reason }; }
    })()`)
    assert.ok(refusal?.message.includes("shared local OpenCode"))
    assert.equal(refusal?.code, "explicit_capability_unavailable")
    assert.deepEqual(refusal?.reason, { code: "localOnly" })
    await page.close()
  }
})
