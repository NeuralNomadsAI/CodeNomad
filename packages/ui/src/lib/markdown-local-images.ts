import { untrack } from "solid-js"
import { isToolImageContent, toolImageSource } from "./tool-content"

const decode = (value: string) => { try { return decodeURIComponent(value) } catch { return value } }

/** Agents write Markdown images of files on their machine (`C:/…/image.png`, `/tmp/…`, `./out.png`).
 * The renderer cannot load such paths; it can show an image the transcript already holds for them. */
export function localImagePath(src: string): string | undefined {
  const value = src.trim()
  // Scheme-relative `//host/…` is a web URL; a UNC share is spelled `\\host\…`.
  if (!value || value.startsWith("//") || /^(?:https?:|data:|blob:|mailto:|#)/i.test(value)) return undefined
  if (/^file:/i.test(value)) {
    let url: URL
    try { url = new URL(value) } catch { return undefined }
    const path = decode(url.pathname)
    if (url.host && url.host.toLowerCase() !== "localhost") return `//${url.host}${path}`
    return path.replace(/^\/([A-Za-z]:)/, "$1")
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) return undefined
  // A plain path stays literal (`a%20b.png` may be a real name); matching tries its decoded form second.
  return normalizePath(value)
}

const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
const windowsPath = (value: string) => /^(?:[A-Za-z]:\/|\/\/)/.test(value)
const comparable = (value: string) => {
  const normalized = normalizePath(value)
  return windowsPath(normalized) ? normalized.toLowerCase() : normalized
}

export interface SessionImageCandidate { paths: string[]; source: string }

/** Matches the literal path against the transcript's images, then (for a plain path written in
 * Markdown, never one already decoded from a `file:` URL) its percent-decoded form. */
export function matchLocalImage(candidates: readonly SessionImageCandidate[], path: string, decodedFallback = true): string | undefined {
  const decoded = decode(path)
  return matchPath(candidates, path) ?? (decodedFallback && decoded !== path ? matchPath(candidates, decoded) : undefined)
}

/** Whether a Markdown image source is a `file:` URL, whose path is already decoded. */
export const isFileUrl = (src: string) => /^file:/i.test(src.trim())

/** An exact path, or a relative path against the end of exactly one known path
 * (candidates newest first, so a re-read file resolves to its latest image). */
function matchPath(candidates: readonly SessionImageCandidate[], path: string): string | undefined {
  const target = comparable(path)
  const relative = !target.startsWith("/") && !windowsPath(target) && !target.startsWith("../")
    ? `/${target.replace(/^(?:\.\/)+/, "")}` : undefined
  const suffixes = new Map<string, string>()
  for (const candidate of candidates) {
    for (const known of candidate.paths.map(comparable)) {
      if (known === target) return candidate.source
      // Windows paths compare case-insensitively, so their relative suffix does too.
      if (relative && !suffixes.has(known) && (windowsPath(known) ? known.endsWith(relative.toLowerCase()) : known.endsWith(relative)))
        suffixes.set(known, candidate.source)
    }
  }
  return suffixes.size === 1 ? [...suffixes.values()][0] : undefined
}

function label(element: HTMLElement, failedSource?: string): HTMLSpanElement {
  const span = document.createElement("span")
  span.className = "markdown-local-image"
  span.dataset.localImage = element.dataset.localImage
  if (element.dataset.localImageExact !== undefined) span.dataset.localImageExact = ""
  if (failedSource) span.dataset.failedSource = failedSource
  span.title = element.title
  span.textContent = element instanceof HTMLImageElement ? element.alt : element.textContent
  return span
}

/** Shows each rendered local-image label as its matching transcript image. An image whose
 * match disappears, or whose source fails to load, returns to its alt text; a changed source retries. */
export function resolveLocalImages(container: ParentNode, candidates: readonly SessionImageCandidate[]): void {
  for (const element of container.querySelectorAll<HTMLElement>("[data-local-image]")) {
    const source = matchLocalImage(candidates, element.dataset.localImage ?? "", element.dataset.localImageExact === undefined)
    if (element instanceof HTMLImageElement) {
      if (!source) element.replaceWith(label(element))
      else if (element.getAttribute("src") !== source) element.src = source
      continue
    }
    if (!source || source === element.dataset.failedSource) continue
    const image = document.createElement("img")
    image.className = "markdown-local-image"
    image.dataset.localImage = element.dataset.localImage
    if (element.dataset.localImageExact !== undefined) image.dataset.localImageExact = ""
    image.alt = element.textContent ?? ""
    image.title = element.title
    image.loading = "lazy"
    image.decoding = "async"
    image.referrerPolicy = "no-referrer"
    image.addEventListener("error", () => { if (image.isConnected) image.replaceWith(label(image, image.getAttribute("src") ?? undefined)) })
    image.src = source
    element.replaceWith(image)
  }
}

type PartData = { type?: string; state?: { status?: string; input?: Record<string, unknown>; content?: unknown } }
export interface MessageImageSource { revision: number; partIds: string[]; parts: Record<string, { data: unknown }> }

function* scanMessage(message: MessageImageSource): Generator<SessionImageCandidate> {
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

const scanned = new WeakMap<object, { revision: number; candidates: SessionImageCandidate[] }>()

/** One message's tool-result images, newest first, keyed by file name and the single-image tool's file path.
 * Tracks only the message's revision; its parts are rescanned once per revision and shared by every reader. */
export function messageImageCandidates(message: MessageImageSource): SessionImageCandidate[] {
  const revision = message.revision
  const cached = scanned.get(message)
  if (cached?.revision === revision) return cached.candidates
  const candidates = untrack(() => [...scanMessage(message)])
  scanned.set(message, { revision, candidates })
  return candidates
}
