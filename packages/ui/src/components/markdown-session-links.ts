import { tGlobal } from "../lib/i18n"
import { previewsUnavailable, previewsAvailabilityResolved, getServerMeta } from "../lib/server-meta"
import { resolveProjectLinkPath } from "../lib/markdown-project-links"
import { showAlertDialog } from "../stores/alerts"
import { activeInstanceId, instances } from "../stores/instances"
import { openFilePreview } from "../stores/files-preview"
import { getWorktreeForDirectory } from "../stores/worktrees"
import { openSessionPreview, showSessionChatFor } from "../stores/session-previews"
import { activeSessionId, sessions } from "../stores/session-state"
import { isLoopbackHttpUrl } from "./browser-frame-security"

// One session-bound Markdown instance asks for the server meta; the answer
// decides whether loopback links may open the web preview on this client.
let loopbackPreviewMetaRequested = false

/** Whether clicking a loopback link opens the web preview on this client.
 * Availability must be known first: through Remote Control with previews off
 * the default false would otherwise open a dead preview before the server
 * meta answers. */
const loopbackLinksOpenPreview = () => previewsAvailabilityResolved() && !previewsUnavailable()

/** Asks for the server meta once until it answers, so loopback availability
 * resolves without waiting for a click. */
export function warmLoopbackPreviewMeta(instanceId: string | undefined, sessionId: string | undefined): void {
  if (instanceId && sessionId && !previewsAvailabilityResolved() && !loopbackPreviewMetaRequested) {
    loopbackPreviewMetaRequested = true
    void getServerMeta().catch(() => {
      loopbackPreviewMetaRequested = false
    })
  }
}

// A loopback link click opens the session preview on the instance owning
// the session; failures surface through the shared alert dialog.
const openLoopbackPreview = (instanceId: string, sessionId: string, url: string) => {
  void openSessionPreview(sessionId, url, instanceId).catch((error) => {
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

/** The plain-click dispatch for session-bound markdown links: a loopback URL
 * opens the session preview on the instance owning the session (browser-accessed
 * frontends cannot reach the backend host's localhost), and a path inside the
 * session's worktree opens the file reader. Returns whether the click was
 * handled; modified clicks never reach this. */
export function routeSessionLink(instanceId: string, sessionId: string, href: string): boolean {
  if (loopbackLinksOpenPreview() && isLoopbackHttpUrl(href)) {
    openLoopbackPreview(instanceId, sessionId, href)
    return true
  }
  const resolution = resolveSessionProjectLink(instanceId, sessionId, href)
  if (resolution) {
    // A browser preview owning the central surface steps aside for the reader.
    showSessionChatFor(sessionId, instanceId)
    openFilePreview(instanceId, { kind: "workspace", sessionId, ...resolution })
    return true
  }
  return false
}

/** The titles decorated links carry, computed from the reactive availability
 * and locale signals: call this synchronously inside an effect so their
 * changes re-run the decoration pass. */
export function sessionLinkTitles(instanceId: string | undefined, sessionId: string | undefined): { preview: string; file: string } {
  const sessionBound = Boolean(instanceId && sessionId)
  return {
    preview: sessionBound && loopbackLinksOpenPreview() ? tGlobal("markdown.link.previewOpens") : "",
    file: sessionBound ? tGlobal("markdown.link.fileOpens") : "",
  }
}

/** Decorates exactly the links that intercept: loopback links while previews
 * are known available, and links resolving inside the session's worktree;
 * never over an author's own title attribute. Pure DOM pass: the caller
 * computes `titles` and `base` inside its reactive effect, so availability,
 * locale and inventory changes re-run it. */
export function decorateSessionLinks(container: ParentNode, titles: { preview: string; file: string },
  base: SessionLinkBase | undefined): void {
  const previewTitle = titles.preview
  const fileTitle = Boolean(base) && titles.file
  for (const anchor of container.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = anchor.getAttribute("href") ?? ""
    const loopback = Boolean(previewTitle) && isLoopbackHttpUrl(href)
    const file = Boolean(fileTitle) && resolveProjectLinkPath(href, base!.base) !== undefined
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
