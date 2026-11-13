import type { RemotePreviewCapability } from "../../../server/src/api-types"
import { historyUrl } from "./browser-history"

export function remotePreviewSource(preview: RemotePreviewCapability, address: string): string | undefined {
  const safe = historyUrl(address)
  if (!safe) return
  const target = new URL(safe)
  if (target.origin !== new URL(preview.targetUrl).origin || target.hostname.endsWith(".preview.localhost")) return
  const source = new URL(preview.contentUrl)
  source.pathname = `/previews/${preview.token}${target.pathname}`
  source.search = target.search
  source.hash = target.hash
  return source.href
}

export function remotePreviewAddress(preview: RemotePreviewCapability, source: string): string | undefined {
  const safe = historyUrl(source)
  if (!safe) return
  const url = new URL(safe)
  if (url.origin !== new URL(preview.contentUrl).origin) return
  const prefix = `/previews/${preview.token}`
  const target = new URL(preview.targetUrl)
  target.pathname = url.pathname === prefix ? "/" : url.pathname.startsWith(`${prefix}/`) ? url.pathname.slice(prefix.length) : url.pathname
  target.search = url.search
  target.hash = url.hash
  return target.href
}
