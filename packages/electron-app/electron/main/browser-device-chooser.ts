import { BrowserWindow, webContents, type Session, type WebContents } from "electron"
import { nativeMenuLabels } from "./view-menu"
import { permissionOrigin } from "./browser-permission-policy"
import { showBrowserDialog } from "./browser-dialog"

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
    if (!contents || !origin || !devices.length) { callback(""); return }
    const owner = BrowserWindow.fromWebContents(contents) ?? BrowserWindow.fromWebContents(contents.hostWebContents ?? contents)
    const l = nativeMenuLabels(owner)
    let chosen = ""
    try {
      const result = owner ? await showBrowserDialog(owner, origin,
        l.browserPermission.replace("{permission}", kind).replace("{origin}", origin), { choices: devices.map(device => device.label) }) : null
      const selected = result !== null && /^(0|[1-9]\d*)$/.test(result) ? devices[Number(result)] : undefined
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
