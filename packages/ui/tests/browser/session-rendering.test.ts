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
          const name = ["tall-append", "nested-scroll", "navigation", "undo"].find(name => req.url?.includes(name)) ?? "session"
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
  await page.addInitScript(`(() => {
    window.fixtureScrollEvents = [];
    for (const type of ['wheel', 'scroll', 'pointerdown']) document.addEventListener(type, event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      window.fixtureScrollEvents.push({ type, target: target.className, deltaY: event.deltaY,
        top: target.scrollTop, height: target.scrollHeight, time: performance.now() });
      if (window.fixtureScrollEvents.length > 80) window.fixtureScrollEvents.shift();
    }, { capture: true, passive: true });
  })()`)
  await page.route("**/api/**", route => route.fulfill({ contentType: route.request().url().includes("events") ? "text/event-stream" : "application/json", body: "" }))
  try {
    await page.goto(`${baseUrl}/fixture?${name}`)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await run(page)
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error("Browser fixture failure", name, await page.evaluate(() => ({
      state: (window as any).fixture?.snapshot?.(), events: (window as any).fixtureScrollEvents,
      streams: Array.from(document.querySelectorAll(".message-stream")).map(el => ({ top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight })),
    })))
    throw error
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

test("return to latest from a 620-record history replaces the saved older-page snapshot", async () => {
  await open("session", async page => {
    await page.evaluate(() => (window as any).fixture.seedHistory(620))
    await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("History 619"))
    await page.waitForFunction(() => (window as any).fixture.snapshot().scroll?.windowIsLatest === true)
    const initial = await page.evaluate(() => performance.now())
    await page.waitForFunction(initial => performance.now() - initial > 1200, initial)
    const stream = page.locator(".message-stream")
    const box = await stream.boundingBox()
    assert.ok(box)
    await page.mouse.move(box.x + box.width - 5, box.y + box.height / 2)
    await page.mouse.wheel(0, -1000000)
    await page.waitForFunction(() => (window as any).fixture.snapshot().window.kind !== "latest")
    await page.waitForFunction(() => (window as any).fixture.snapshot().scroll?.windowIsLatest === false)
    const ready = await page.evaluate(() => performance.now())
    await page.waitForFunction(ready => performance.now() - ready > 1000, ready)
    await page.mouse.move(box.x + 10, box.y + box.height / 2)
    await page.mouse.wheel(0, -400)
    await page.waitForFunction(() => { const el = document.querySelector(".message-stream")!; return el.scrollHeight - el.clientHeight - el.scrollTop > 100 }, undefined, { timeout: 5000 })
    await page.locator(".message-scroll-controls").hover()
    await page.getByRole("button", { name: "Scroll to latest message", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.snapshot().window.kind === "latest")
    await page.waitForFunction(() => (window as any).fixture.snapshot().scroll?.windowIsLatest === true, undefined, { timeout: 5000 })
    const latest = await page.evaluate(() => performance.now())
    await page.waitForFunction(latest => performance.now() - latest > 1200, latest)
    assert.equal(await page.evaluate(() => (window as any).fixture.snapshot().scroll.windowCursor), undefined,
      "A latest-page snapshot must retire the older resume cursor before cold restoration")
    await page.evaluate(() => (window as any).fixture.switchAway())
    await page.evaluate(() => (window as any).fixture.return())
    await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("History 619"))
  })
})

