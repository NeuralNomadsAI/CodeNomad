import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let fixture: { browser: Awaited<ReturnType<typeof chromium.launch>>; url: string; close(): Promise<void> }
before(async () => {
  const page = await borrowFixture({ name: "background-shells", routes: [{ path: "/fixture", html:
    '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/background-shells.tsx"></script></body></html>' }] })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  fixture = { browser, url: page.url, close: () => browser.close() }
})
after(async () => { await fixture?.close() })

for (const initiallyUnavailable of [false, true]) test(`a WSL project without a selected conversation refreshes on native/host events (initial failure: ${initiallyUnavailable})`, async () => {
  const page = await fixture.browser.newPage({ locale: "en-US" })
  const host = "\\\\wsl.localhost\\Ubuntu\\home\\user\\repo", native = "/home/user/repo"
  let present = false
  let failInitialRead = initiallyUnavailable
  try {
    await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
    await page.route("**/api/**", route => {
      const url = new URL(route.request().url())
      if (!url.pathname.endsWith("/background-shells")) return route.fulfill({ json: {} })
      assert.equal(url.searchParams.get("directory"), host, "the demand keeps its host-side identity")
      if (failInitialRead) {
        failInitialRead = false
        return route.fulfill({ status: 502, json: { error: "native inventory unavailable" } })
      }
      return route.fulfill({ json: { location: { directory: native }, data: present ? [{ id: "sh_wsl", command: "build in WSL",
        cwd: native, shell: "bash", file: "/tmp/log", status: "running", metadata: {}, time: { started: 1 } }] : [] } })
    })
    await page.goto(fixture.url + "?wsl=1")
    await page.getByText(initiallyUnavailable ? "Failed to load background shells." : "No background shells.", { exact: true }).waitFor()
    for (const directory of [native, host]) {
      present = true
      await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/background-shells")),
        page.evaluate(directory => (window as any).fixture.event("session.tool.success", directory), directory),
      ])
      await page.locator(".status-process-card").waitFor()
      present = false
      await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/background-shells")),
        page.evaluate(directory => (window as any).fixture.event("shell.exited", directory), directory),
      ])
      await page.locator(".status-process-card").waitFor({ state: "detached" })
    }
  } finally { await page.close() }
})

