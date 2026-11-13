// Fixed, privilege-free protection shared by both native hosts.
function installRemotePreviewGuards() {
  const privateUrl = value => /\.preview\.localhost(?::\d+)?(?:\/|$)/i.test(String(value))
  if (![location.href, globalThis.origin, document.referrer].some(privateUrl)) return
  const prevent = Function.prototype.call.bind(Event.prototype.preventDefault)
  const stop = Function.prototype.call.bind(Event.prototype.stopImmediatePropagation)
  const lower = Function.prototype.call.bind(String.prototype.toLowerCase)
  const field = name => Function.prototype.call.bind(Object.getOwnPropertyDescriptor(KeyboardEvent.prototype, name).get)
  const key = field("key"), control = field("ctrlKey"), meta = field("metaKey")
  const denied = () => Promise.reject(new DOMException("NotAllowedError", "NotAllowedError"))
  try { Object.defineProperty(navigator, "credentials", { value: Object.freeze({ get: denied, create: denied, store: denied, preventSilentAccess: denied }), configurable: false }) } catch {}
  for (const name of ["showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker", "getScreenDetails"]) {
    try { Object.defineProperty(window, name, { value: denied, configurable: false }) } catch {}
  }
  for (const name of ["requestStorageAccess", "requestStorageAccessFor"]) {
    try { Object.defineProperty(document, name, { value: denied, configurable: false }) } catch {}
  }
  try { Object.defineProperty(navigator, "share", { value: denied, configurable: false }) } catch {}
  try { Object.defineProperty(navigator, "canShare", { value: () => false, configurable: false }) } catch {}
  for (const [name, value] of [["alert", () => {}], ["confirm", () => false], ["prompt", () => null], ["print", () => {}]]) {
    // Electron's fixed prompt bridge is already immutable; its host refuses remote prompts.
    try { Object.defineProperty(window, name, { value, writable: false, configurable: false }) } catch {}
  }
  for (const name of ["contextmenu", "dragstart"]) {
    window.addEventListener(name, prevent, true)
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
