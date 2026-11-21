import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { fixtureEnvironment } from "../native-product-fixture.mjs"

test("renderer probe counts attributes but observes only visible markers and composer input", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cn-perf-probe-"))
  let browser
  try {
    browser = await chromium.launch({ headless: true, env: await fixtureEnvironment(root) })
    const page = await browser.newPage()
    await page.setContent('<main class="message-stream"></main><textarea id="composer"></textarea><input id="other">')
    await page.addScriptTag({ path: fileURLToPath(new URL("./page-probe.js", import.meta.url)) })
    await page.evaluate(() => {
      window.__perf.arm()
      const stream = document.querySelector("main")
      stream.classList.add("fixture")
      stream.setAttribute("aria-busy", "true")
      stream.innerHTML = '<p>MKAA010001K</p><div hidden>MKAA010002K</div><div style="position:absolute;left:-900px">MKAA010003K</div><p style="clip-path:inset(100%)">MKAA010004K</p>'
      window.__perf.clearKey(document.querySelector("#composer"))
    })
    await page.waitForFunction(() => window.__perf.collect().shown.MKAA010001K)
    await page.locator("#other").press("x")
    const shot = await page.evaluate(() => ({ ...window.__perf.collect(), keyAt: window.__perf.keyAt() }))
    assert.deepEqual(Object.keys(shot.shown), ["MKAA010001K"])
    assert(shot.mutations >= 3, "Expected two attributes and one insertion")
    assert.equal(shot.keyAt, undefined)
    await page.locator("[hidden]").evaluate(element => { element.hidden = false })
    await page.waitForFunction(() => window.__perf.collect().shown.MKAA010002K)
    await page.locator("#composer").press("a")
    await page.waitForFunction(() => window.__perf.keyAt())
    await page.evaluate(() => {
      window.__perf.arm(false)
      const stream = document.querySelector("main")
      stream.innerHTML = '<p>MKAA020001K</p><p hidden>MKAA020003K</p><p>MKAA020002K</p>'
      queueMicrotask(() => stream.lastElementChild.remove())
    })
    await page.waitForFunction(() => window.__perf.collect().shown.MKAA020001K)
    assert.deepEqual(await page.evaluate(() => Object.keys(window.__perf.collect().shown)), ["MKAA020001K"])
  } finally {
    try { await browser?.close() } finally { await rm(root, { recursive: true, force: true }) }
  }
})