test("compact shell rows, native output and stop target the displayed background shell", async () => {
  const page = await fixture.browser.newPage({ viewport: { width: 1000, height: 700 }, locale: "en-US" })
  const errors: string[] = [], deleted: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  const shell = { id: "sh_bg", command: "pwsh -NoProfile -File build.ps1 " + "long-argument ".repeat(20),
    cwd: "/tmp/build", shell: "pwsh", file: "/tmp/output", pid: 42, metadata: { sessionID: "ses_own" }, time: { started: 1 }, status: "running" }
  let present = true, output = "plain output\nsecond line", listReads = 0, outputFailed = false
  const outputCursors: number[] = []
  try {
    await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
    await page.route("**/api/**", route => {
      const request = route.request(), url = new URL(request.url())
      let body: unknown = {}
      if (url.pathname.endsWith("/background-shells")) { listReads++; body = { data: present ? [shell] : [] } }
      else if (url.pathname.endsWith("/shell/sh_bg/output")) {
        if (outputFailed) return route.fulfill({ status: 502, json: { error: "output unavailable" } })
        const cursor = Number(url.searchParams.get("cursor"))
        outputCursors.push(cursor)
        assert.equal(url.searchParams.get("location[directory]"), "/repo")
        body = { location: { directory: "/repo" }, data: { output: output.slice(cursor), cursor: output.length, size: output.length, truncated: output.includes("\u001b") } }
      } else if (url.pathname.endsWith("/shell/sh_bg") && request.method() === "DELETE") {
        deleted.push(url.searchParams.get("location[directory]")!)
        present = false
        return route.fulfill({ status: 204 })
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) })
    })
    await page.goto(fixture.url)
    const row = page.locator(".status-process-card")
    await row.waitFor()
    for (const dir of ["ltr", "rtl"]) {
      await page.locator("aside").evaluate((el, dir) => { el.style.width = "220px"; el.dir = dir }, dir)
      const geometry = await row.evaluate(el => ({ height: el.getBoundingClientRect().height, overflow: el.scrollWidth > el.clientWidth }))
      assert.ok(geometry.height <= 38, `one compact row, got ${geometry.height}px`)
      assert.equal(geometry.overflow, false)
    }
    assert.equal(await row.getByRole("button").count(), 2)
    assert.equal(await row.locator(".lucide-terminal-square").count(), 0)
    await row.locator(".status-process-command").click()
    await page.getByRole("dialog").locator("pre").filter({ hasText: "plain output" }).waitFor()
    assert.equal(await page.getByRole("dialog").locator("pre").textContent(), output)
    const initialLength = output.length
    output += "\nthird incremental line"
    await page.getByRole("dialog").locator("pre").filter({ hasText: "third incremental line" }).waitFor()
    assert.equal(await page.getByRole("dialog").locator("pre").textContent(), output)
    assert.ok(outputCursors.includes(initialLength), "incremental reads preserve the native cursor")
    await page.getByRole("button", { name: "Close", exact: true }).click()
    output = "\u001b[31mred output\u001b[0m"
    await row.locator(".status-process-command").focus()
    await page.keyboard.press("Enter")
    await page.getByRole("dialog").locator("pre").filter({ hasText: "red output" }).waitFor()
    assert.equal(await page.getByRole("dialog").locator("pre").textContent(), "red output")
    await page.getByText("Output truncated for display.", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Close", exact: true }).click()
    await row.locator(".status-process-command").focus()
    await page.keyboard.press("Space")
    await page.getByRole("dialog").waitFor()
    await page.getByRole("button", { name: "Close", exact: true }).click()
    outputFailed = true
    await row.locator(".status-process-command").click()
    await page.getByRole("dialog").locator("pre").filter({ hasText: "Failed to load output." }).waitFor()
    await page.getByRole("button", { name: "Close", exact: true }).click()
    const count = listReads
    const originalRow = await row.elementHandle()
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/background-shells")),
      page.evaluate(() => (window as any).fixture.event("session.tool.success")),
    ])
    assert.ok(listReads > count)
    assert.equal(await originalRow!.evaluate(el => el.isConnected), true, "passive refresh preserves row actions")
    await row.getByRole("button", { name: "Stop and remove", exact: true }).click()
    await page.getByRole("alertdialog").getByRole("button", { name: "Stop and remove", exact: true }).click()
    await row.waitFor({ state: "detached" })
    assert.deepEqual(deleted, ["/repo"])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("command details, state changes and distinct arguments survive a narrow LTR/RTL refresh", async () => {
  const page = await fixture.browser.newPage({ viewport: { width: 1000, height: 700 }, locale: "en-US" })
  let shells = [
    { id: "sh_one", command: 'pwsh -NoProfile -File "C:\\Build Tools\\watch.ps1" -Port 3001', cwd: "C:\\Build Tools",
      shell: "pwsh", file: "/tmp/out", status: "running", pid: 42, metadata: {}, time: { started: 1730000000000 } },
    { id: "sh_two", command: 'pwsh -NoProfile -File "C:\\Build Tools\\watch.ps1" -Port 3002', cwd: "/tmp", shell: "bash",
      file: "/tmp/out", status: "exited", exit: 0, metadata: {}, time: { started: 1730000000000, completed: 1730000005000 } },
    { id: "sh_fail", command: "node script.js --fail", cwd: "/tmp", shell: "bash", file: "/tmp/out",
      status: "exited", exit: 1, metadata: {}, time: { started: 1 } },
    { id: "sh_timeout", command: "node script.js --timeout", cwd: "/tmp", shell: "bash", file: "/tmp/out",
      status: "timeout", metadata: {}, time: { started: 1 } },
    { id: "sh_killed", command: "node script.js --killed", cwd: "/tmp", shell: "bash", file: "/tmp/out",
      status: "killed", metadata: {}, time: { started: 1 } },
    { id: "sh_minimal", command: "raw command", cwd: "", shell: "", file: "", status: "exited", metadata: {}, time: {} },
  ]
  try {
    await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
    await page.route("**/api/**", route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith("/background-shells") ? { data: shells } : {} }))
    await page.goto(fixture.url)
    const row = page.locator('[data-shell-id="sh_one"]'), command = row.locator(".status-process-command")
    await row.waitFor()
    assert.equal(await command.locator("strong").textContent(), "watch.ps1")
    for (const dir of ["ltr", "rtl"]) {
      await page.locator("aside").evaluate((el, dir) => { el.style.width = "220px"; el.dir = dir }, dir)
      for (const current of await page.locator(".status-process-card").all()) {
        const geometry = await current.evaluate(el => {
          const field = el.querySelector(".status-process-command")!, trash = el.querySelector(".window-icon-button")!
          const f = field.getBoundingClientRect(), t = trash.getBoundingClientRect()
          return { height: el.getBoundingClientRect().height, overflow: el.scrollWidth > el.clientWidth,
            siblings: field.parentElement === trash.parentElement, separate: f.right <= t.left || t.right <= f.left,
            sameLine: Math.abs((f.top + f.bottom) / 2 - (t.top + t.bottom) / 2) < 1, target: Math.min(t.width, t.height) }
        })
        assert.ok(geometry.height <= 30)
        assert.equal(geometry.overflow, false)
        assert.equal(geometry.siblings && geometry.separate && geometry.sameLine, true)
        assert.ok(geometry.target >= 24)
        const field = (await current.locator(".status-process-command").boundingBox())!
        const trash = (await current.locator(".window-icon-button").boundingBox())!
        assert.ok(dir === "ltr" ? field.x + field.width <= trash.x : trash.x + trash.width <= field.x, `trash follows logical order in ${dir}`)
      }
      for (const [id, port] of [["sh_one", "3001"], ["sh_two", "3002"]]) {
        const visible = await page.locator(`[data-shell-id="${id}"] .status-process-label`).evaluate((el, port) => {
          const nodes = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
          for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
            const start = node.textContent?.indexOf(port) ?? -1
            if (start < 0) continue
            const range = document.createRange()
            range.setStart(node, start); range.setEnd(node, start + port.length)
            const text = range.getBoundingClientRect()
            for (let parent: Element | null = node.parentElement; parent; parent = parent.parentElement) {
              if (getComputedStyle(parent).overflowX === "visible") continue
              const clip = parent.getBoundingClientRect()
              if (text.left < clip.left || text.right > clip.right || text.top < clip.top || text.bottom > clip.bottom) return false
            }
            return text.width > 0
          }
          return false
        }, port)
        assert.equal(visible, true, `${port} is visibly painted, not merely in textContent (${dir})`)
      }
    }
    await command.hover()
    const tooltip = page.getByRole("tooltip")
    await tooltip.waitFor()
    let text = await tooltip.innerText()
    for (const value of [shells[0].command, "Running", "Folder: C:\\Build Tools", "Shell: pwsh", "PID 42", "Started:"]) assert.ok(text.includes(value), text)
    assert.ok(text.indexOf("Running") < text.indexOf("Folder:"))
    assert.ok(text.indexOf("Folder:") < text.indexOf("Shell:"))
    await page.keyboard.press("Escape")
    await tooltip.waitFor({ state: "hidden" })
    await page.mouse.move(900, 650)
    await command.focus()
    await tooltip.waitFor()
    assert.ok(await command.getAttribute("aria-describedby"), "focus exposes details as an accessible description")
    const original = await command.elementHandle()
    shells = shells.map(shell => shell.id === "sh_one" ? { ...shell, status: "exited", exit: 0 } : shell)
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/background-shells")),
      page.evaluate(() => (window as any).fixture.event("shell.exited")),
    ])
    await page.waitForFunction(() => document.querySelector('[data-shell-id="sh_one"] .status-process-state')?.getAttribute("data-state") === "exited")
    assert.equal(await original!.evaluate(el => el.isConnected && el === document.activeElement), true)
    await page.keyboard.press("Escape")
    for (const [id, state, status] of [["sh_two", "exited", "Exited"], ["sh_fail", "failed", "Failed"],
      ["sh_timeout", "timeout", "Timed out"], ["sh_killed", "killed", "Stopped"]]) {
      const current = page.locator(`[data-shell-id="${id}"]`)
      assert.equal(await current.locator(".status-process-state").getAttribute("data-state"), state)
      assert.match(await current.locator(".status-process-command").getAttribute("aria-label") ?? "", new RegExp(status))
      await current.locator(".status-process-command").focus()
      await tooltip.waitFor()
      if (id === "sh_two") {
        text = await tooltip.innerText()
        assert.ok(text.includes("Exit 0"))
        assert.ok(text.includes("Ended:"))
        assert.ok(text.indexOf("Exit 0") < text.indexOf("Started:"))
        assert.ok(text.indexOf("Started:") < text.indexOf("Ended:"))
      }
      await page.keyboard.press("Escape")
    }
    await page.locator('[data-shell-id="sh_minimal"] .status-process-command').focus()
    await tooltip.waitFor()
    assert.equal(await tooltip.innerText(), "raw command\nExited")
  } finally { await page.close() }
})

