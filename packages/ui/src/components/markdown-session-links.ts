import { tGlobal } from "../lib/i18n"
import { captureBackendOperation } from "../lib/backend-operation"
import { localFileUrlPath, projectLinkPath, resolveProjectLinkPath } from "../lib/markdown-project-links"
import { showToastNotification } from "../lib/notifications"
import { previewImageType } from "../lib/preview-image-types"
import { canOpenLocalPaths, openLocalPath } from "../lib/workspace-open"
import { showAlertDialog } from "../stores/alerts"
import { activeInstanceId, instances } from "../stores/instances"
import { getFilePreview, openFilePreview } from "../stores/files-preview"
import { getWorktreeForDirectory } from "../stores/worktrees"
import { requestSessionPreview } from "../stores/session-previews"
import { activeSessionId, sessions } from "../stores/session-state"
import { isLoopbackHttpUrl } from "./browser-frame-security"

// A loopback link click opens the session preview on the instance owning
// the session; failures surface through the shared alert dialog.
const openLoopbackPreview = (instanceId: string, sessionId: string, url: string) => {
  const operation = captureBackendOperation(instanceId)
  void requestSessionPreview(sessionId, instanceId, url).catch((error) => {
    if (!operation.current()) return
    if (error instanceof Error && error.name === "AbortError") return
    if (activeInstanceId() !== instanceId || activeSessionId().get(instanceId) !== sessionId) return
    showAlertDialog(tGlobal("sessionPreview.open.title"), {
      title: tGlobal("sessionPreview.open.title"),
      detail: error instanceof Error ? error.message : String(error),
      variant: "error",
    })
  })
}

export interface SessionProjectLink {
  slug: string
  directory: string
  serviceDirectory?: string
  path: string
}

/** Where session links resolve: the session's worktree root, the session's own
 * directory while the worktree inventory does not know it yet, or the instance
 * folder. Reads the stores synchronously, so calling it inside an effect also
 * tracks inventory loads for the decoration pass. */
export interface SessionLinkBase {
  slug: string
  directory: string
  serviceDirectory?: string
  /** The root hrefs resolve against: the service namespace path when the
   * worktree is known (notably WSL), else the directory itself. */
  base: string
}

export function sessionLinkBase(instanceId: string, sessionId: string): SessionLinkBase | undefined {
  if (!captureBackendOperation(instanceId).current()) return undefined
  // The session's own location: an independently moved child carries its own
  // directory, never its parent's.
  const sessionDirectory = sessions().get(instanceId)?.get(sessionId)?.location.directory
  // Inventory by directory, never by a fallback slug: a populated inventory
  // holding only the root checkout must not capture unmatched sessions.
  const worktree = sessionDirectory !== undefined ? getWorktreeForDirectory(instanceId, sessionDirectory) : undefined
  const directory = worktree?.directory
    ?? sessionDirectory
    ?? instances().get(instanceId)?.folder
  if (!directory) return undefined
  return { slug: worktree?.slug ?? "root", directory, serviceDirectory: worktree?.serviceDirectory, base: worktree?.serviceDirectory ?? directory }
}

/** The file-reader target a link href resolves to inside the session's
 * worktree, or undefined when it points anywhere else. */
export function resolveSessionProjectLink(instanceId: string, sessionId: string, href: string): SessionProjectLink | undefined {
  const root = sessionLinkBase(instanceId, sessionId)
  if (root === undefined) return undefined
  const path = resolveProjectLinkPath(href, root.base)
  if (path === undefined) return undefined
  return { slug: root.slug, directory: root.directory, serviceDirectory: root.serviceDirectory, path }
}

export interface SessionLinkTitles {
  preview: string
  file: string
  /** Local paths open with the system on this host (`canOpenLocalPaths`). */
  local: boolean
}

/** The absolute local path a link names, or undefined: a `file:` URL, an
 * absolute path, or a path the session's worktree contains. */
export function localLinkPath(href: string, base: SessionLinkBase | undefined): string | undefined {
  const url = localFileUrlPath(href)
  if (url !== undefined) return url
  const project = base && resolveProjectLinkPath(href, base.base)
  if (project !== undefined) return `${base!.directory.replace(/[\\/]+$/, "")}/${project}`
  const path = projectLinkPath(href)
  return path !== undefined && /^(?:\/|[A-Za-z]:\/)/.test(path) ? path : undefined
}

let latestLocalOpen = 0

