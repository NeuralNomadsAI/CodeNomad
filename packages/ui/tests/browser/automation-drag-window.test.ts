import assert from "node:assert/strict"
import { test } from "node:test"
import { launchAutomationBrowser, openAutomationPage } from "./automation-session"
import { borrowFixture } from "./fixture-borrow"

test("a utility window receives the drag release on its capturing panel", async () => {
  const fixture = await borrowFixture({ name: "automation-drag-window", routes: [{
    path: "/fixture", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/automation-drag-window.tsx"></script></body></html>',
  }] })
  const automation = await launchAutomationBrowser()
  try {
    const errors: Error[] = []
    const run = await openAutomationPage(automation, fixture.url, async page => {
      page.setDefaultNavigationTimeout(120_000)
      page.on("pageerror", error => errors.push(error))
      await page.route("**/api/**", route => route.fulfill({ json: {} }))
    })
    try {
      const { page, act, refFor } = run
      assert.deepEqual(errors, [])
      const panel = page.getByRole("dialog", { name: "Diagnostics" })
      await panel.evaluate(node => {
        for (const type of ["pointerup", "lostpointercapture"]) node.addEventListener(type, event => {
          if (event.isTrusted && event.target === node) node.setAttribute(`data-${type}`, "true")
        })
      })
      // Distinguish the visible handle from the visually hidden dialog title.
      await panel.locator(".window-title").evaluate(node => { node.textContent = "Move diagnostics" })
      const before = await panel.boundingBox()
      const ref = await refFor(/heading "Move diagnostics"/), to = await refFor(/region "Drop zone"/)
      await act({ action: "drag", ref, to })
      const after = await panel.boundingBox()
      assert.ok(before && after && after.x < before.x && after.y < before.y, "the panel followed the pointer")
      assert.deepEqual(await panel.evaluate(node => [
        node.getAttribute("data-pointerup"), node.getAttribute("data-lostpointercapture"),
      ]), ["true", "true"])
    } finally { await run.close() }
  } finally { await automation.close() }
})
