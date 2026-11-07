import { BrowserWindow, dialog, webContents, type Session, type WebContents } from "electron"
import { nativeMenuLabels } from "./view-menu"
import { permissionOrigin } from "./browser-permission-policy"

export function configureBrowserDeviceChoosers(target: Session): void {
  const grants = new Set<string>()
  const key = (kind: string, origin: string, id: string) => JSON.stringify([kind, origin, id])
  const id = (device: Electron.HIDDevice | Electron.USBDevice | Electron.SerialPort) =>
    "deviceId" in device ? device.deviceId : device.portId
  target.setDevicePermissionHandler(details => {
    const origin = permissionOrigin(details.origin)
    return Boolean(origin && grants.has(key(details.deviceType, origin, id(details.device))))
  })

  async function choose(kind: string, devices: { id: string; label: string }[], contents: WebContents | undefined,
    origin: string | undefined, stillOwned: () => boolean, callback: (id: string) => void) {
    // ponytail: native message-box choices cap at 20; use a scrollable chooser
    // when larger device inventories need selection.
    if (!contents || !origin || !devices.length || devices.length > 20) { callback(""); return }
    const owner = BrowserWindow.fromWebContents(contents) ?? BrowserWindow.fromWebContents(contents.hostWebContents ?? contents)
    const l = nativeMenuLabels(owner)
    const options = { type: "question" as const, title: origin,
      message: l.browserPermission.replace("{permission}", kind).replace("{origin}", origin),
      buttons: [l.browserDeny, ...devices.map(device => device.label.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 160).replaceAll("&", "&&"))],
      defaultId: 0, cancelId: 0, noLink: true }
    let chosen = ""
    try {
      const result = await (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options))
      const selected = devices[result.response - 1]
      if (selected && !contents.isDestroyed() && stillOwned()) {
        grants.add(key(kind, origin, selected.id))
        chosen = selected.id
      }
    } catch {}
    callback(chosen)
  }
  target.on("select-usb-device", (event, details, callback) => {
    event.preventDefault()
    const frame = details.frame
    const origin = permissionOrigin(frame?.origin)
    void choose("usb", details.deviceList.map(device => ({ id: device.deviceId, label: device.productName || device.deviceId })),
      frame ? webContents.fromFrame(frame) : undefined, origin,
      () => Boolean(frame && !frame.detached && permissionOrigin(frame.origin) === origin), callback)
  })
  target.on("select-hid-device", (event, details, callback) => {
    event.preventDefault()
    const frame = details.frame
    const origin = permissionOrigin(frame?.origin)
    void choose("hid", details.deviceList.map(device => ({ id: device.deviceId, label: device.name || device.deviceId })),
      frame ? webContents.fromFrame(frame) : undefined, origin,
      () => Boolean(frame && !frame.detached && permissionOrigin(frame.origin) === origin), callback)
  })
  target.on("select-serial-port", (event, ports, contents, callback) => {
    event.preventDefault()
    // This event exposes a tab. Its origin is usable only when every possible
    // requesting frame has the same, non-opaque origin.
    const frame = contents.mainFrame
    const mainOrigin = permissionOrigin(frame.origin)
    const unambiguous = () => Boolean(mainOrigin && frame.framesInSubtree.every(child => permissionOrigin(child.origin) === mainOrigin))
    const origin = unambiguous() ? mainOrigin : undefined
    void choose("serial", ports.map(port => ({ id: port.portId, label: port.displayName || port.portName })), contents,
      origin, () => !frame.detached && unambiguous() && permissionOrigin(frame.origin) === origin, callback)
  })
}
