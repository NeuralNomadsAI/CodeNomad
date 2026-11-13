import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { registerHooks } from "node:module"
import test from "node:test"

const source = "http://aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.preview.localhost:9999/previews/remote/start"
let menu: any[] = [], copied = "", shown: any
const electron = {
  BrowserWindow: class { static fromWebContents() { return null } },
  clipboard: { writeText(value: string) { copied = value } },
  dialog: { showMessageBoxSync(_owner: unknown, value: unknown) { shown = value; return 0 } },
  Menu: { buildFromTemplate(items: any[]) { menu = items; return { popup() {} } } },
  ipcMain: { on() {} },
}
;(globalThis as any).__guestElectron = electron
const hook = registerHooks({
  resolve(specifier, context, next) {
    return specifier === "electron" ? { url: "test:browser-guests-electron", shortCircuit: true } : next(specifier, context)
  },
  load(url, context, next) {
    return url === "test:browser-guests-electron" ? { format: "module", source:
      "const e=globalThis.__guestElectron;export const {BrowserWindow,clipboard,dialog,Menu,ipcMain}=e;", shortCircuit: true } : next(url, context)
  },
})
const { protectBrowserGuest } = await import("./browser-guests")
const { setBrowserLogicalAddress } = await import("./browser-presentation")
hook.deregister()

function fixture(url: string) {
  menu = []; copied = ""; shown = undefined
  const owner: any = new EventEmitter()
  owner.isDestroyed = () => false
  owner.webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  const guest: any = Object.assign(new EventEmitter(), {
    getURL: () => url, isDestroyed: () => false, close() {}, copy() {},
    setWindowOpenHandler(handler: unknown) { guest.open = handler }, session: {},
  })
  protectBrowserGuest(owner, guest)
  return { owner, guest }
}

test("production guest protection keeps capability addresses out of native menus and dialogs", () => {
  const { guest } = fixture(source)
  guest.emit("context-menu", {}, { linkURL: source.replace("/start", "/next"), isEditable: false, mediaType: "none" })
  menu.find(item => item.click && /copy.*link/i.test(item.label))?.click()
  assert.equal(copied.includes(".preview.localhost"), false)
  guest.emit("will-prevent-unload", { preventDefault() {} })
  assert.equal(JSON.stringify(shown).includes(".preview.localhost"), false)
  setBrowserLogicalAddress(guest, "http://remote-app.test/start")
  guest.emit("will-prevent-unload", { preventDefault() {} })
  assert.equal(shown.title, "http://remote-app.test")
  assert.deepEqual(guest.open({ url: source.replace("/start", "/popup") }), { action: "deny" })
})

test("ordinary local guests retain their copy-link action", () => {
  const { guest } = fixture("https://example.com/start")
  guest.emit("context-menu", {}, { linkURL: "https://example.com/next", isEditable: false, mediaType: "none" })
  menu.find(item => item.click && /copy.*link/i.test(item.label))!.click()
  assert.equal(copied, "https://example.com/next")
})