test("sending from a long transcript neither blanks nor jumps down during optimistic reordering", async () => {
  await open("session", async page => {
    await page.evaluate(() => (window as any).fixture.seedHistory())
    await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("History 59"))
    await page.evaluate(`new Promise(resolve => { let n = 30; const frame = () => --n ? requestAnimationFrame(frame) : resolve(); requestAnimationFrame(frame) })`)
    await page.evaluate(`(() => {
      window.paintFrames = [];
      window.watchPaint = true;
      const frame = () => {
        const stream = document.querySelector('.message-stream');
        const bounds = stream.getBoundingClientRect();
        const visible = [...stream.querySelectorAll('[data-view="message-item"]')].filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom && rect.height > 0;
        });
        const anchor = stream.querySelector('[data-message-id="msg_0059"]');
        window.paintFrames.push({ top: stream.scrollTop, height: stream.scrollHeight, visible: visible.length, anchorTop: anchor?.getBoundingClientRect().top ?? null });
        if (window.watchPaint) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    })()`)
    const prompt = page.locator("textarea:visible").first()
    await prompt.fill("New prompt after history")
    await prompt.press("Enter")
    await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("New prompt after history"))
    await page.evaluate(`new Promise(resolve => { let n = 45; const frame = () => --n ? requestAnimationFrame(frame) : resolve(); requestAnimationFrame(frame) })`)
    const frames = await page.evaluate(() => { (window as any).watchPaint = false; return (window as any).paintFrames as Array<{ top: number; height: number; visible: number; anchorTop: number | null }> })
    assert.ok(frames.length > 20)
    assert.deepEqual(frames.filter(frame => frame.visible === 0), [], "No blank frame may be painted during a submit")
    const initial = frames[0], final = frames.at(-1)!
    assert.ok(final.top > initial.top, "The new prompt must advance the tail")
    for (const [index, frame] of frames.entries()) {
      assert.ok(frame.anchorTop !== null, "The last historical reply must stay mounted")
      assert.ok(frame.top >= initial.top - 2 && frame.top <= final.top + 2, "No scroll collapse or overshoot may be painted")
      assert.ok(frame.height >= initial.height - 2 && frame.height <= final.height + 2, "No estimated-height spike may be painted")
      if (index > 0) assert.ok(frame.anchorTop <= frames[index - 1].anchorTop! + 2, "Historical content must not bounce downward")
    }
    await page.evaluate(() => { (window as any).fixture.start(); (window as any).fixture.delta("Reply after stable submit") })
    await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("Reply after stable submit"))
    assert.ok(await page.locator("[data-virtual-follow-key]").count() < 40, "Measurement probes must not mount the full history")
  })
})

for (const following of [true, false]) {
  test(`consecutive resets retain unmeasured insertions with more than eight visible rows (following=${following})`, async () => {
    await open("navigation", async page => {
      await page.evaluate(follow => follow ? (window as any).fixture.follow() : (window as any).fixture.middle(), following)
      await page.waitForFunction(follow => follow
        ? document.querySelector('[data-virtual-follow-key="row-199"]')?.getBoundingClientRect().bottom === 700
        : document.querySelector('[data-virtual-follow-key="row-100"]')?.getBoundingClientRect().top === 0, following)
      await page.evaluate(`new Promise(resolve => { let n = 30; const frame = () => --n ? requestAnimationFrame(frame) : resolve(); requestAnimationFrame(frame) })`)
      await page.evaluate(() => (window as any).fixture.reorder())
      await page.waitForFunction(() => document.querySelector('[data-virtual-follow-key="prompt"]')?.getBoundingClientRect().height === 48, undefined, { timeout: 5000 })
      if (!following) {
        const snapshot = await page.evaluate(() => (window as any).fixture.snapshot())
        assert.equal(snapshot.anchorKey, "row-100")
        assert.equal(snapshot.anchorOffset, 0)
        assert.equal(snapshot.atBottom, false)
      }
      await page.evaluate(() => (window as any).fixture.bottom())
      await page.waitForFunction(() => document.querySelector('[data-virtual-follow-key="prompt"]')?.getBoundingClientRect().bottom === 700)
      assert.equal(await page.locator(".message-stream").evaluate(el => el.scrollHeight), 201 * 48)
      assert.ok(await page.locator("[data-virtual-follow-key]").count() < 60)
    })
  })
}

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

test("a following reader can wheel to the older-page boundary", async () => {
  await open("navigation", async page => {
    await page.evaluate(() => (window as any).fixture.follow())
    await page.waitForFunction(() => document.querySelector('.message-stream')!.scrollTop > 8000)
    await page.evaluate(`new Promise(resolve => setTimeout(resolve, 250))`)
    const box = (await page.locator(".message-stream").boundingBox())!
    await page.mouse.move(box.x + 10, box.y + 350)
    await page.mouse.wheel(0, -100000)
    await page.waitForFunction(() => document.querySelector('.message-stream')!.scrollTop === 0)
    await page.waitForFunction(() => (window as any).fixture.reachedTop() > 0, undefined, { timeout: 2000 })
  })
})

