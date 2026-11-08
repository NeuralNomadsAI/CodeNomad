import { desktopCapturer, webContents, type Session, type Streams } from "electron"
import { permissionOrigin } from "./browser-permission-policy"
import { nativeMenuLabels } from "./view-menu"
import { showBrowserDialog } from "./browser-dialog"
import { browserGuestLifetime } from "./browser-guest-lifetime"

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
        const owner = browserGuestLifetime.owner(contents)
        const revision = browserGuestLifetime.revision(contents)
        const current = () => browserGuestLifetime.owner(contents) === owner && browserGuestLifetime.revision(contents) === revision
          && !frame.detached && permissionOrigin(frame.origin) === origin
        const l = nativeMenuLabels(owner ?? null)
        const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } })
        if (owner && sources.length && current()) {
          const result = await showBrowserDialog(owner, origin,
            l.browserPermission.replace("{permission}", "display-capture").replace("{origin}", origin),
            { choices: sources.map(source => source.name) }, contents, current)
          const selected = result !== null && /^(0|[1-9]\d*)$/.test(result) ? sources[Number(result)] : undefined
          if (selected && current()) streams = { video: selected }
        }
      } catch (error) { console.warn("[browser-display] request unavailable", error) }
      callback(streams)
    })()
  }, { useSystemPicker: true })
}
