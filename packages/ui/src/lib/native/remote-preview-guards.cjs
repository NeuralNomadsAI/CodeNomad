// Fixed, privilege-free protection shared by both native hosts.
function installRemotePreviewGuards() {
  const privateUrl = value => /\.preview\.localhost(?::\d+)?(?:\/|$)/i.test(String(value))
  if (![location.href, globalThis.origin, document.referrer, ...Array.from(location.ancestorOrigins || [])].some(privateUrl)) return
  const prevent = Function.prototype.call.bind(Event.prototype.preventDefault)
  const stop = Function.prototype.call.bind(Event.prototype.stopImmediatePropagation)
  const lower = Function.prototype.call.bind(String.prototype.toLowerCase)
  const field = name => Function.prototype.call.bind(Object.getOwnPropertyDescriptor(KeyboardEvent.prototype, name).get)
  const key = field("key"), control = field("ctrlKey"), meta = field("metaKey")
  const denied = () => Promise.reject(new DOMException("NotAllowedError", "NotAllowedError"))
  const lock = (target, name, value) => {
    try { Object.defineProperty(target, name, { value, writable: false, configurable: false }) } catch {}
  }
  const credentials = Object.freeze({ get: denied, create: denied, store: denied, preventSilentAccess: denied })
  const clipboard = Object.freeze({ read: denied, readText: denied, write: denied, writeText: denied })
  for (const target of [navigator, Navigator.prototype]) {
    lock(target, "credentials", credentials)
    lock(target, "clipboard", clipboard)
  }
  for (const name of ["showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker", "getScreenDetails"]) {
    lock(window, name, denied)
  }
  for (const name of ["requestStorageAccess", "requestStorageAccessFor"]) {
    lock(document, name, denied)
    lock(Document.prototype, name, denied)
  }
  for (const target of [navigator, Navigator.prototype]) {
    lock(target, "share", denied)
    lock(target, "canShare", () => false)
  }
  for (const [name, value] of [["alert", () => {}], ["confirm", () => false], ["prompt", () => null], ["print", () => {}]]) {
    // Electron's fixed prompt bridge is already immutable; its host refuses remote prompts.
    try { Object.defineProperty(window, name, { value, writable: false, configurable: false }) } catch {}
  }
  for (const name of ["contextmenu", "dragstart"]) {
    window.addEventListener(name, prevent, true)
  }
  for (const name of ["copy", "cut"]) {
    window.addEventListener(name, event => { prevent(event); stop(event) }, true)
  }
  window.addEventListener("keydown", event => {
    if ((control(event) || meta(event)) && lower(key(event)) === "p") {
      prevent(event)
      stop(event)
    }
  }, true)
}
if (typeof module === "object") module.exports = installRemotePreviewGuards
else installRemotePreviewGuards()