test("trash confirms the right action, cancel is initially focused, and failures keep the shell", async () => {
  const page = await fixture.browser.newPage()
  let shell = { id: "sh_remove", command: "node script.js --port 3001", cwd: "/repo", shell: "bash", file: "/tmp/output",
    status: "running", metadata: {}, time: { started: 1 } }
  let deletes = 0, outputReads = 0, listReads = 0, fail = true, present = true
  let releaseDelete: (() => void) | undefined
  try {
    await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith("/background-shells")) {
        listReads++
        return route.fulfill({ json: { data: present ? [shell] : [] } })
      }
      if (url.pathname.endsWith("/output")) outputReads++
      if (route.request().method() === "DELETE") {
        deletes++
        if (fail) return route.fulfill({ status: 403, json: { error: "not owned" } })
        await new Promise<void>(resolve => { releaseDelete = resolve })
        present = false
        return route.fulfill({ status: 204 })
      }
      return route.fulfill({ json: {} })
    })
    await page.goto(fixture.url)
    const row = page.locator(".status-process-card"), dialog = page.getByRole("alertdialog")
    await row.getByRole("button", { name: "Stop and remove", exact: true }).click()
    await dialog.waitFor()
    assert.match(await dialog.innerText(), /Stop and remove background shell/)
    assert.match(await dialog.innerText(), /Stop and remove "node script.js --port 3001"\?/)
    assert.equal(await dialog.getByRole("button", { name: "Cancel", exact: true }).evaluate(el => el === document.activeElement), true)
    await page.keyboard.press("Enter")
    await dialog.waitFor({ state: "hidden" })
    assert.equal(deletes, 0)
    await page.waitForFunction(() => document.activeElement === document.querySelector(".status-process-card > .window-icon-button"))
    assert.equal(await row.locator(".window-icon-button").evaluate(el => el === document.activeElement), true, "cancel returns focus to this trash")
    await row.getByRole("button", { name: "Stop and remove", exact: true }).focus()
    await page.keyboard.press("Space")
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement === document.querySelector(".status-process-card > .window-icon-button"))
    assert.equal(await row.locator(".window-icon-button").evaluate(el => el === document.activeElement), true, "keyboard cancel restores this trash")
    await page.keyboard.press("Space")
    await dialog.getByRole("button", { name: "Stop and remove", exact: true }).click()
    await page.waitForFunction(() => document.querySelector(".status-process-card > .window-icon-button")?.getAttribute("aria-disabled") !== "true")
    assert.equal(deletes, 1)
    assert.equal(await row.count(), 1, "ownership failure preserves the entry")
    assert.equal(outputReads, 0)
    shell = { ...shell, status: "exited" }
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/background-shells")),
      page.evaluate(() => (window as any).fixture.event("shell.exited")),
    ])
    const remove = row.getByRole("button", { name: "Remove", exact: true })
    await remove.click()
    assert.match(await dialog.innerText(), /Remove background shell/)
    assert.equal((await dialog.innerText()).includes("Stop"), false)
    fail = false
    const readsBefore = listReads
    await Promise.all([
      page.waitForRequest(request => request.method() === "DELETE"),
      dialog.getByRole("button", { name: "Remove", exact: true }).click(),
    ])
    assert.equal(await remove.isDisabled(), true, "pending removal disables the trash")
    releaseDelete!()
    await row.waitFor({ state: "detached" })
    assert.equal(await page.locator('[data-status-section-trigger="background-processes"]').evaluate(el => el === document.activeElement), true, "last removal focuses the section")
    assert.ok(listReads > readsBefore, "successful removal rereads inventory")
    assert.equal(deletes, 2)
    assert.equal(outputReads, 0, "trash never opens or reads output")
    assert.equal(await page.getByRole("dialog").count(), 0)
  } finally { releaseDelete?.(); await page.close() }
})