// Opens a local path with the system. With `preview`, a missing path or a text
// file falls back to the file reader unless a later local link or preview
// superseded this click while the host decided.
const openLocal = (instanceId: string, path: string, preview?: () => void) => {
  const operation = captureBackendOperation(instanceId)
  const open = ++latestLocalOpen
  const shown = getFilePreview(instanceId)
  void openLocalPath(path, preview !== undefined).then(opened => {
    if (opened || !preview || !operation.current() || open !== latestLocalOpen || getFilePreview(instanceId) !== shown) return
    preview()
  }, error => {
    if (!operation.current()) return
    showToastNotification({ category: "files", variant: "error",
      message: tGlobal("instanceShell.filesShell.toast.openError", { message: error instanceof Error ? error.message : String(error) }) })
  })
}

/** The click dispatch for session-bound markdown links. A plain click on a
 * loopback URL opens the session preview on the instance owning the session
 * (browser-accessed frontends cannot reach the backend host's localhost); on
 * a path inside the session's worktree it opens the file reader. Where local
 * paths open with the system, a plain click keeps the file reader only for a
 * worktree image or text file and hands any other local path (folders, other
 * files, paths outside the worktree, `file:` URLs) to the system, as an
 * `external` (Ctrl/⌘ or middle) click always does. Returns whether the click
 * was handled; unhandled clicks keep browser defaults. Availability comes
 * from the mounted owner's createProjectServerMeta reader. */
export function routeSessionLink(instanceId: string, sessionId: string, href: string, loopbackLinksOpenPreview: boolean,
  external = false): boolean {
  const instance = instances().get(instanceId)
  if (!instance || !captureBackendOperation(instanceId).current()) return false
  if (!external && loopbackLinksOpenPreview && isLoopbackHttpUrl(href)) {
    openLoopbackPreview(instanceId, sessionId, href)
    return true
  }
  const resolution = resolveSessionProjectLink(instanceId, sessionId, href)
  const preview = resolution && (() => openFilePreview(instanceId, { kind: "workspace", sessionId, ...resolution }))
  const local = canOpenLocalPaths(instanceId) ? localLinkPath(href, sessionLinkBase(instanceId, sessionId)) : undefined
  if (local === undefined) {
    if (external || !preview) return false
    preview()
    return true
  }
  if (external || !preview) openLocal(instanceId, local)
  else if (previewImageType(resolution!.path)) preview()
  else openLocal(instanceId, local, preview)
  return true
}

/** The titles decorated links carry, computed from the reactive availability
 * and locale signals: call this synchronously inside an effect so their
 * changes re-run the decoration pass. */
export function sessionLinkTitles(instanceId: string | undefined, sessionId: string | undefined,
  loopbackLinksOpenPreview: boolean): SessionLinkTitles {
  const sessionBound = Boolean(instanceId && sessionId && captureBackendOperation(instanceId).current())
  const local = sessionBound && canOpenLocalPaths(instanceId)
  return {
    preview: sessionBound && loopbackLinksOpenPreview ? tGlobal("markdown.link.previewOpens") : "",
    file: sessionBound ? tGlobal(local ? "markdown.link.pathOpens" : "markdown.link.fileOpens") : "",
    local,
  }
}
/** Decorates exactly the links that intercept: loopback links while previews
 * are known available, links resolving inside the session's worktree and,
 * where they open with the system, every local path link;
 * never over an author's own title attribute. Pure DOM pass: the caller
 * computes `titles` and `base` inside its reactive effect, so availability,
 * locale and inventory changes re-run it. */
export function decorateSessionLinks(container: ParentNode, titles: SessionLinkTitles,
  base: SessionLinkBase | undefined): void {
  const previewTitle = titles.preview
  const fileTitle = Boolean(base) && titles.file
  for (const anchor of container.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = anchor.getAttribute("href") ?? ""
    const loopback = Boolean(previewTitle) && isLoopbackHttpUrl(href)
    const file = Boolean(fileTitle) && (titles.local ? localLinkPath(href, base) : resolveProjectLinkPath(href, base!.base)) !== undefined
    const title = loopback ? previewTitle : file ? titles.file : ""
    if (title) {
      if (anchor.getAttribute("data-preview-link-title") === "true") {
        // Our own tooltip follows locale changes; an author's title never does.
        if (anchor.getAttribute("title") !== title) anchor.setAttribute("title", title)
      } else if (!anchor.hasAttribute("title")) {
        anchor.setAttribute("title", title)
        anchor.setAttribute("data-preview-link-title", "true")
      }
    } else if (anchor.getAttribute("data-preview-link-title") === "true") {
      anchor.removeAttribute("title")
      anchor.removeAttribute("data-preview-link-title")
    }
  }
}
