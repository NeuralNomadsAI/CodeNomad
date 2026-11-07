import { BrowserWindow, desktopCapturer, dialog, webContents, type Session, type Streams } from "electron"
import { permissionOrigin } from "./browser-permission-policy"
import { nativeMenuLabels } from "./view-menu"

export function configureBrowserDisplayChooser(target: Session): void {
  target.setDisplayMediaRequestHandler((request, callback) => {
    const frame = request.frame
    const origin = permissionOrigin(request.securityOrigin)
    if (!frame || !origin || !request.userGesture || !request.videoRequested) { callback(null); return }
    void (async () => {
      let streams: Streams | null = null
      try {
        const contents = webContents.fromFrame(frame)
        if (!contents) throw new Error("Expired browser frame")
        const owner = BrowserWindow.fromWebContents(contents) ?? BrowserWindow.fromWebContents(contents.hostWebContents ?? contents)
        const l = nativeMenuLabels(owner)
        const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } })
        // ponytail: native message-box chooser is bounded to 20 sources; a
        // scrollable chooser is needed for desktops with larger source lists.
        if (sources.length && sources.length <= 20 && !frame.detached && permissionOrigin(frame.origin) === origin) {
          const options = { type: "question" as const, title: origin,
            message: l.browserPermission.replace("{permission}", "display-capture").replace("{origin}", origin),
            buttons: [l.browserDeny, ...sources.map(source => source.name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 160).replaceAll("&", "&&"))],
            defaultId: 0, cancelId: 0, noLink: true }
          const result = await (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options))
          const selected = sources[result.response - 1]
          if (selected && !frame.detached && permissionOrigin(frame.origin) === origin) streams = { video: selected }
        }
      } catch (error) { console.warn("[browser-display] request unavailable", error) }
      callback(streams)
    })()
  }, { useSystemPicker: true })
}