test("a delayed passive inventory refresh retains the focused trash", async () => {
  const page = await fixture.browser.newPage()
  let hold = false, release: (() => void) | undefined
  try {
    await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
    await page.route("**/api/**", async route => {
      if (!new URL(route.request().url()).pathname.endsWith("/background-shells")) return route.fulfill({ json: {} })
      if (hold) await new Promise<void>(resolve => { release = resolve })
      return route.fulfill({ json: { data: [{ id: "sh_focus", command: "node watch.js --port 3001", status: "running",
        cwd: "/repo", shell: "bash", file: "/tmp/out", metadata: {}, time: { started: 1 } }] } })
    })
    await page.goto(fixture.url)
    const trash = page.locator(".status-process-card > .window-icon-button")
    await trash.focus()
    hold = true
    await Promise.all([
      page.waitForRequest(request => new URL(request.url()).pathname.endsWith("/background-shells")),
      page.evaluate(() => (window as any).fixture.event("shell.exited")),
    ])
    await page.waitForFunction(() => document.querySelector(".status-process-card > .window-icon-button")?.getAttribute("aria-disabled") === "true"
      || document.querySelector(".status-process-card > .window-icon-button")?.hasAttribute("disabled"))
    assert.equal(await trash.evaluate(el => el === document.activeElement), true, "refresh keeps focus while the inventory is pending")
    await page.keyboard.press("Enter")
    assert.equal(await page.getByRole("alertdialog").count(), 0, "aria-disabled retains focus but blocks activation")
    release!()
    await page.waitForFunction(() => document.querySelector(".status-process-card > .window-icon-button")?.getAttribute("aria-disabled") !== "true"
      && !document.querySelector(".status-process-card > .window-icon-button")?.hasAttribute("disabled"))
    assert.equal(await trash.evaluate(el => el === document.activeElement), true)
  } finally { release?.(); await page.close() }
})

