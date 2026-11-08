import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import {
  decideRemoteViewNavigation,
  isRemoteHelpUrl,
  remoteViewEntry,
  RemoteViewRegistry,
  validateRemoteViewBounds,
  validateRemoteViewOpen,
} from "./remote-view"
import { remoteCookieDetails, validateRemoteCookie } from "./remote-cookie"

const origin = "https://box.example"
const entry = `${origin}/?codenomadEmbed=project&folder=%2Fsrv%2Fapp`

test("remote views stay on their server; a bare root returns to the project entry", () => {
  assert.equal(decideRemoteViewNavigation(`${origin}/?codenomadEmbed=project`, origin), "allow")
  assert.equal(decideRemoteViewNavigation(`${origin}/login`, origin), "allow")
  assert.equal(decideRemoteViewNavigation(`${origin}/`, origin), "entry")
  assert.equal(decideRemoteViewNavigation(`${origin}/#x`, origin), "entry")
  assert.equal(decideRemoteViewNavigation("about:blank", origin), "allow")
  assert.equal(decideRemoteViewNavigation("https://evil.example/", origin), "deny")
  assert.equal(decideRemoteViewNavigation("http://box.example/", origin), "deny")
  assert.equal(decideRemoteViewNavigation("file:///C:/Windows", origin), "deny")
  assert.equal(decideRemoteViewNavigation("javascript:alert(1)", origin), "deny")
  assert.equal(decideRemoteViewNavigation("https://neuralnomadsai.github.io/CodeNomad/en/", origin), "help")
  assert.equal(isRemoteHelpUrl("https://neuralnomadsai.github.io/Other/"), false)
  assert.equal(isRemoteHelpUrl("https://user@neuralnomadsai.github.io/CodeNomad/"), false)
  assert.equal(isRemoteHelpUrl("https://neuralnomadsai.github.io/CodeNomad/%2e%2e/"), false)
  assert.equal(remoteViewEntry(entry, origin), entry)
  assert.equal(remoteViewEntry(`${origin}/remote-pair#code`, origin), `${origin}/?codenomadEmbed=project`)
})

test("open requests carry a view id, integer bounds and an address on the server's origin", () => {
  const request = { viewId: "tab-1", profileId: "box", baseUrl: origin, url: entry, bounds: { x: 0, y: 40, width: 800, height: 600 } }
  assert.deepEqual(validateRemoteViewOpen(request), { ...request, url: new URL(entry).toString() })
  assert.throws(() => validateRemoteViewOpen({ ...request, url: "https://evil.example/" }), /origin/)
  assert.throws(() => validateRemoteViewOpen({ ...request, url: "file:///etc/passwd" }), /HTTP/)
  assert.throws(() => validateRemoteViewOpen({ ...request, viewId: "../x" }), /view id/)
  assert.throws(() => validateRemoteViewBounds({ x: 0.5, y: 0, width: 10, height: 10 }), /bounds/)
  assert.throws(() => validateRemoteViewBounds({ x: 0, y: 0, width: 0, height: 10 }), /bounds/)
})

class FakeContents extends EventEmitter {
  cookieWrites: unknown[] = []
  setCookie: (cookie: unknown) => Promise<void> = async (cookie) => { this.cookieWrites.push(cookie) }
  session = { cookies: { set: (cookie: unknown) => this.setCookie(cookie) } }
  url = ""
  closed = false
  loaded: string[] = []
  mainFrame = { url: "" }
  windowOpenHandler?: (details: { url: string }) => { action: string }
  isDestroyed() { return this.closed }
  getURL() { return this.url }
  async loadURL(url: string) { this.loaded.push(url); this.url = url; this.mainFrame.url = url }
  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) { this.windowOpenHandler = handler }
  close() { this.closed = true }
}