for (const resizeHead of [false, true]) test(`rolling the 200-row window keeps an escaped anchor while a later reply grows (head resize=${resizeHead})`, async () => {
  await open("navigation", async page => {
    await page.evaluate(() => (window as any).fixture.nearTail())
    await page.waitForFunction(() => document.querySelector('[data-virtual-follow-key="row-180"]')?.getBoundingClientRect().top === 0)
    await page.evaluate(`new Promise(resolve => setTimeout(resolve, 250))`)
    await page.evaluate(() => (window as any).fixture.roll())
    const frames = await page.evaluate(`new Promise(resolve => {
      let i = 0; const frames = [];
      const frame = () => {
        window.fixture.growTail(48 + i * 12);
        if (${resizeHead} && i === 0) window.fixture.resizeHead(80);
        const row = document.querySelector('[data-virtual-follow-key="row-180"]');
        frames.push(row?.getBoundingClientRect().top);
        if (++i === 40) resolve(frames); else requestAnimationFrame(frame);
      }; requestAnimationFrame(frame);
    })`) as number[]
    assert.ok(frames.every(top => top !== undefined && Math.abs(top) < 2), `Later reply growth moved the reader: ${frames.join(",")}`)
    const box = (await page.locator(".message-stream").boundingBox())!
    await page.mouse.move(box.x + 10, box.y + 350)
    await page.mouse.wheel(0, -300)
    await page.waitForFunction(() => (window as any).fixture.snapshot().anchorKey !== "row-180")
    const escaped = await page.evaluate(() => (window as any).fixture.snapshot())
    await page.evaluate(() => (window as any).fixture.growTail(2000))
    await page.evaluate(`new Promise(resolve => setTimeout(resolve, 300))`)
    const afterGesture = await page.evaluate(() => (window as any).fixture.snapshot())
    assert.equal(afterGesture.anchorKey, escaped.anchorKey, "A later wheel must cancel retained-anchor ownership")
    assert.ok(Math.abs(afterGesture.anchorOffset - escaped.anchorOffset) < 2)
  })
})

test("short appends and disjoint 200-row pages never expose estimated blank space", async () => {
  await open("tall-append", async page => {
    await page.waitForFunction(() => (document.querySelector(".message-stream")?.scrollHeight ?? 0) >= 3320)
    await page.evaluate(() => (window as any).fixture.bottom())
    await page.evaluate(`new Promise(resolve => { let n=12; const frame=()=>--n?requestAnimationFrame(frame):resolve();requestAnimationFrame(frame) })`)
    await page.evaluate(`(() => {
      window.appendFrames=[]; window.trackAppend=true;
      const frame=()=>{const stream=document.querySelector('.message-stream');const box=stream.getBoundingClientRect();
        const rows=Array.from(stream.querySelectorAll('[data-row]')).map(el=>{const r=el.getBoundingClientRect();return {y:r.top-box.top,h:r.height,text:el.textContent}});
        window.appendFrames.push({top:stream.scrollTop,height:stream.scrollHeight,viewport:stream.clientHeight,rows});
        if(window.trackAppend)requestAnimationFrame(frame);
      };requestAnimationFrame(frame);
    })()`)
    await page.evaluate(() => (window as any).fixture.append())
    await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("new-prompt"))
    await page.evaluate(() => (window as any).fixture.metadata())
    await page.evaluate(`new Promise(resolve => { let n=25; const frame=()=>--n?requestAnimationFrame(frame):resolve();requestAnimationFrame(frame) })`)
    await page.evaluate(() => (window as any).fixture.replacePage())
    await page.evaluate(`new Promise(resolve => { let n=25; const frame=()=>--n?requestAnimationFrame(frame):resolve();requestAnimationFrame(frame) })`)
    const frames=await page.evaluate(() => { (window as any).trackAppend=false; return (window as any).appendFrames })
    for(const frame of frames) {
      assert.ok(frame.rows.some((r: any)=>r.h>0 && r.y<frame.viewport && r.y+r.h>0), `blank append frame: ${JSON.stringify(frame)}`)
      const bottom=Math.max(...frame.rows.map((r: any)=>r.y+r.h))
      assert.ok(bottom >= frame.viewport-4, `bottom overshot rendered content by ${frame.viewport-bottom}px`)
    }
  })
})

