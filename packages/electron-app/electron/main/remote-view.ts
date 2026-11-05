import type { BrowserWindow, IpcMainInvokeEvent, WebContents, WebContentsView } from "electron"
import { requireHttpUrl } from "./navigation-security"

/**
 * Remote CodeNomad project tabs: a WebContentsView per tab, inside the local
 * window that owns it, on the storage of that server's remote window. The view
 * has the remote preload, and of native IPC only notifications.
 */
export interface RemoteViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface RemoteViewOpenRequest {
  viewId: string
  profileId: string
  baseUrl: string
  url: string
  bounds: RemoteViewBounds
}

export interface RemoteViewUpdateRequest {
  viewId: string
  bounds?: RemoteViewBounds
  visible: boolean
}

export type RemoteViewNavigation = "allow" | "entry" | "help" | "deny"

const VIEW_ID = /^[A-Za-z0-9_-]{1,128}$/
const MAX_COORDINATE = 100_000

export function validateRemoteViewId(value: unknown): string {
  if (typeof value !== "string" || !VIEW_ID.test(value)) throw new Error("Invalid remote view id")
  return value
}

export function validateRemoteViewBounds(value: unknown): RemoteViewBounds {
  const bounds = value as Partial<RemoteViewBounds> | null
  const valid = (number: unknown, min: number) => typeof number === "number" && Number.isInteger(number) && number >= min && number <= MAX_COORDINATE
  if (!bounds || !valid(bounds.x, 0) || !valid(bounds.y, 0) || !valid(bounds.width, 1) || !valid(bounds.height, 1)) {
    throw new Error("Invalid remote view bounds")
  }
  return { x: bounds.x!, y: bounds.y!, width: bounds.width!, height: bounds.height! }
}

export function validateRemoteViewOpen(value: unknown): RemoteViewOpenRequest {
  const request = value as Partial<RemoteViewOpenRequest> | null
  if (!request || typeof request.profileId !== "string" || !request.profileId.trim() || typeof request.baseUrl !== "string" || typeof request.url !== "string") {
    throw new Error("Invalid remote view request")
  }
  const base = requireHttpUrl(request.baseUrl, "baseUrl")
  const target = requireHttpUrl(request.url, "url")
  if (target.origin !== base.origin) throw new Error("Remote view must open on its server's origin")
  return {
    viewId: validateRemoteViewId(request.viewId),
    profileId: request.profileId,
    baseUrl: base.origin,
    url: target.toString(),
    bounds: validateRemoteViewBounds(request.bounds),
  }
}

/** The public help site is the only page a remote page may hand to the system browser. */
export function isRemoteHelpUrl(value: string): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  return url.protocol === "https:" && url.hostname === "neuralnomadsai.github.io" && (url.port === "" || url.port === "443")
    && !url.username && !url.password && url.pathname.startsWith("/CodeNomad/") && !url.pathname.includes("%")
}

/**
 * A view stays on its server's origin. Login and pairing pages end on the bare
 * root: that returns to the tab's single-project entry instead.
 */
export function decideRemoteViewNavigation(value: string, origin: string): RemoteViewNavigation {
  let url: URL
  try { url = new URL(value) } catch { return "deny" }
  if (url.href === "about:blank") return "allow"
  if ((url.protocol === "http:" || url.protocol === "https:") && url.origin === origin) {
    return url.pathname === "/" && url.search === "" ? "entry" : "allow"
  }
  return isRemoteHelpUrl(value) ? "help" : "deny"
}

/** The single-project address a view returns to: its own when it has one, else the server's bare entry. */
export function remoteViewEntry(url: string, origin: string): string {
  try {
    if (new URL(url).searchParams.get("codenomadEmbed") === "project") return url
  } catch {}
  return `${origin}/?codenomadEmbed=project`
}

interface RemoteViewRecord {
  view: WebContentsView
  owner: BrowserWindow
  origin: string
  /** The single-project address the view returns to; follows the project it shows. */
  entryUrl: string
}

export interface RemoteViewDependencies {
  createView(profileId: string): WebContentsView
  openHelp(url: string): void
  /** The owner's page zoom: views are placed in window coordinates. */
  zoomFactor(owner: BrowserWindow): number
}

