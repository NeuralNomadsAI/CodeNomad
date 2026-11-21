import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { installSourceScrollDelivery } from "./source-scroll-delivery"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "source-scroll-delivery", routes: [{ path: "/listeners",
    html: '<html><body><div class="mission-source-popover"><div role="listbox"></div></div></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

for (const held of [false, true]) test(`scroll registration lifetimes match Chromium after delivery (held: ${held})`, async t => {
  const results = []
  for (const instrumented of [false, true]) {
    const page = await browser.newPage(), errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
    page.on("requestfailed", request => errors.push(`${request.url()}: ${request.failure()?.errorText}`))
    await page.addInitScript("window.__name = Object")
    // Capture before the helper patches the shared prototype.
    await page.addInitScript("window.originalScrollPrototype = [EventTarget.prototype.addEventListener, EventTarget.prototype.removeEventListener]")
    try {
      if (instrumented) await installSourceScrollDelivery(page)
      await page.goto(url)
      const result = await page.evaluate(({ held, instrumented }) => {
        const list = document.querySelector('[role="listbox"]')!
        const barrier = instrumented ? window.sourceScrollDelivery : undefined
        const dispatch = () => {
          if (held) barrier?.arm()
          list.dispatchEvent(new Event("scroll", { cancelable: true }))
          barrier?.release()
        }
        let abortedReadd = 0, onceReadd = 0, alreadyAborted = 0, duplicate = 0, captures = 0, objectCalls = 0, wrongThis = 0
        const a = new AbortController(), fn = function(this: EventTarget) { abortedReadd++; if (this !== list) wrongThis++ }
        list.addEventListener("scroll", fn, { signal: a.signal }); a.abort()
        list.addEventListener("scroll", fn); dispatch(); list.removeEventListener("scroll", fn)
        const b = new AbortController(), once = () => { onceReadd++ }
        list.addEventListener("scroll", once, { once: true, signal: b.signal }); dispatch(); b.abort()
        list.addEventListener("scroll", once); dispatch(); list.removeEventListener("scroll", once)
        const c = new AbortController(), fresh = () => { alreadyAborted++ }; c.abort()
        list.addEventListener("scroll", fresh, { signal: c.signal }); dispatch()
        list.addEventListener("scroll", fresh); dispatch(); list.removeEventListener("scroll", fresh)
        const d = new AbortController(), e = new AbortController(), same = () => { duplicate++ }
        list.addEventListener("scroll", same, { signal: d.signal })
        list.addEventListener("scroll", same, { once: true, signal: e.signal }); e.abort()
        dispatch(); dispatch(); d.abort(); dispatch()
        const both = () => { captures++ }
        list.addEventListener("scroll", both, false); list.addEventListener("scroll", both, { capture: true })
        dispatch(); list.removeEventListener("scroll", both, false); dispatch(); list.removeEventListener("scroll", both, true)
        const object = { handleEvent(this: unknown) { objectCalls++; if (this !== object) wrongThis++ } }
        list.addEventListener("scroll", object, { once: true }); dispatch(); dispatch()
        let snapshot = 0
        const options = { once: true }, snap = () => { snapshot++ }
        list.addEventListener("scroll", snap, options); options.once = false; dispatch(); dispatch()
        let reentrant = 0
        const recursive = () => { reentrant++; list.addEventListener("scroll", recursive, { once: true }) }
        list.addEventListener("scroll", recursive, { once: true }); dispatch(); dispatch()
        list.removeEventListener("scroll", recursive)
        const state = barrier?.state()
        barrier?.dispose()
        const originals = (window as any).originalScrollPrototype
        const restored = EventTarget.prototype.addEventListener === originals[0] && EventTarget.prototype.removeEventListener === originals[1]
        return { counts: { abortedReadd, onceReadd, alreadyAborted, duplicate, captures, objectCalls, wrongThis, snapshot, reentrant }, state, restored }
      }, { held, instrumented })
      t.diagnostic(JSON.stringify({ instrumented, held, ...result }))
      results.push(result.counts)
      assert.equal(result.restored, true)
      if (instrumented) {
        assert.equal(result.state?.pending, 0); assert.equal(result.state?.armed, false)
        assert.equal(Boolean(result.state?.retained), held)
      }
      assert.deepEqual(errors, [])
    } finally { try { await page.evaluate(() => window.sourceScrollDelivery?.dispose()) } finally { await page.close() } }
  }
  const expected = { abortedReadd: 1, onceReadd: 2, alreadyAborted: 1, duplicate: 2, captures: 3,
    objectCalls: 1, wrongThis: 0, snapshot: 1, reentrant: 2 }
  assert.deepEqual(results[0], expected)
  assert.deepEqual(results[1], results[0])
})

test("held deliveries belong to their registration and dispose restores the prototype", async t => {
  const page = await browser.newPage(), errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
  page.on("requestfailed", request => errors.push(`${request.url()}: ${request.failure()?.errorText}`))
  await page.addInitScript("window.originalScrollPrototype = [EventTarget.prototype.addEventListener, EventTarget.prototype.removeEventListener]")
  try {
    await installSourceScrollDelivery(page); await page.goto(url)
    const result = await page.evaluate(() => {
      const list = document.querySelector('[role="listbox"]')!, barrier = window.sourceScrollDelivery
      const event = () => list.dispatchEvent(new Event("scroll"))
      let removed = 0, aborted = 0, consumed = 0, disposed = 0, duplicates = 0
      const fn = () => { removed++ }
      barrier.arm(); list.addEventListener("scroll", fn); event(); list.removeEventListener("scroll", fn)
      list.addEventListener("scroll", fn); event()
      const beforeRemoveRelease = removed; barrier.release(); list.removeEventListener("scroll", fn)
      const controller = new AbortController(), abort = () => { aborted++ }
      barrier.arm(); list.addEventListener("scroll", abort, { signal: controller.signal }); event(); controller.abort()
      list.addEventListener("scroll", abort); event()
      const beforeAbortRelease = aborted; barrier.release(); list.removeEventListener("scroll", abort)
      const onceController = new AbortController(), once = () => { consumed++ }
      barrier.arm(); list.addEventListener("scroll", once, { once: true, signal: onceController.signal }); event()
      onceController.abort(); list.removeEventListener("scroll", once)
      list.addEventListener("scroll", once); event()
      const beforeOnceRelease = consumed; barrier.release(); list.removeEventListener("scroll", once)
      const same = () => { duplicates++ }, controller2 = new AbortController()
      barrier.arm(); list.addEventListener("scroll", same, { once: true }); list.addEventListener("scroll", same, { signal: controller2.signal })
      event(); event(); controller2.abort(); barrier.release()
      const dispose = () => { disposed++ }
      barrier.arm(); list.addEventListener("scroll", dispose); event()
      const beforeDispose = barrier.state(); barrier.dispose(); event(); barrier.release()
      const afterDispose = barrier.state(), originals = (window as any).originalScrollPrototype
      const restored = EventTarget.prototype.addEventListener === originals[0] && EventTarget.prototype.removeEventListener === originals[1]
      list.addEventListener("scroll", dispose); event(); list.removeEventListener("scroll", dispose)
      return { removed, aborted, consumed, duplicates, disposed, beforeRemoveRelease, beforeAbortRelease, beforeOnceRelease, beforeDispose, afterDispose, restored }
    })
    t.diagnostic(JSON.stringify(result))
    assert.equal(result.beforeRemoveRelease, 0); assert.equal(result.beforeAbortRelease, 0); assert.equal(result.beforeOnceRelease, 0)
    assert.equal(result.removed, 1); assert.equal(result.aborted, 1); assert.equal(result.consumed, 2)
    assert.equal(result.duplicates, 1); assert.equal(result.disposed, 1); assert.equal(result.restored, true)
    assert.equal(result.beforeDispose.pending, 1); assert.equal(result.afterDispose.pending, 0); assert.equal(result.afterDispose.armed, false)
    assert.deepEqual(errors, [])
  } finally { try { await page.evaluate(() => window.sourceScrollDelivery?.dispose()) } finally { await page.close() } }
})
