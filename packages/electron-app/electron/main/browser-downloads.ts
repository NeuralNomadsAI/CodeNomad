import { randomUUID } from "node:crypto"
import { closeSync, openSync, statSync, unlinkSync } from "node:fs"
import { basename, join } from "node:path"
import type { Session } from "electron"
import { isPrivatePreviewUrl, restrictedBrowserGuest } from "./browser-presentation"

export function reserveBrowserDownload(directory: string, suggested: string): string {
  if (!statSync(directory).isDirectory()) throw new Error("Downloads directory unavailable")
  const source = basename(suggested.replaceAll("\\", "/")).replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "")
  let name = ""
  for (const character of source) {
    if (Buffer.byteLength(name + character) > 180) break
    name += character
  }
  name = name.replace(/^[ .]+|[ .]+$/g, "") || "download"
  const path = join(directory, `${randomUUID()}-${name}`)
  closeSync(openSync(path, "wx"))
  return path
}

export function configureBrowserDownloads(target: Session, directory: string): void {
  target.on("will-download", (event, item, contents) => {
    let path: string | undefined
    try {
      const url = new URL(item.getURL())
      if (!contents || contents.isDestroyed() || restrictedBrowserGuest(contents) || isPrivatePreviewUrl(item.getURL()) || !["http:", "https:", "blob:", "data:"].includes(url.protocol)
        || url.username || url.password) throw new Error("Blocked browser download")
      path = reserveBrowserDownload(directory, item.getFilename())
      item.setSavePath(path)
      const reserved = path
      item.once("done", (_event, state) => {
        if (state !== "completed") {
          try { if (statSync(reserved).size === 0) unlinkSync(reserved) } catch {}
        }
      })
    } catch (error) {
      event.preventDefault()
      if (path) { try { unlinkSync(path) } catch {} }
      console.warn("[browser-download]", error)
    }
  })
}
