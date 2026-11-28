import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { chromium, type Browser } from "playwright"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "markdown-session-links",
      routes: [
        { path: "/markdown-session-links", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/markdown-session-links.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

test("session links route to the preview and the file reader", { timeout: 60_000 }, async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.waitForFunction(() => (window as any).fixture.rendered() > 0)

    // Project-file routing: each plain click opens the file reader on the resolved path.
    await page.click('#main-root a[href="./README.md"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.target()), "README.md")
    await page.click('#main-root a[href="docs/guide.md#intro"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.target()), "docs/guide.md")
    await page.click('#main-root a[href="/fixture-root/src/app.ts"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.target()), "src/app.ts")

    // A session living in a not-yet-inventoried worktree resolves against its
    // own directory, never the instance folder (the repository root).
    await page.click('#sub-root a[href="./README.md"]')
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.targetFull()),
      { path: "README.md", directory: "/fixture-root/wt-a" })

    // An independently moved child keeps its own directory, never the parent's.
    await page.click('#child-root a[href="./README.md"]')
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.targetFull()),
      { path: "README.md", directory: "/fixture-root/wt-b" })

    // Loopback routing: a plain click opens the session preview instead.
    await page.click('#main-root a[href="http://localhost:3000/x"]')
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.previews()),
      [{ sessionId: "ses_link", url: "http://localhost:3000/x" }])
    const loopbackClick = await page.evaluate(() => (window as any).fixture.clicks().at(-1))
    assert.equal(loopbackClick.href, "http://localhost:3000/x")
    assert.equal(loopbackClick.prevented, true)
    const webSurface = { kind: "web", sessionId: "ses_link" }
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.surface()), webSurface)
    assert.equal(await page.evaluate(() => (window as any).fixture.targetFull()), null,
      "opening the browser replaces the central file target")

    // Not intercepted: escapes, external URLs and modified clicks keep default behavior.
    const clicksBefore = await page.evaluate(() => (window as any).fixture.clicks().length)
    const previewsBefore = await page.evaluate(() => (window as any).fixture.previews().length)
    await page.click('#main-root a[href="../outside.md"]')
    await page.click('#main-root a[href="https://example.com/x"]')
    await page.click('#main-root a[href="./README.md"]', { modifiers: ["Control"] })
    await page.click('#main-root a[href="http://localhost:3000/x"]', { modifiers: ["Control"] })
    await page.waitForFunction(count => (window as any).fixture.clicks().length === count, clicksBefore + 4)
    assert.equal(await page.evaluate(() => (window as any).fixture.targetFull()), null)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.surface()), webSurface,
      "external and modified links preserve the foreground browser")
    assert.equal(await page.evaluate(() => (window as any).fixture.previews().length), previewsBefore)
    for (const click of await page.evaluate(() => (window as any).fixture.clicks().slice(-4))) {
      assert.equal(click.prevented, false, click.href)
    }

    // Decoration: intercepted anchors carry a hint; untouched anchors keep none.
    await page.waitForFunction(() => {
      const loop = document.querySelector('a[href="http://localhost:3000/x"]')?.getAttribute("title")
      const file = document.querySelector('a[href="./README.md"]')?.getAttribute("title")
      return Boolean(loop && file)
    })
    assert.equal(await page.evaluate(() => (window as any).fixture.title('a[href="http://localhost:3000/x"]')),
      await page.evaluate(() => (window as any).fixture.label("markdown.link.previewOpens")))
    assert.equal(await page.evaluate(() => (window as any).fixture.title('a[href="./README.md"]')),
      await page.evaluate(() => (window as any).fixture.label("markdown.link.fileOpens")))
    assert.equal(await page.evaluate(() => (window as any).fixture.title('a[href="https://example.com/x"]')), null)
  } finally {
    await page.close()
  }
  assert.deepEqual(errors, [])
})