function harness(configureContents: (contents: FakeContents, profileId: string) => void = () => {}) {
  const views: Array<{ webContents: FakeContents; bounds?: unknown; visible: boolean; setBounds(b: unknown): void; setVisible(v: boolean): void }> = []
  const help: string[] = []
  const sent: unknown[][] = []
  const children = new Set<unknown>()
  const owner = {
    id: 7,
    isDestroyed: () => false,
    webContents: { send: (...args: unknown[]) => sent.push(args), getZoomFactor: () => 1.25 },
    contentView: { addChildView: (view: unknown) => children.add(view), removeChildView: (view: unknown) => children.delete(view) },
  }
  const registry = new RemoteViewRegistry({
    createView: (profileId) => {
      const view = { webContents: new FakeContents(), visible: true, setBounds(b: unknown) { this.bounds = b }, setVisible(v: boolean) { this.visible = v } } as (typeof views)[number]
      configureContents(view.webContents, profileId)
      views.push(view)
      return view as never
    },
    openHelp: (url) => help.push(url),
    zoomFactor: (window) => (window as unknown as typeof owner).webContents.getZoomFactor(),
  })
  return { registry, owner: owner as never, views, help, sent, children }
}

test("a view is placed in the owner's zoomed coordinates, guarded and closed with its owner", async () => {
  const h = harness()
  h.registry.open(h.owner, { viewId: "tab-1", profileId: "box", baseUrl: origin, url: `${origin}/remote-pair#code`, bounds: { x: 0, y: 40, width: 800, height: 600 } })
  const view = h.views[0]!
  const contents = view.webContents
  assert.equal(h.children.size, 1)
  assert.deepEqual(view.bounds, { x: 0, y: 50, width: 1000, height: 750 })
  assert.deepEqual(contents.loaded, [`${origin}/remote-pair#code`])

  const navigate = (url: string) => {
    let prevented = false
    contents.emit("will-navigate", { preventDefault: () => { prevented = true } }, url)
    return prevented
  }
  assert.equal(navigate("https://evil.example/"), true)
  assert.equal(navigate(`${origin}/login`), false)
  // Pairing and login end on the bare root: the view returns to the single-project entry.
  assert.equal(navigate(`${origin}/`), true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(contents.loaded.at(-1), `${origin}/?codenomadEmbed=project`)
  assert.equal(navigate("https://neuralnomadsai.github.io/CodeNomad/en/"), true)
  assert.deepEqual(h.help, ["https://neuralnomadsai.github.io/CodeNomad/en/"])
  assert.deepEqual(contents.windowOpenHandler!({ url: "https://evil.example/" }), { action: "deny" })

  let attachPrevented = false
  contents.emit("will-attach-webview", { preventDefault: () => { attachPrevented = true } })
  assert.equal(attachPrevented, true)

  contents.url = entry
  contents.emit("page-title-updated", {}, "App")
  assert.deepEqual(h.sent, [["remote-view:updated", { viewId: "tab-1", url: entry, title: "App" }]])
  // Once it shows a project, that project is where the view returns.
  navigate(`${origin}/`)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(contents.loaded.at(-1), entry)

  h.registry.update(h.owner, { viewId: "tab-1", visible: false })
  assert.equal(view.visible, false)
  assert.throws(() => h.registry.update(h.owner, { viewId: "other", visible: false }), /no longer available/)
  h.registry.closeOwner(h.owner)
  assert.equal(contents.closed, true)
  assert.equal(h.children.size, 0)
})

test("only the committed main frame of a view on its server's origin is a remote view sender", async () => {
  const h = harness()
  h.registry.open(h.owner, { viewId: "tab-1", profileId: "box", baseUrl: origin, url: entry, bounds: { x: 0, y: 0, width: 10, height: 10 } })
  const contents = h.views[0]!.webContents
  await Promise.resolve()
  assert.ok(h.registry.resolve({ sender: contents as never, senderFrame: contents.mainFrame as never }))
  assert.equal(h.registry.resolve({ sender: contents as never, senderFrame: { url: entry } as never }), undefined)
  assert.equal(h.registry.resolve({ sender: new FakeContents() as never, senderFrame: contents.mainFrame as never }), undefined)
  contents.mainFrame.url = "https://evil.example/"
  assert.equal(h.registry.resolve({ sender: contents as never, senderFrame: contents.mainFrame as never }), undefined)
  h.registry.close(h.owner, "tab-1")
  assert.equal(contents.closed, true)
})

const cookie = { origin, name: "__Host-session", value: "abc_123", path: "/", secure: true, httpOnly: true, sameSite: "lax" as const, expires: 2000000000 }

test("remote cookies are origin-bound and reject unsafe attributes", () => {
  const request = { viewId: "tab-1", profileId: "box", baseUrl: origin, url: entry, bounds: { x: 0, y: 0, width: 10, height: 10 }, cookie }
  assert.deepEqual(validateRemoteViewOpen(request).cookie, cookie)
  assert.deepEqual(remoteCookieDetails(cookie), { url: origin, name: cookie.name, value: cookie.value, path: "/", secure: true, httpOnly: true, sameSite: "lax", expirationDate: 2000000000 })
  for (const change of [
    { origin: "https://evil.example" }, { origin: `${origin}/` }, { name: "bad;name" },
    { value: "x\r\nSet-Cookie: y" }, { value: "x;y" }, { path: "/;Domain=evil.example" },
    { path: "relative" }, { path: "/other" }, { secure: false }, { httpOnly: "true" },
    { sameSite: "invalid" }, { domain: "evil.example" }, { expires: -1 }, { expires: NaN }, { expires: Infinity },
    { expires: 0.5 }, { expires: 253402300800 },
  ]) assert.throws(() => validateRemoteViewOpen({ ...request, cookie: { ...cookie, ...change } }), /cookie/)
  assert.throws(() => validateRemoteCookie({ ...cookie, origin: "http://box.example" }, "http://box.example"), /cookie/)
  assert.throws(() => validateRemoteCookie({ ...cookie, name: "session", secure: false, sameSite: "none" }, origin), /cookie/)
  assert.equal(remoteCookieDetails({ ...cookie, sameSite: "none", expires: undefined }).sameSite, "no_restriction")
  assert.equal(remoteCookieDetails({ ...cookie, expires: undefined }).expirationDate, undefined)
})

test("the view's own session receives its cookie before any navigation", async () => {
  // Hold the session write while opening: no request may reach the remote yet.
  let release!: () => void
  const h = harness((contents, profileId) => {
    assert.equal(profileId, "box")
    contents.setCookie = async (value) => {
      contents.cookieWrites.push(value)
      await new Promise<void>((resolve) => { release = resolve })
    }
  })
  const opening = h.registry.open(h.owner, { viewId: "tab-1", profileId: "box", baseUrl: origin, url: entry, bounds: { x: 0, y: 0, width: 10, height: 10 }, cookie })
  const contents = h.views[0]!.webContents
  assert.deepEqual(contents.cookieWrites, [remoteCookieDetails(cookie)])
  assert.deepEqual(contents.loaded, [])
  release()
  await opening
  assert.deepEqual(contents.loaded, [entry])
})

test("cookie failure closes the view and never loads an unauthenticated page", async () => {
  const h = harness((contents) => {
    contents.setCookie = async () => { throw new Error("cookie rejected") }
  })
  await assert.rejects(h.registry.open(h.owner, { viewId: "tab-1", profileId: "box", baseUrl: origin, url: entry, bounds: { x: 0, y: 0, width: 10, height: 10 }, cookie }), /cookie rejected/)
  assert.equal(h.views[0]!.webContents.closed, true)
  assert.deepEqual(h.views[0]!.webContents.loaded, [])
  assert.equal(h.children.size, 0)
})

test("closing a view while its cookie is being installed prevents late navigation", async () => {
  let release!: () => void
  const h = harness((contents) => {
    contents.setCookie = () => new Promise<void>((resolve) => { release = resolve })
  })
  const opening = h.registry.open(h.owner, { viewId: "tab-1", profileId: "box", baseUrl: origin, url: entry, bounds: { x: 0, y: 0, width: 10, height: 10 }, cookie })
  h.registry.close(h.owner, "tab-1")
  release()
  await opening
  assert.deepEqual(h.views[0]!.webContents.loaded, [])
})
