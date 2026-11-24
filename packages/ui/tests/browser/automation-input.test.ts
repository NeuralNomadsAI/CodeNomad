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
  const marked = () => Boolean(globalThis.__codenomadAutomationDepth) || (globalThis.__codenomadAutomationInputUntil || 0) >= performance.now()
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
  handle.addEventListener("pointermove", event => {
    if (!dragging || (window.moveOnlyAtDrop && event.clientX !== window.moveOnlyAtDrop)) return
    handle.style.left = (event.clientX - 20) + "px"
    handle.style.top = (event.clientY - handle.offsetParent.getBoundingClientRect().top - 20) + "px"
  })
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
      for (const [route, fixture] of [["/automation-dock", "interruption-dock"], ["/automation-tabs", "tab-chrome"]]) s.middlewares.use(route, async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml(route, `<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/${fixture}.tsx"></script></body></html>`))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } }).catch(async error => { await cache.dispose(); throw error })
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
    assert.deepEqual(await act({ action: "press", key: "Tab", ref: query }), { focused: "button \"Go\"" },
      "Tab moves focus away from its exact ref, then releases in the same main document")
    assert.equal(await page.evaluate(() => (globalThis as any).__codenomadAutomationInputUntil <= performance.now()), true,
      "the mark ends after each action but retains its timestamp for queued events")

    await act({ action: "hover", ref: await refFor(/button "Hover me"/) })
    assert.equal(await page.textContent("#hover-state"), "hovered")

    await log(page)
    await act({ action: "click", ref: await refFor(/button "Open menu"/) })
    assert.deepEqual((await log(page)).filter(entry => entry.startsWith("pointerdown")), ["pointerdown:menu-trigger::true:true"])
    await act({ action: "click", ref: await refFor(/menuitem "Menu item"/, "Menu item") })
    assert.ok((await log(page)).includes("menu-item"), "a pointerdown-only menu opens and its item is clickable")

    await page.locator("#scroller").evaluate(node => {
      node.insertAdjacentHTML("afterbegin", '<button style="width:100%;height:100px">Folder 12</button>')
    })
    const scroller = await refFor(/region "Scroller"/)
    await assert.rejects(act({ action: "click", ref: scroller }), /covered by button "Folder 12"/)
    await act({ action: "scroll", ref: scroller, direction: "down", amount: 500 })
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

test("a hidden press target never submits the focused draft, and dragging cannot scroll under its start point", async () => {
  const run = await openAutomationPage(automation, `${base}/automation-inputs`)
  try {
    const { page, act, refFor } = run
    await page.evaluate(() => {
      const details = document.createElement("details")
      details.open = true
      details.innerHTML = '<summary>Target</summary><input aria-label="Hidden target">'
      document.body.append(details)
    })
    const hidden = await refFor(/textbox "Hidden target"/)
    await page.evaluate(() => { document.querySelector("details")!.open = false })
    await page.focus("#query")
    await log(page)
    await assert.rejects(act({ action: "press", ref: hidden, key: "Enter" }), /cannot take focus/)
    assert.deepEqual(await log(page), [], "no key or implicit submit reached the focused field")

    await page.evaluate(() => {
      const list = document.createElement("section")
      list.innerHTML = Array.from({ length: 35 }, (_, index) => `<button style="display:block;height:65px" aria-label="Row ${index + 1}">${index + 1}</button>`).join("")
      document.body.append(list)
    })
    const first = await refFor(/button "Row 1"/), last = await refFor(/button "Row 35"/)
    await page.getByRole("button", { name: "Row 1", exact: true }).scrollIntoViewIfNeeded()
    const before = await page.evaluate(() => scrollY)
    await log(page)
    await assert.rejects(act({ action: "drag", ref: first, to: last }), /no visible box to drag to/)
    assert.equal(await page.evaluate(() => scrollY), before, "dragging never scrolls the page under a saved start point")
    assert.deepEqual(await log(page), [], "no row was pressed")
  } finally { await run.close() }
})