test("on the local desktop, local links open in the preview when it shows them, else with the system", { timeout: 60_000 }, async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  // A source string: the test transform would inject helpers a page cannot resolve.
  // The stub host knows `docs` and `album.png` as folders and `.md` files as
  // text, and holds `README.md`'s answer while `holdReadme` is set.
  await page.addInitScript(`window.opened = []
    let release
    window.holdReadme = () => { window.held = new Promise(resolve => { release = resolve }) }
    window.releaseReadme = () => release?.()
    window.electronAPI = { openLocalPath: async ({ path, keep }) => {
      if (path.endsWith("/locked")) throw new Error("Access denied")
      if (path.endsWith("/gone.md")) return { result: "missing" }
      if (path.endsWith("/README.md") && keep !== "none") await window.held
      const folder = /\\/(docs|album\\.png)$/.test(path)
      if (!folder && (keep === "files" || (keep === "text" && path.endsWith(".md")))) return { result: "kept" }
      window.opened.push({ path, keep })
      return { result: "opened" }
    } }`)
  const opened = () => page.evaluate(() => (window as any).opened)
  const target = () => page.evaluate(() => (window as any).fixture.target())
  try {
    await page.goto(url)
    await page.waitForFunction(() => (window as any).fixture?.rendered() > 0)

    // Folders and files the preview cannot show open with the system.
    await page.click('#main-root a[href="./docs"]')
    await page.click('#main-root a[href="./media/clip.mp4"]')
    await page.waitForFunction(() => (window as any).opened.length === 2)
    assert.deepEqual(await opened(), [{ path: "/fixture-root/docs", keep: "text" }, { path: "/fixture-root/media/clip.mp4", keep: "text" }])
    assert.equal(await target(), null)

    // Text files and images stay in the preview, unless an image name is a folder.
    await page.click('#main-root a[href="./README.md"]')
    await page.waitForFunction(() => (window as any).fixture.target() === "README.md")
    await page.click('#main-root a[href="./shot.png"]')
    await page.waitForFunction(() => (window as any).fixture.target() === "shot.png")
    await page.click('#main-root a[href="./album.png"]')
    await page.waitForFunction(() => (window as any).opened.length === 3)
    assert.deepEqual((await opened())[2], { path: "/fixture-root/album.png", keep: "files" })

    // `file:` links, paths outside the worktree, Ctrl/⌘ and middle clicks go to the system.
    await page.click('#main-root a[href="file:///fixture-root/notes.md"]')
    await page.click('#main-root a[href="file:///C:/Users/me/bato.jpg"]')
    await page.click('#main-root a[href="../outside.md"]', { modifiers: ["Control"] })
    await page.click('#main-root a[href="./README.md"]', { modifiers: ["Control"] })
    await page.click('#main-root a[href="./docs"]', { button: "middle" })
    await page.waitForFunction(() => (window as any).opened.length === 8)
    assert.deepEqual((await opened()).slice(3), [{ path: "/fixture-root/notes.md", keep: "none" },
      { path: "C:/Users/me/bato.jpg", keep: "none" }, { path: "/fixture-root/../outside.md", keep: "none" },
      { path: "/fixture-root/README.md", keep: "none" }, { path: "/fixture-root/docs", keep: "none" }])
    assert.equal(await target(), "shot.png")

    // A session the inventory does not know opens its own directory's paths.
    await page.click('#sub-root a[href="./docs"]')
    await page.waitForFunction(() => (window as any).opened.length === 9)
    assert.deepEqual((await opened())[8], { path: "/fixture-root/wt-a/docs", keep: "text" })

    // A text file's late fallback never replaces a surface opened meanwhile.
    await page.evaluate(() => (window as any).holdReadme())
    await page.click('#main-root a[href="./README.md"]')
    await page.click('#main-root a[href="http://localhost:3000/x"]')
    await page.waitForFunction(() => (window as any).fixture.surface().kind === "web")
    await page.evaluate(() => (window as any).releaseReadme())
    await page.waitForTimeout(200)
    assert.equal((await page.evaluate(() => (window as any).fixture.surface())).kind, "web")

    // A worktree served from another namespace (WSL) maps its service paths onto the host directory.
    const wsl = { slug: "root", directory: "C:/repo", serviceDirectory: "/mnt/c/repo", base: "/mnt/c/repo" }
    assert.deepEqual(await page.evaluate(base => ["/mnt/c/repo/clip.mp4", "./clip.mp4", "file:C:/x/y.txt", "file:///mnt/c/repo/notes.md", "/mnt/c/repo"]
      .map(href => (window as any).fixture.localLinkPath(href, base)), wsl), ["C:/repo/clip.mp4", "C:/repo/clip.mp4", "C:/x/y.txt", "C:/repo/notes.md", "C:/repo"])
    // Host-side paths stay worktree paths, so their text files keep the preview; `./` names the directory.
    assert.deepEqual(await page.evaluate(base => ["C:/repo/README.md", "/mnt/c/repo/README.md"]
      .map(href => (window as any).fixture.worktreeLinkPath(href, base)), wsl), ["README.md", "README.md"])
    assert.equal(await page.evaluate(base => (window as any).fixture.localLinkPath("./", base), wsl), "C:/repo/.")
    // Failures and missing targets explain themselves.
    await page.click('#main-root a[href="./locked"]')
    await page.click('#main-root a[href="./gone.md"]')
    await page.waitForFunction(() => (window as any).fixture.errorToasts().length === 2)
    const toasts: string[] = await page.evaluate(() => (window as any).fixture.errorToasts())
    assert.ok(toasts.some(message => /Access denied/.test(message)), toasts.join(" | "))
    assert.ok(toasts.includes("Not found: /fixture-root/gone.md"), toasts.join(" | "))

    // Titles name the target and what a plain click does.
    const label = (key: string) => page.evaluate(key => (window as any).fixture.label(key), key)
    assert.equal(await page.getAttribute('#main-root a[href="file:///C:/Users/me/bato.jpg"]', "title"),
      `C:\\Users\\me\\bato.jpg\n${await label("markdown.link.systemOpens")}`)
    assert.equal(await page.getAttribute('#main-root a[href="./docs"]', "title"),
      `/fixture-root/docs\n${await label("markdown.link.pathOpens")}`)
  } finally {
    await page.close()
  }
  assert.deepEqual(errors, [])
})
test("a populated but unmatched inventory never captures session links", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(`${url}?inventory=1`)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.waitForFunction(() => (window as any).fixture.rendered() > 0)

    // The root inventory entry exists but holds neither session's directory.
    await page.click('#sub-root a[href="./README.md"]')
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.targetFull()),
      { path: "README.md", directory: "/fixture-root/wt-a" })
    await page.click('#child-root a[href="./README.md"]')
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.targetFull()),
      { path: "README.md", directory: "/fixture-root/wt-b" })

    // A session the inventory does contain still resolves through its entry.
    await page.click('#main-root a[href="./README.md"]')
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.targetFull()),
      { path: "README.md", directory: "/fixture-root" })
  } finally {
    await page.close()
  }
  assert.deepEqual(errors, [])
})