test("removing a focused shell hands focus to its neighboring trash", async () => {
  const page = await fixture.browser.newPage()
  let ids = ["sh_first", "sh_next"]
  try {
    await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
    await page.route("**/api/**", route => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith("/background-shells")) return route.fulfill({ json: { data: ids.map(id => ({
        id, command: "node watch.js --port 3001", status: "exited", exit: 0, cwd: "/repo", shell: "bash",
        file: "/tmp/out", metadata: {}, time: { started: 1 },
      })) } })
      if (route.request().method() === "DELETE") {
        ids = ids.filter(id => !url.pathname.endsWith("/" + id))
        return route.fulfill({ status: 204 })
      }
      return route.fulfill({ json: {} })
    })
    await page.goto(fixture.url)
    await page.locator('[data-shell-id="sh_first"] > .window-icon-button').focus()
    await page.keyboard.press("Enter")
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove", exact: true }).click()
    await page.locator('[data-shell-id="sh_first"]').waitFor({ state: "detached" })
    await page.waitForFunction(() => document.activeElement === document.querySelector('[data-shell-id="sh_next"] > .window-icon-button'))
  } finally { await page.close() }
})

for (const offset of [0, 220, 500]) test(`keyboard scroll keys reveal long details within the viewport (panel offset: ${offset}px)`, async () => {
  const page = await fixture.browser.newPage({ viewport: { width: 600, height: 700 } })
  try {
    await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
    await page.route("**/api/**", route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith("/background-shells")
      ? { data: [{ id: "sh_long", command: "node script.js " + "argument ".repeat(1800), status: "exited", exit: 0,
        cwd: "/repo", shell: "bash", pid: 42, file: "/tmp/out", metadata: {}, time: { started: 1, completed: 2 } }] } : {} }))
    await page.goto(fixture.url)
    await page.locator("aside").evaluate((el, offset) => { el.style.marginTop = `${offset}px` }, offset)
    const command = page.locator(".status-process-command"), tooltip = page.getByRole("tooltip")
    await command.focus()
    await tooltip.waitFor()
    assert.equal(await tooltip.evaluate(el => el.scrollHeight > el.clientHeight), true)
    await page.keyboard.press("PageDown")
    assert.ok(await tooltip.evaluate(el => el.scrollTop) > 0, "PageDown scrolls the open details")
    assert.equal(await command.evaluate(el => el === document.activeElement), true)
    await page.keyboard.press("End")
    const end = await tooltip.evaluate(el => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight,
      last: el.lastElementChild!.getBoundingClientRect().bottom, bottom: el.getBoundingClientRect().bottom,
      y: el.getBoundingClientRect().top, viewport: window.innerHeight }))
    assert.ok(Math.abs(end.top - end.max) <= 1)
    assert.ok(end.last <= end.bottom, "the final completion date is visible")
    assert.ok(end.y >= 0 && end.bottom <= end.viewport, `details fit the viewport: ${JSON.stringify(end)}`)
    assert.ok(end.last <= end.viewport, "End reveals the final completion date inside the viewport")
    await page.keyboard.press("ArrowUp")
    assert.ok(await tooltip.evaluate(el => el.scrollTop) < end.top)
    await page.keyboard.press("Home")
    assert.equal(await tooltip.evaluate(el => el.scrollTop), 0)
    await page.keyboard.press("Escape")
    await tooltip.waitFor({ state: "hidden" })
    await page.keyboard.press("Tab")
    assert.equal(await page.locator(".status-process-card > .window-icon-button").evaluate(el => el === document.activeElement), true)
  } finally { await page.close() }
})

