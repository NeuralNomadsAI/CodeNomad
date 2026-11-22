import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createFixtureShutdown } from "./fixture-shutdown"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"

// Scroll-pipeline convergence over the real VirtualFollowList: streaming
// growth issues at most one list-owned scrollTop write per frame, keeps
// per-frame layout-metric reads bounded through the shared ScrollObservationGate
// measurement, wheel routing stops re-probing the ancestor chain on every
// event, and reactive effect re-runs never write scrollTop synchronously.

let server: ViteDevServer, browser: Browser, url: string
let fixtureCache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  fixtureCache = await createFixtureCache()
  const shutdown = createFixtureShutdown(fixtureCache)
  server = await createServer({ cacheDir: fixtureCache.cacheDir, configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", plugins: [shutdown.plugin, solid(), {
    name: "scroll-pipeline-fixture", configureServer(server) {
      server.middlewares.use("/fixture", async (req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await server.transformIndexHtml("/fixture", `<html><body><div id="root" style="display:flex;height:700px;width:1100px"></div><script type="module" src="/tests/browser/fixtures/scroll-pipeline.tsx"></script></body></html>`))
      })
    },
  }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server)
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close(); await fixtureCache?.dispose() })

async function frames(page: Page, count = 30) {
  await page.evaluate(`new Promise(resolve => { let count = ${count}; const next = () => --count ? requestAnimationFrame(next) : resolve(); requestAnimationFrame(next) })`)
}

async function open() {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript("window.__name = (value) => value")
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  await frames(page, 60)
  return { page, errors }
}

/** Counts .message-stream scrollTop writes and layout-metric reads, tagged with a rAF frame id. */
async function instrumentScrollElement(page: Page) {
  await page.evaluate(() => {
    const w = window as any
    w.frame = 0
    requestAnimationFrame(function tick() { w.frame += 1; requestAnimationFrame(tick) })
    const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!
    const scrollTo = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTo")!
    const scrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!
    const clientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!
    const isStream = (node: unknown) => node instanceof HTMLElement && node.classList.contains("message-stream")
    w.writes = []
    w.reads = []
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      get: scrollTop.get!,
      set(value: number) {
        if (isStream(this)) w.writes.push({ frame: w.frame, value })
        return scrollTop.set!.call(this, value)
      },
    })
    Object.defineProperty(Element.prototype, "scrollTo", {
      configurable: true,
      writable: true,
      value(...args: unknown[]) {
        if (isStream(this)) w.writes.push({ frame: w.frame, value: (args[0] as { top?: number })?.top ?? 0 })
        return (scrollTo.value as (...scrollArgs: unknown[]) => unknown).apply(this, args)
      },
    })
    for (const [name, descriptor] of [["scrollHeight", scrollHeight], ["clientHeight", clientHeight]] as const) {
      Object.defineProperty(Element.prototype, name, {
        configurable: true,
        get() {
          if (isStream(this)) w.reads.push({ frame: w.frame, name })
          return (descriptor.get as () => number).call(this)
        },
      })
    }
  })
}

async function streamAppends(page: Page, count: number) {
  return page.evaluate(async (count) => {
    const w = window as any
    let pinToken = 0
    for (let index = 0; index < count; index++) {
      // Tall rows make the virtualizer's estimate chase the measured bottom
      // within a frame (the streaming-tail shape), and interleaved explicit
      // bottom-pin intents re-issue writes in the same frame the growth does.
      w.fixture.append(index % 3 === 2)
      if (index % 6 === 5) w.fixture.pin(++pinToken)
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }
    await new Promise(resolve => setTimeout(resolve, 80))
    return { writes: w.writes as { frame: number; value: number }[], reads: w.reads as { frame: number; name: string }[] }
  }, count)
}