test("a pointer move can reveal a cover, but the cover receives no click", async () => {
  const run = await openAutomationPage(automation, `${base}/automation-inputs`)
  try {
    const { page, act, refFor } = run
    const ref = await refFor(/button "Hover me"/)
    await page.evaluate(() => {
      const button = document.getElementById("hover-target")!
      button.addEventListener("pointerenter", () => {
        const { x, y, width, height } = button.getBoundingClientRect()
        const cover = document.createElement("button")
        cover.id = "late-cover"
        cover.textContent = "Late cover"
        Object.assign(cover.style, { position: "fixed", left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px`, zIndex: "100" })
        document.body.append(cover)
      }, { once: true })
    })
    const error = await act({ action: "click", ref }).catch((error: Error) => error.message)
    assert.deepEqual(await log(page), [], "neither the cover nor the inspected target receives the click")
    assert.match(String(error), /is covered by button "Late cover"/)
  } finally { await run.close() }
})

test("a scheduled mouse release refuses a substitute inside the inspected button", async () => {
  const run = await openAutomationPage(automation, `${base}/automation-inputs`)
  try {
    const { page, act, refFor } = run
    assert.equal(await page.evaluate(() => document.hasFocus()), true)
    const ref = await refFor(/button "Hover me"/)
    await page.evaluate(() => {
      const button = document.getElementById("hover-target")!
      button.style.position = "relative"
      button.addEventListener("pointerdown", () => {
        const child = document.createElement("span")
        child.style.cssText = "position:absolute;inset:0"
        child.addEventListener("pointerup", () => (window as any).log.push("substitute-release"))
        button.append(child)
      }, { once: true })
    })
    const failure = await act({ action: "click", ref }).catch((error: Error) => error.message)
    assert.deepEqual(await log(page), ["pointerdown:hover-target::true:true"])
    assert.match(String(failure), /original pointer recipient changed.*Input already sent/i)
  } finally { await run.close() }
})

test("a short drag refuses release when capture loss changes the exact recipient", async () => {
  const run = await openAutomationPage(automation, `${base}/automation-inputs`)
  try {
    const { page, act, refFor } = run
    const ref = await refFor(/button "Handle"/), to = await refFor(/region "Drop zone"/)
    for (const [moveLate, loseCapture] of [[false, false], [true, false], [false, true]]) {
      await page.evaluate(({ moveLate, loseCapture }) => {
        const source = document.getElementById("handle")!, destination = document.getElementById("zone")!
        Object.assign(source.style, { left: "20px", top: "20px", zIndex: "1" })
        destination.style.left = "76px"
        const box = destination.getBoundingClientRect()
        const end = Math.floor(box.x + box.width / 2)
        ;(window as any).moveOnlyAtDrop = moveLate && end
        ;(window as any).dropped = false
        if (loseCapture) source.addEventListener("pointermove", event => {
          if (event.buttons === 1 && event.clientX === end) {
            source.releasePointerCapture(event.pointerId)
            source.style.left = "20px"
          }
        })
      }, { moveLate, loseCapture })
      const drag = act({ action: "drag", ref, to })
      if (loseCapture) await assert.rejects(drag, /original pointer recipient changed.*Input already sent/)
      else await drag
      assert.equal(await page.evaluate(() => (window as any).dropped), !loseCapture)
    }
  } finally { await run.close() }
})

test("automation reorders real Solid DnD tabs while the uncaptured source follows the pointer", async () => {
  const run = await openAutomationPage(automation, `${base}/automation-tabs`, async page => {
    await page.setViewportSize({ width: 1200, height: 800 })
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  })
  try {
    const { page, refFor, act } = run
    const tabs = page.locator('[data-fixture="instances"] [role="tab"]')
    await tabs.nth(1).waitFor()
    const first = await tabs.first().innerText()
    await page.evaluate(() => {
      const events: unknown[] = []
      Object.assign(window, { tabDragEvents: events })
      for (const type of ["gotpointercapture", "pointerup"]) document.addEventListener(type, event => {
        const tab = (event.target as Element).closest('[role="tab"]')
        events.push([type, event.isTrusted, tab?.textContent])
      }, true)
    })
    const ref = await refFor(/tab "Project 0/), to = await refFor(/tab "Project 1/)
    await act({ action: "drag", ref, to })
    assert.equal(await tabs.nth(1).innerText(), first)
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, "tabDragEvents")), [["pointerup", true, first]])
  } finally { await run.close() }
})

test("a label forwards its own pointer hit, but not one on a different interactive descendant", async () => {
  const run = await openAutomationPage(automation, `${base}/automation-inputs`)
  try {
    const { page, act, refFor } = run
    await page.evaluate(() => {
      const label = document.createElement("label")
      label.style.cssText = "position:relative;display:inline-block;width:120px;height:36px"
      label.innerHTML = `<input id="labeled-control" type="checkbox" aria-label="Labeled control"
        style="position:absolute;inset:0;width:100%;height:100%;margin:0;pointer-events:none">
        <span style="position:absolute;inset:0">Plain label</span>`
      document.body.prepend(label)
    })
    const ref = await refFor(/checkbox "Labeled control"/)
    await act({ action: "click", ref })
    const checkbox = page.locator("#labeled-control")
    assert.equal(await checkbox.isChecked(), true)
    await page.evaluate(() => {
      const link = document.createElement("a")
      link.href = "#wrong"
      link.textContent = "Different action"
      link.style.cssText = "position:absolute;inset:0"
      document.querySelector("#labeled-control")!.parentElement!.append(link)
    })
    await log(page)
    await assert.rejects(act({ action: "click", ref }), /covered by a "Different action"/)
    assert.equal(await checkbox.isChecked(), true)
    assert.deepEqual(await log(page), [])

    await page.evaluate(() => {
      const button = document.getElementById("item")!
      document.getElementById("menu")!.hidden = false
      button.style.position = "relative"
      const other = document.createElement("input")
      other.id = "other-control"
      other.type = "checkbox"
      const label = document.createElement("label")
      label.htmlFor = other.id
      label.style.cssText = "position:absolute;inset:0"
      label.innerHTML = '<span role="menuitem">Foreign label</span>'
      button.append(label)
      document.body.append(other)
    })
    const item = await refFor(/menuitem "Menu item Foreign label"/)
    const failure = await act({ action: "click", ref: item }).catch((error: Error) => error.message)
    assert.deepEqual(await log(page), [])
    assert.match(String(failure), /covered by label "Foreign label"/)
    await assert.rejects(act({ action: "click", ref: await refFor(/menuitem "Foreign label"/) }), /covered by label "Foreign label"/)
    assert.equal(await page.locator("#other-control").isChecked(), false)
  } finally { await run.close() }
})

test("a value setter refuses the field from the occurrence left during focus", async () => {
  const run = await openAutomationPage(automation, `${base}/automation-inputs`)
  try {
    const { page, act, refFor } = run
    await page.evaluate(() => {
      document.body.insertAdjacentHTML("beforeend", `
        <section data-tab-id="a" data-instance-id="project" data-tab-visible="true">
          <input id="date-a" type="date" aria-label="First date" value="2026-11-21">
        </section><section data-tab-id="b" data-instance-id="project" data-tab-visible="false">
          <input id="date-b" type="date" aria-label="Second date" value="2026-11-22">
        </section>`)
      const field = document.querySelector<HTMLInputElement>("#date-a")!
      field.addEventListener("focus", () => {
        field.parentElement!.dataset.tabVisible = "false"
        field.parentElement!.style.opacity = "0" // The cached occurrence keeps its node and focus.
        field.parentElement!.nextElementSibling!.setAttribute("data-tab-visible", "true")
      }, { once: true })
      for (const event of ["input", "change"]) field.addEventListener(event, () => (window as any).log.push(event))
    })
    const ref = await refFor(/"First date"/)
    const failure = await act({ action: "type", ref, text: "2027-01-01" }).catch((error: Error) => error.message)
    assert.deepEqual(await log(page), [])
    assert.equal(await page.inputValue("#date-a"), "2026-11-21")
    assert.equal(await page.inputValue("#date-b"), "2026-11-22")
    assert.match(String(failure), /active tab changed/i)
  } finally { await run.close() }
})

for (const refusal of ["tab", "read-only", "command"] as const) test(`empty type refuses deletion after ${refusal} changes`, async () => {
  const run = await openAutomationPage(automation, `${base}/automation-inputs`)
  try {
    const { page, act, refFor } = run
    await page.evaluate(refusal => {
      const field = document.querySelector<HTMLInputElement>("#query")!
      field.value = "Keep the draft"
      document.body.insertAdjacentHTML("beforeend", `
        <section data-tab-id="a" data-instance-id="project" data-tab-visible="true"></section>
        <section data-tab-id="b" data-instance-id="project" data-tab-visible="false"></section>`)
      if (refusal === "tab") field.addEventListener("focus", () => {
        document.querySelector("[data-tab-id=a]")!.setAttribute("data-tab-visible", "false")
        document.querySelector("[data-tab-id=b]")!.setAttribute("data-tab-visible", "true")
      }, { once: true })
      if (refusal === "read-only") field.addEventListener("focus", () => { field.readOnly = true }, { once: true })
      if (refusal === "command") document.execCommand = () => false
      field.addEventListener("input", () => (window as any).log.push("deleted"))
    }, refusal)
    const ref = await refFor(/textbox "Query"/)
    await assert.rejects(act({ action: "type", ref, text: "" }),
      refusal === "tab" ? /active tab changed/ : refusal === "read-only" ? /read-only/ : /refused.*delet/i)
    assert.equal(await page.inputValue("#query"), "Keep the draft")
    assert.deepEqual(await log(page), [])
  } finally { await run.close() }
})

for (const via of ["select", "click"]) test(`a native ${via} refuses options changed during focus`, async () => {
  const run = await openAutomationPage(automation, `${base}/automation-inputs`)
  try {
    const { page, act, refFor } = run
    await page.evaluate(via => {
      const select = document.createElement("select")
      select.setAttribute("aria-label", "Choices")
      select.multiple = true
      select.innerHTML = '<option selected>Keep</option><option>Pick</option>'
      const picked = select.options[1]
      select.addEventListener("focus", () => {
        if (via === "click") picked.replaceWith(picked.cloneNode(true))
        else picked.remove()
      }, { once: true })
      for (const event of ["input", "change"]) select.addEventListener(event, () => (window as any).log.push(event))
      document.body.append(select)
    }, via)
    const input = via === "click" ? { action: via, ref: await refFor(/option "Pick"/) }
      : { action: via, ref: await refFor(/listbox "Choices"/), values: ["Pick"] }
    const failure = await act(input).catch((error: Error) => error.message)
    assert.deepEqual(await log(page), [])
    assert.deepEqual(await page.locator("select option:checked").allTextContents(), ["Keep"])
    assert.match(String(failure), /options of .* changed.*inspect again/i)
  } finally { await run.close() }
})

test("press and type refuse a substitute that takes focus just before native input", async () => {
  const run = await openAutomationPage(automation, `${base}/automation-inputs`)
  try {
    const { page, act, refFor } = run
    const ref = await refFor(/textbox "Query"/)
    const substitute = page.locator("#substitute")
    await page.evaluate(() => {
      const substitute = document.createElement("input")
      substitute.id = "substitute"
      document.getElementById("search")!.append(substitute)
    })
    for (const input of [{ action: "press", key: "Enter" }, { action: "type", text: "Not for this field" }]) {
      await page.evaluate(() => {
        let until = 0, steal = true
        Object.defineProperty(window, "__codenomadAutomationInputUntil", {
          configurable: true,
          get() { return until },
          set(value) {
            until = value
            if (steal) {
              steal = false
              document.getElementById("substitute")!.focus()
            }
          },
        })
      })
      const error = await act({ ...input, ref }).catch((error: Error) => error.message)
      assert.deepEqual(await log(page), [], "no Enter or implicit submit was sent to the substitute")
      assert.equal(await substitute.inputValue(), "", "the substitute did not receive the text")
      assert.match(String(error), /focus.*changed/i)
    }
    await page.evaluate(() => {
      const query = document.querySelector<HTMLInputElement>("#query")!
      const substitute = document.querySelector<HTMLInputElement>("#substitute")!
      substitute.value = "Keep this"
      query.select = () => { substitute.focus(); substitute.select() }
    })
    await assert.rejects(act({ action: "type", ref, text: "" }), /cannot take focus/)
    assert.equal(await substitute.inputValue(), "Keep this", "clearing the inspected field cannot delete a substitute's selection")
  } finally { await run.close() }
})

test("pointer admission checks the viewport after scrolling, including closed shadow frame owners", async () => {
  const run = await openAutomationPage(automation, `${base}/automation-inputs`)
  try {
    const { page, act } = run
    for (const closed of [false, true]) {
      await page.evaluate(async closed => {
        document.body.style.minHeight = "200vh"
        scrollTo(0, 230)
        const frame = document.createElement("iframe")
        frame.srcdoc = '<script>document.addEventListener("wheel", () => parent.postMessage("child-wheel", "*"))</script>'
        const loaded = new Promise(resolve => frame.addEventListener("load", resolve, { once: true }))
        const owner = document.createElement("div")
        owner.id = "input-frame-owner"
        Object.assign(owner.style, { position: "fixed", top: "10%", left: "10%", width: "120px",
          height: "80px", transform: "translate(-50%, -50%)", zIndex: "100" })
        Object.assign(frame.style, { width: "100%", height: "100%", border: "0" })
        const root = closed ? owner.attachShadow({ mode: "closed" }) : owner
        root.append(frame)
        document.body.append(owner)
        await loaded
        window.addEventListener("message", event => {
          if (event.source === frame.contentWindow && event.data === "child-wheel") (window as any).log.push("child-wheel")
        })
        Object.defineProperty(window, "__codenomadAutomationInputUntil", {
          configurable: true,
          get() { return 0 },
          set() { owner.style.top = owner.style.left = "50%" },
        })
      }, closed)
      await assert.rejects(act({ action: "scroll", direction: "down", amount: 50 }),
        error => error instanceof Error && /pointer.*main document/.test(error.message) && !/Input already sent/.test(error.message))
      assert.equal(await page.evaluate(() => scrollY), 230)
      assert.deepEqual(await log(page), [])
      await page.evaluate(() => {
        document.querySelector("#input-frame-owner")?.remove()
        Reflect.deleteProperty(window, "__codenomadAutomationInputUntil")
      })
    }
  } finally { await run.close() }
})

/** Exercises input on a real InterruptionDock question and reads the recorded provenance. */
async function answerDock(via: "click" | "press" | "press-stalled" | "click-recovered" | "click-stalled" | "human"): Promise<unknown> {
  const run = await openAutomationPage(automation, `${base}/automation-dock`, async page => {
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  }, via === "click-stalled" ? 2_000 : 10_000)
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
      if (via === "press-stalled" || via === "click-recovered" || via === "click-stalled") {
        const keyboard = via === "press-stalled"
        await page.evaluate(({ keyboard, duration }) => {
          const fixture = (window as any).fixture
          fixture.inputEvents = []
          const down = keyboard ? "keydown" : "pointerdown"
          for (const type of [down, keyboard ? "keyup" : "pointerup"]) window.addEventListener(type, event => {
            if (type === down) {
              const end = performance.now() + duration
              while (performance.now() < end) { /* Let the input lease expire before the event continues. */ }
            }
            fixture.inputEvents.push([type, event.isTrusted, fixture.automationInputActive(event.timeStamp)])
          }, { capture: true, once: true })
        }, { keyboard, duration: via === "click-recovered" ? 25_000 : 16_000 })
        const input = keyboard ? { action: "press", key: "Enter" }
          : { action: "click", ref: await refFor(/button "Submit"/, "Submit") }
        await assert.rejects(act(input), /outcome is unknown/)
        const { events, replies } = await page.evaluate(() => {
          const fixture = (window as any).fixture
          return { events: fixture.inputEvents, replies: fixture.replies.length }
        })
        assert.deepEqual(events, via === "click-stalled" ? [["pointerdown", true, true]]
          : keyboard ? [["keydown", true, true], ["keyup", true, true]] : [["pointerdown", true, true], ["pointerup", true, true]])
        if (via === "click-stalled") {
          assert.equal(replies, 0, "an unverified release cannot complete the admitted down event")
          return
        }
      } else if (via === "press") {
        await act({ action: "press", key: "Enter", ref }).catch((error: Error) => {
          // Enter can complete the answer and dismiss the field before the guarded keyUp.
          if (!/(?:no longer in the page|focus changed).*Input already sent/i.test(error.message)) throw error
        })
      }
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

test("stalled dock input keeps its provenance and completes a click only after a verified release", async () => {
  assert.equal(await answerDock("press-stalled"), undefined, "a delayed Enter and its default click still are not human")
  assert.equal(await answerDock("click-recovered"), undefined, "a verified cleanup release retains its original provenance")
  await answerDock("click-stalled")
})