test("Hebrew labels keep long Windows, WSL and POSIX commands on one 220px row", async () => {
  const page = await fixture.browser.newPage({ locale: "he-IL", viewport: { width: 600, height: 700 } })
  const commands = [
    'cmd.exe /c node "C:\\Build Tools\\watch.js" --port 3001 ' + "long ".repeat(60),
    "wsl.exe -e node /home/me/watch.js --port 3002 " + "long ".repeat(60),
    "bash -lc 'node script.js --port 3003 " + "long ".repeat(60) + "'",
  ]
  try {
    await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
    await page.route("**/api/**", route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith("/background-shells")
      ? { data: commands.map((command, index) => ({ id: `sh_${index}`, command, status: "running", cwd: "/repo", shell: "bash", file: "/tmp/out", metadata: {}, time: { started: 1 } })) } : {} }))
    await page.goto(fixture.url + "?locale=he")
    await page.waitForFunction(() => document.documentElement.dir === "rtl")
    await page.locator("aside").evaluate(el => { el.style.width = "220px" })
    for (const row of await page.locator(".status-process-card").all()) {
      const geometry = await row.evaluate(el => {
        const label = el.querySelector(".status-process-label")!
        return { height: el.getBoundingClientRect().height, overflow: el.scrollWidth > el.clientWidth,
          clipped: [...label.children].some(child => child.scrollWidth > child.clientWidth), direction: getComputedStyle(label).direction,
          trashLabel: el.querySelector(".window-icon-button")?.getAttribute("aria-label") }
      })
      assert.ok(geometry.height <= 30)
      assert.equal(geometry.overflow, false)
      assert.equal(geometry.clipped, true)
      assert.equal(geometry.direction, "ltr")
      assert.equal(geometry.trashLabel, "עצור והסר")
    }
    assert.equal(await page.locator(".status-process-card").count(), 3)
  } finally { await page.close() }
})

