import { isToolImageContent, toolImageSource } from "./tool-content"

/** Agents write Markdown images of files on their machine (`C:/…/image.png`, `/tmp/…`, `./out.png`).
 * The renderer cannot load such paths; it can show an image the transcript already holds for them. */
export function localImagePath(src: string): string | undefined {
  let value = src.trim()
  if (!value || /^(?:https?:|data:|blob:|mailto:|#)/i.test(value)) return undefined
  // file:///C:/x and file:///tmp/x name the same files as C:/x and /tmp/x.
  if (/^file:\/\//i.test(value)) value = value.slice(7).replace(/^\/([A-Za-z]:)/, "$1")
  else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) return undefined
  try { value = decodeURI(value) } catch { /* Keep the literal path. */ }
  return value.replace(/\\/g, "/")
}

const windowsPath = (value: string) => /^(?:[A-Za-z]:\/|\/\/)/.test(value)
const comparable = (value: string) => {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "")
  return windowsPath(normalized) ? normalized.toLowerCase() : normalized
}

export interface SessionImageCandidate { paths: string[]; source: string }

/** Matches an exact path, or a relative path against the end of a known absolute one (one match only). */
export function matchLocalImage(candidates: Iterable<SessionImageCandidate>, path: string): string | undefined {
  const target = comparable(path)
  const relative = !target.startsWith("/") && !windowsPath(target) && !target.startsWith("../")
    ? `/${target.replace(/^(?:\.\/)+/, "")}` : undefined
  const suffixes = new Set<string>()
  for (const candidate of candidates) {
    for (const known of candidate.paths.map(comparable)) {
      if (known === target) return candidate.source
      // Windows paths compare case-insensitively, so their relative suffix does too.
      if (relative && (windowsPath(known) ? known.endsWith(relative.toLowerCase()) : known.endsWith(relative))) suffixes.add(candidate.source)
    }
  }
  return suffixes.size === 1 ? [...suffixes][0] : undefined
}

/** Swaps each rendered local-image label for the matching transcript image; unmatched labels keep their alt text. */
export function resolveLocalImages(container: ParentNode, candidates: readonly SessionImageCandidate[]): void {
  for (const element of container.querySelectorAll<HTMLElement>("[data-local-image]")) {
    const source = matchLocalImage(candidates, element.dataset.localImage ?? "")
    if (!source) continue
    if (element instanceof HTMLImageElement) {
      if (element.getAttribute("src") !== source) element.src = source
      continue
    }
    const image = document.createElement("img")
    image.className = "markdown-local-image"
    image.dataset.localImage = element.dataset.localImage
    image.alt = element.textContent ?? ""
    image.title = element.title
    image.loading = "lazy"
    image.decoding = "async"
    image.referrerPolicy = "no-referrer"
    image.src = source
    element.replaceWith(image)
  }
}

type PartData = { type?: string; state?: { status?: string; input?: Record<string, unknown>; content?: unknown } }

/** Tool-result images of a session's loaded messages, newest first, keyed by their file name and the tool's file path. */
export function* sessionImageCandidates(messages: Iterable<{ partIds: string[]; parts: Record<string, { data: unknown }> }>): Generator<SessionImageCandidate> {
  for (const message of messages) {
    for (const partId of [...message.partIds].reverse()) {
      const data = message.parts[partId]?.data as PartData | undefined
      if (data?.type !== "tool" || data.state?.status !== "completed" || !Array.isArray(data.state.content)) continue
      const images = data.state.content.filter(isToolImageContent)
      const input = data.state.input?.filePath ?? data.state.input?.path
      for (const image of images) {
        const source = toolImageSource(image)
        if (!source) continue
        const paths = [image.name, images.length === 1 ? input : undefined].filter((value): value is string => typeof value === "string" && value.length > 0)
        if (paths.length) yield { paths, source }
      }
    }
  }
}
