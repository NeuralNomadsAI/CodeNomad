import type { RemotePreviewCapability } from "../../../server/src/api-types"
import { historyUrl } from "./browser-history"

type Capability = Pick<RemotePreviewCapability, "token" | "capability" | "contentUrl" | "targetUrl">

/** A native commit without a logical mapping may request a new capability only for a site URL. */
export function remotePreviewNavigationTarget(source: string, opaqueOrigin?: string): string | undefined {
  const safe = historyUrl(source)
  if (!safe) return
  const url = new URL(safe)
  if (url.hostname.endsWith(".preview.localhost") || url.origin === opaqueOrigin && url.pathname.startsWith("/previews/")) return
  return safe
}

/**
 * Where a remote capability's content loads. Local desktop UIs receive an exclusive
 * `<capability>.preview.localhost` origin (prefix: the remote token). Remote clients
 * receive a host path capability `/previews/<capability>/…` on the page's own origin,
 * whose documents are opaque.
 */
export function remotePreviewContent(preview: Capability, pageOrigin = globalThis.location?.origin): { origin: string; prefix: string; opaque: boolean } | undefined {
  if (!preview.capability || preview.capability === preview.token) return
  const pathPrefix = `/previews/${preview.capability}`
  if (preview.contentUrl.startsWith(`${pathPrefix}/`)) {
    if (!pageOrigin || pageOrigin === "null") return
    return { origin: new URL(pageOrigin).origin, prefix: pathPrefix, opaque: true }
  }
  try {
    const source = new URL(preview.contentUrl)
    if (source.protocol !== "http:" || source.hostname !== `${preview.capability}.preview.localhost`
      || source.username || source.password || !source.port) return
    return { origin: source.origin, prefix: `/previews/${preview.token}`, opaque: false }
  } catch { return }
}

export function remotePreviewSource(preview: Capability, address: string, pageOrigin?: string): string | undefined {
  const content = remotePreviewContent(preview, pageOrigin)
  const safe = historyUrl(address)
  if (!content || !safe) return
  const target = new URL(safe)
  if (target.origin !== new URL(preview.targetUrl).origin || target.hostname.endsWith(".preview.localhost")) return
  const source = new URL(content.origin)
  source.pathname = `${content.prefix}${target.pathname}`
  source.search = target.search
  source.hash = target.hash
  return source.href
}

export function remotePreviewAddress(preview: Capability, source: string, pageOrigin?: string): string | undefined {
  const content = remotePreviewContent(preview, pageOrigin)
  const safe = historyUrl(source)
  if (!content || !safe) return
  const url = new URL(safe)
  if (url.origin !== content.origin) return
  const { prefix } = content
  const inside = url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)
  // A host path capability shares the application's origin: only its own prefix maps.
  if (content.opaque && !inside) return
  const target = new URL(preview.targetUrl)
  target.pathname = url.pathname === prefix ? "/" : inside ? url.pathname.slice(prefix.length) : url.pathname
  target.search = url.search
  target.hash = url.hash
  return target.href
}