for (const operation of ["bottom", "settleBottom"]) test(`an upward wheel wins over ${operation} while measured rows resize`, async () => {
  await open("tall-append", async page => {
    const stream = page.locator(".message-stream")
    const box = await stream.boundingBox()
    assert.ok(box)
    await page.mouse.move(box.x + 10, box.y + box.height / 2)
    await page.evaluate(operation => (window as any).fixture[operation](), operation)
    await page.mouse.wheel(0, -100000)
    await page.waitForFunction(() => document.querySelector(".message-stream")!.scrollTop === 0)
    await page.evaluate(() => (window as any).fixture.resizeReply(4200))
    const offsets = await page.evaluate(`new Promise(resolve => {
      const offsets = []; let count = 0;
      const frame = () => { offsets.push(document.querySelector('.message-stream').scrollTop);
        if (++count === 30) resolve(offsets); else requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
    })`) as number[]
    assert.ok(offsets.every(offset => offset < 2), `A cancelled bottom operation pulled the reader back: ${offsets.join(",")}`)
  })
})

test("a real send stays rendered across delayed admission, inbox echo and authoritative reloads", async () => {
  await open("session", async page => {
    await page.evaluate(() => (window as any).fixture.delayPrompt())
    const marker = "Pending prompt must never disappear"
    const prompt = page.locator("textarea:visible").first()
    await prompt.fill(marker)
    await prompt.press("Enter")
    await page.waitForFunction(() => (window as any).fixture.admitted())
    const assertPrompt = async () => {
      const rows = page.locator(".message-stream-block").filter({ hasText: marker })
      assert.equal(await rows.count(), 1)
      const visible = await rows.isVisible()
      if (!visible) console.error("Pending prompt geometry", await rows.evaluate(el => {
        const ancestors = []
        for (let node: Element | null = el; node; node = node.parentElement) {
          const style = getComputedStyle(node), rect = node.getBoundingClientRect()
          ancestors.push({ className: node.className, visibility: style.visibility, display: style.display,
            height: rect.height, width: rect.width, key: node.getAttribute("data-virtual-follow-key") })
        }
        return ancestors
      }))
      assert.equal(visible, true)
    }
    await assertPrompt()
    for (const phase of ["before-accept", "accepted", "inbox-echo", "persisted"]) {
      if (phase === "accepted") await page.evaluate(() => (window as any).fixture.acceptPrompt())
      if (phase === "inbox-echo") await page.evaluate(() => (window as any).fixture.echoPrompt())
      if (phase === "persisted") await page.evaluate(() => (window as any).fixture.persistPrompt())
      await page.evaluate(() => (window as any).fixture.reload())
      await assertPrompt()
      await page.evaluate(() => (window as any).fixture.switchAway())
      await page.evaluate(() => (window as any).fixture.return())
      // Returning mounts a fresh virtualizer. DOM text can already exist in an
      // unmeasured, hidden row; that is not the first visible restored frame.
      // Only the remount gets this readiness wait. Reloads above must retain
      // the already-visible prompt without a recovery wait.
      await page.locator(".message-stream-block").filter({ hasText: marker }).waitFor({ state: "visible" })
      await assertPrompt()
      const stable = await page.evaluate(`new Promise(resolve => {
        let remaining = 12
        const frame = () => {
          const rows = Array.from(document.querySelectorAll(".message-stream-block"))
            .filter(row => row.textContent?.includes(${JSON.stringify(marker)}))
          const rect = rows[0]?.getBoundingClientRect()
          if (rows.length !== 1 || !rect?.height || !rect.width || getComputedStyle(rows[0]).visibility === "hidden") {
            resolve(false)
          } else if (--remaining === 0) resolve(true)
          else requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      })`)
      assert.equal(stable, true, `The ${phase} prompt must stay visible after its first restored frame`)
    }
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

test("undo of the first prompt stays empty after cold reload and native reprojection", async () => {
  await open("undo", async page => {
    await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("Later answer"))
    const first = page.locator('.message-stream-block[data-message-id="msg_01"]')
    await first.hover()
    await first.getByRole("button", { name: "Undo changes up to here (deletes messages)", exact: true }).click()
    await page.waitForFunction(() => (document.querySelector("textarea") as HTMLTextAreaElement)?.value === "Earlier prompt")
    await page.reload()
    await page.waitForFunction(() => (window as any).fixture?.snapshot().storedRevert?.messageID === "msg_01")
    await page.evaluate(() => (window as any).fixture.reproject())
    const state = await page.evaluate(() => (window as any).fixture.snapshot())
    assert.deepEqual(state.ids, [])
    assert.equal(state.prompts, 0)
    assert.equal(state.nativeCount, 6)
    assert.equal(await page.locator(".message-stream-block[data-message-id]").count(), 0)
  })
})

for (const operation of ["append", "roll"]) test(`middle-button scrolling owns nested tool output across ${operation} and the intent timeout`, async () => {
  await open("nested-scroll", async page => {
    await page.evaluate(() => (window as any).fixture.bottom())
    const output = page.locator("[data-nested-output]")
    await output.waitFor({ state: "visible" })
    await page.evaluate(() => (window as any).fixture.renderOutput())
    await page.waitForFunction(() => (document.querySelector("[data-nested-output]")?.scrollTop ?? 0) > 1000)
    await page.evaluate(`new Promise(resolve => { let n = 30; const frame = () => --n ? requestAnimationFrame(frame) : resolve(); requestAnimationFrame(frame) })`)
    const bounds = (await output.boundingBox())!
    await page.evaluate(() => document.addEventListener("pointerdown", event => {
      (window as any).middleHit = { tag: (event.target as HTMLElement)?.outerHTML?.slice(0, 180), button: event.button, y: event.clientY }
    }, { once: true }))
    await page.mouse.move(bounds.x + 100, bounds.y + 100)
    await page.mouse.down({ button: "middle" })
    assert.equal((await page.evaluate(() => (window as any).fixture.snapshot())).innerFollow, false,
      JSON.stringify(await page.evaluate(() => ({ hit: (window as any).middleHit, box: document.querySelector("[data-nested-output]")?.getBoundingClientRect().toJSON() }))))
    await page.evaluate(() => { (window as any).gestureOutput = document.querySelector("[data-nested-output]") })
    await page.evaluate(operation => (window as any).fixture[operation](), operation)
    await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    assert.equal(await page.evaluate(() => (window as any).gestureOutput === document.querySelector("[data-nested-output]")), true,
      "A streamed append must not replace the active native drag target")
    assert.equal(await output.locator("..").getAttribute("data-item-index"), operation === "roll" ? "28" : "29",
      "Keeping the keyed child must not freeze its shifted index")
    try {
      // Native middle autoscroll can begin well after pointerdown, then continue
      // outside the child. Simulate its scroll ticks, not a wheel event: this
      // exercises the real nested/outer follow controllers and renderer writes.
      const started = await page.evaluate(() => performance.now())
      await page.waitForFunction(start => performance.now() - start > 800, started)
      await page.mouse.move(bounds.x + 650, bounds.y + 30)
      await output.evaluate(el => { el.scrollTop = 900 })
      await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      let before = await output.evaluate(el => el.scrollTop)
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => (window as any).fixture.renderOutput())
        await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
        const after = await output.evaluate(el => el.scrollTop)
        assert.ok(after <= before + 1, `Tool renders must not oppose upward native middle autoscroll (${before} -> ${after})`)
        before = after
      }
      const state = await page.evaluate(() => (window as any).fixture.snapshot())
      assert.equal(state.innerFollow, false)
      assert.equal(state.outerFollow, false)
    } finally { await page.mouse.up({ button: "middle" }) }
  })
})

test("nested scroll ownership cancels an already queued bottom write and can explicitly rejoin", async () => {
  await open("nested-scroll", async page => {
    await page.evaluate(() => (window as any).fixture.bottom())
    const output = page.locator("[data-nested-output]")
    await output.waitFor({ state: "visible" })
    await page.evaluate(() => (window as any).fixture.renderOutput())
    await page.waitForFunction(() => (document.querySelector("[data-nested-output]")?.scrollTop ?? 0) > 1000)
    await output.evaluate(el => {
      (window as any).fixture.renderOutput()
      el.dispatchEvent(new PointerEvent("pointerdown", { button: 1, buttons: 4, bubbles: true }))
      el.scrollTop = 700
      el.dispatchEvent(new Event("scroll"))
    })
    await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    assert.equal(await output.evaluate(el => el.scrollTop), 700)
    assert.equal((await page.evaluate(() => (window as any).fixture.snapshot())).innerFollow, false)
    await output.evaluate(el => {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true }))
      el.scrollTop = el.scrollHeight
      el.dispatchEvent(new Event("scroll"))
    })
    assert.equal((await page.evaluate(() => (window as any).fixture.snapshot())).innerFollow, true)
  })
})