test("a confirmation keeps its captured location when the selected directory changes", async () => {
  const page = await fixture.browser.newPage()
  const deletes: string[] = []
  try {
    await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
    await page.route("**/api/**", route => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith("/background-shells")) return route.fulfill({ json: { data: [{
        id: "sh_captured", command: "node script.js --port 3001", status: "running", cwd: "/repo", shell: "bash",
        file: "/tmp/out", metadata: {}, time: { started: 1 },
      }] } })
      if (route.request().method() === "DELETE") {
        deletes.push(url.searchParams.get("location[directory]")!)
        return route.fulfill({ status: 204 })
      }
      return route.fulfill({ json: {} })
    })
    await page.goto(fixture.url)
    await page.locator(".status-process-card > .window-icon-button").click()
    await page.getByRole("alertdialog").waitFor()
    await page.evaluate(() => (window as any).fixture.selectDirectory("/other"))
    await Promise.all([
      page.waitForRequest(request => request.method() === "DELETE"),
      page.getByRole("alertdialog").getByRole("button", { name: "Stop and remove", exact: true }).click(),
    ])
    assert.deepEqual(deletes, ["/repo"])
  } finally { await page.close() }
})

test("touch tap opens output; long press exposes dismissible details without opening output", async () => {
  const context = await fixture.browser.newContext({ hasTouch: true, viewport: { width: 500, height: 700 } })
  const page = await context.newPage()
  let outputReads = 0
  const shell = { id: "sh_touch", command: "npm run dev -- --port 3001", cwd: "/repo", shell: "bash", file: "/tmp/out",
    status: "running", pid: 7, metadata: {}, time: { started: 1 } }
  try {
    await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
    await page.route("**/api/**", route => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith("/background-shells")) return route.fulfill({ json: { data: [shell] } })
      if (url.pathname.endsWith("/output")) {
        outputReads++
        return route.fulfill({ json: { data: { output: "touch output", cursor: 12, size: 12, truncated: false } } })
      }
      return route.fulfill({ json: {} })
    })
    await page.goto(fixture.url)
    const command = page.locator(".status-process-command"), tooltip = page.getByRole("tooltip")
    await command.tap()
    await page.getByRole("dialog").locator("pre").filter({ hasText: "touch output" }).waitFor()
    await page.getByRole("button", { name: "Close", exact: true }).tap()
    const readsBefore = outputReads
    await page.locator(".status-process-card > .window-icon-button").tap()
    await page.getByRole("alertdialog").waitFor()
    assert.equal(outputReads, readsBefore, "touch trash never opens output")
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).tap()
    const cdp = await context.newCDPSession(page)
    const box = (await command.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
    await tooltip.waitFor()
    // The long-press helper fires at 450 ms, later than the ordinary focus tooltip.
    await page.waitForTimeout(500)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.equal(outputReads, readsBefore)
    assert.match(await tooltip.innerText(), /PID 7/)
    await page.touchscreen.tap(450, 600)
    await tooltip.waitFor({ state: "hidden" })
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + 40 }] })
    await page.waitForTimeout(500)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    assert.equal(await tooltip.count(), 0, "touch scrolling cancels long press")
    assert.equal(outputReads, readsBefore)
  } finally { await context.close() }
})