export class RemoteViewRegistry {
  private readonly records = new Map<string, RemoteViewRecord>()

  constructor(private readonly dependencies: RemoteViewDependencies) {}

  private key(owner: BrowserWindow, viewId: string) {
    return `${owner.id}:${viewId}`
  }

  /** The view whose committed main frame sent this IPC, on its server's origin; never another frame. */
  resolve(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">): RemoteViewRecord | undefined {
    const record = [...this.records.values()].find((candidate) => candidate.view.webContents === event.sender)
    if (!record || record.view.webContents.isDestroyed() || event.senderFrame !== record.view.webContents.mainFrame) return undefined
    try {
      return new URL(record.view.webContents.mainFrame.url).origin === record.origin ? record : undefined
    } catch {
      return undefined
    }
  }

  isRemoteView(contents: WebContents): boolean {
    return [...this.records.values()].some((record) => record.view.webContents === contents)
  }

  open(owner: BrowserWindow, request: RemoteViewOpenRequest): void {
    const key = this.key(owner, request.viewId)
    this.close(owner, request.viewId)
    const view = this.dependencies.createView(request.profileId)
    const record: RemoteViewRecord = { view, owner, origin: request.baseUrl, entryUrl: remoteViewEntry(request.url, request.baseUrl) }
    this.records.set(key, record)
    const contents = view.webContents
    const guard = (event: Electron.Event, url: string) => {
      const decision = decideRemoteViewNavigation(url, record.origin)
      if (decision === "allow") return
      event.preventDefault()
      if (decision === "entry") queueMicrotask(() => { if (!contents.isDestroyed()) void contents.loadURL(record.entryUrl).catch(() => {}) })
      else if (decision === "help") this.dependencies.openHelp(url)
    }
    contents.on("will-navigate", guard)
    contents.on("will-redirect", guard)
    contents.on("will-attach-webview", (event) => event.preventDefault())
    contents.setWindowOpenHandler(({ url }) => {
      if (isRemoteHelpUrl(url)) this.dependencies.openHelp(url)
      return { action: "deny" }
    })
    contents.on("page-title-updated", (_event, title) => {
      const url = contents.getURL()
      try {
        const current = new URL(url)
        if (current.origin === record.origin && current.searchParams.get("codenomadEmbed") === "project") record.entryUrl = url
      } catch {}
      if (!owner.isDestroyed()) owner.webContents.send("remote-view:updated", { viewId: request.viewId, url, title })
    })
    owner.contentView.addChildView(view)
    this.place(record, request.bounds)
    void contents.loadURL(request.url).catch((error) => console.warn("[electron] failed to load remote view", error))
  }

  update(owner: BrowserWindow, request: RemoteViewUpdateRequest): void {
    const record = this.records.get(this.key(owner, validateRemoteViewId(request.viewId)))
    if (!record) throw new Error("Remote view is no longer available")
    if (!request.visible) {
      record.view.setVisible(false)
      return
    }
    this.place(record, validateRemoteViewBounds(request.bounds))
    record.view.setVisible(true)
  }

  close(owner: BrowserWindow, viewId: string): void {
    const key = this.key(owner, validateRemoteViewId(viewId))
    const record = this.records.get(key)
    if (!record) return
    this.records.delete(key)
    if (!owner.isDestroyed()) owner.contentView.removeChildView(record.view)
    if (!record.view.webContents.isDestroyed()) record.view.webContents.close()
  }

  /** A closed or reloaded owner page takes its views with it. */
  closeOwner(owner: BrowserWindow): void {
    for (const [key, record] of [...this.records]) {
      if (record.owner !== owner) continue
      this.records.delete(key)
      if (!owner.isDestroyed()) owner.contentView.removeChildView(record.view)
      if (!record.view.webContents.isDestroyed()) record.view.webContents.close()
    }
  }

  private place(record: RemoteViewRecord, bounds: RemoteViewBounds): void {
    const zoom = this.dependencies.zoomFactor(record.owner) || 1
    record.view.setBounds({
      x: Math.round(bounds.x * zoom),
      y: Math.round(bounds.y * zoom),
      width: Math.max(1, Math.round(bounds.width * zoom)),
      height: Math.max(1, Math.round(bounds.height * zoom)),
    })
  }
}
