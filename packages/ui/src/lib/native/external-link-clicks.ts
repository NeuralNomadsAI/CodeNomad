import { openExternalUrl } from "../external-url"

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"])

/**
 * Opens anchors that ask for a new window (`target="_blank"`, or a Ctrl/Shift
 * click) in the system handler through the host's opener command, as the Tauri
 * opener plugin's click handler would. The host disables that handler: its
 * plugin command would bypass the host's environment and URL policy.
 */
export function installExternalLinkClicks(target: Window): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey) return
    const anchor = event.composedPath().find((node): node is HTMLAnchorElement =>
      node instanceof Node && node.nodeName.toUpperCase() === "A")
    if (!anchor?.href || (anchor.target !== "_blank" && !event.ctrlKey && !event.shiftKey)) return
    let url: URL
    try {
      url = new URL(anchor.href)
    } catch {
      return
    }
    if (!EXTERNAL_PROTOCOLS.has(url.protocol)) return
    event.preventDefault()
    void openExternalUrl(url.href, "link")
  }
  target.addEventListener("click", onClick)
  return () => target.removeEventListener("click", onClick)
}