test("session links retain backend availability, preview scope and revocation fences", { timeout: 60_000 }, async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.waitForFunction(() => Boolean(document.querySelector('#remote-A a[href="http://localhost:3000/x"]')?.getAttribute("title")))
    assert.equal(await page.getAttribute('#remote-B a[href="http://localhost:3000/x"]', "title"), null)
    await page.click('#remote-B a[href="http://localhost:3000/x"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.clicks().at(-1).prevented), false)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.remoteCalls()), [])

    await page.click('#main-root a[href="http://localhost:3000/x"]')
    await page.click('#remote-A a[href="http://localhost:3000/x"]')
    await page.waitForFunction(() => (window as any).fixture.previewMode("A") === "preview")
    assert.equal(await page.evaluate(() => (window as any).fixture.previewMode("local")), "preview")
    await page.click('#remote-A a[href="./README.md"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.remoteTarget("A")), "README.md")
    assert.equal(await page.evaluate(() => (window as any).fixture.target()), null)
    assert.equal(await page.evaluate(() => (window as any).fixture.previewMode("A")), "chat")
    assert.equal(await page.evaluate(() => (window as any).fixture.previewMode("local")), "preview")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.remoteCalls()), ["A"])

    await page.evaluate(() => {
      const f = (window as any).fixture
      f.selectRemoteSession("A")
      f.holdPreview()
    })
    await page.click('#remote-A a[href="http://localhost:3000/next"]')
    await page.waitForFunction(() => (window as any).fixture.pending())
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.remoteCalls()), ["A", "A"])
    await page.evaluate(() => { (window as any).fixture.detach("A"); (window as any).fixture.rejectPending() })
    await page.waitForFunction(() => !document.querySelector('#remote-A a[href="./README.md"]')?.hasAttribute("title"))
    await page.click('#remote-A a[href="./README.md"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.clicks().at(-1).prevented), false)
    assert.equal(await page.evaluate(() => (window as any).fixture.isRemoteSessionSelected("A")), true,
      "the stale failure is suppressed even while A's session remains selected")
    assert.equal(await page.evaluate(() => (window as any).fixture.alert()), null)
    assert.equal(await page.evaluate(() => (window as any).fixture.previewMode("local")), "preview")
  } finally {
    await page.close()
  }
  assert.deepEqual(errors, [])
})