test("streaming growth writes the transcript at most once per frame", async () => {
  const { page, errors } = await open()
  try {
    await page.evaluate(() => (window as any).fixture.bottom())
    await frames(page, 30)
    await instrumentScrollElement(page)
    const { writes } = await streamAppends(page, 24)
    assert.ok(writes.length > 0, "streaming while following must pin the bottom")
    const perFrame = new Map<number, number>()
    for (const write of writes) perFrame.set(write.frame, (perFrame.get(write.frame) ?? 0) + 1)
    const worst = [...perFrame.entries()].sort((a, b) => b[1] - a[1])[0]
    assert.ok(worst[1] <= 1, `at most one scrollTop write per frame, got ${worst[1]} in frame ${worst[0]} (${writes.length} writes over ${perFrame.size} frames)`)
    // The merged pipeline still lands the follow pin: the reader ends at the bottom.
    const gap = await page.evaluate(() => {
      const el = document.querySelector(".message-stream")!
      return el.scrollHeight - el.clientHeight - el.scrollTop
    })
    assert.ok(gap <= 2, `streaming follow must land at the bottom, ${gap}px short`)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test("streaming growth keeps per-frame layout-metric reads bounded", async () => {
  const { page, errors } = await open()
  try {
    await page.evaluate(() => (window as any).fixture.bottom())
    await frames(page, 30)
    await instrumentScrollElement(page)
    const { reads, writes } = await streamAppends(page, 24)
    assert.ok(writes.length > 0, "scenario must stream")
    assert.ok(reads.length > 0, "scenario must read layout metrics")
    const perFrame = new Map<number, number>()
    for (const read of reads) perFrame.set(read.frame, (perFrame.get(read.frame) ?? 0) + 1)
    const worst = [...perFrame.entries()].sort((a, b) => b[1] - a[1])[0]
    // The settle pipeline flushes twice per frame (the frame's own pass and the
    // row-measurement pass after the virtualizer measures), and each pass
    // measures once for its write decision and once for its observation: 8 is
    // that structural floor (the un-converged pipeline interleaves a fresh
    // measurement per write intent instead).
    assert.ok(worst[1] <= 8, `at most 8 layout-metric reads per frame, got ${worst[1]} in frame ${worst[0]} (${reads.length} reads total)`)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test("wheel routing probes the ancestor chain once per scroll change, not per event", async () => {
  const { page, errors } = await open()
  try {
    await page.evaluate(() => (window as any).fixture.bottom())
    await frames(page, 10)
    await page.evaluate(() => {
      const w = window as any
      w.fixture.addNested()
      w.fixture.bottom()
    })
    await frames(page, 30)
    const stats = await page.evaluate(() => {
      const w = window as any
      const stream = document.querySelector(".message-stream")!
      const counted = new Set<Element>()
      for (const row of stream.querySelectorAll("[data-virtual-follow-key], .virtual-follow-list-before")) counted.add(row)
      const inChain = (node: unknown) => node instanceof Element && stream.contains(node as Element) && node !== stream
      w.probeReads = [] as number[]
      const descriptors = [["scrollHeight", Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!], ["clientHeight", Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!]] as const
      for (const [name, descriptor] of descriptors) {
        Object.defineProperty(Element.prototype, name, {
          configurable: true,
          get() {
            if (inChain(this) && w.probeReads.length) w.probeReads[w.probeReads.length - 1] += 1
            return (descriptor.get as () => number).call(this)
          },
        })
      }
      const target = document.querySelector("[data-nested-content]")!
      for (let index = 0; index < 10; index++) {
        w.probeReads.push(0)
        target.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }))
      }
      return { probeReads: w.probeReads as number[] }
    })
    assert.ok(stats.probeReads[0] > 0, "the first wheel event must probe the chain")
    for (let index = 1; index < stats.probeReads.length; index++) {
      assert.ok(stats.probeReads[index] <= 2, `wheel event ${index} must not re-probe ancestors (${stats.probeReads[index]} layout reads)`)
    }
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test("reactive effect re-runs do not write scrollTop synchronously", async () => {
  const { page, errors } = await open()
  try {
    await page.evaluate(() => {
      const w = window as any
      w.fixture.bottom()
      w.fixture.stopFollow()
      const el = document.querySelector(".message-stream") as HTMLElement
      el.scrollTop = Math.floor(el.scrollTop / 2)
    })
    await frames(page, 10)
    const landed = await page.evaluate(async () => {
      const w = window as any
      const el = document.querySelector(".message-stream") as HTMLElement
      const before = el.scrollTop
      w.fixture.pin()
      const afterEffectBatch = el.scrollTop
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return { before, afterEffectBatch, afterFrames: el.scrollTop }
    })
    assert.ok(landed.afterFrames > landed.before, `the pin must land (${landed.before} -> ${landed.afterFrames})`)
    assert.equal(landed.afterEffectBatch, landed.before, "the effect re-run must not write scrollTop synchronously")
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
