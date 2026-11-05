import { isEmbeddedAsset, isPassiveImageMime } from "../../../server/src/opencode/embedded-asset"
import { isSessionMediaPath, parseSessionMediaPath } from "../../../server/src/opencode/session-media-contract"

export interface MediaPolicy {
  /** Producing binding identity, retained with display snapshots. */
  ownerKey?: string
  kind: "explicit" | "unknown" | "local" | "trusted"
  instanceId?: string
  sessionId?: string
  /** References already held by this content's owner, including native positions and digest. */
  nativeMedia?: readonly { uri: string; mime: string }[]
  current?: boolean
}

export const restrictedMediaPolicy: MediaPolicy = { kind: "unknown", ownerKey: "unknown" }
export const trustedMediaPolicy: MediaPolicy = { kind: "trusted", ownerKey: "trusted-nonproject" }
export const isRestrictedMedia = (policy: MediaPolicy) => policy.kind === "explicit" || policy.kind === "unknown"

/** One decision for DOM sources and explicit downloads; never contacts OpenCode directly. */
export function authorizedMediaSource(file: { uri: string; mime: string }, policy: MediaPolicy, apiBase?: string, image = true): string | undefined {
  if (isRestrictedMedia(policy) && image && !isPassiveImageMime(file.mime)) return undefined
  if (/^data:/i.test(file.uri)) return isEmbeddedAsset(file) ? file.uri : undefined
  const prefix = (apiBase ?? "").replace(/\/+$/, "")
  // Strip only our exact API base, never a lexical origin/path prefix.
  const path = prefix && file.uri.startsWith(`${prefix}/api/`) ? file.uri.slice(prefix.length) : file.uri
  if (!isRestrictedMedia(policy) && isSessionMediaPath(path)) return `${prefix}${path}`
  const native = parseSessionMediaPath(path)
  if (native) {
    if (!isRestrictedMedia(policy)) return `${prefix}${path}`
    if (!policy.current || native.workspaceId !== policy.instanceId || native.sessionId !== policy.sessionId) return undefined
    if (!policy.nativeMedia?.some(known => known.uri === path && known.mime === file.mime)) return undefined
    return `${prefix}${path}`
  }
  if (isRestrictedMedia(policy)) return undefined
  try {
    const url = new URL(file.uri)
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) return file.uri
  } catch { /* Local paths, blob owners and executable schemes have no media authority. */ }
  return undefined
}

export function authorizedImageUri(uri: string, policy: MediaPolicy, apiBase?: string): string | undefined {
  if (!isRestrictedMedia(policy)) return uri
  const mime = /^data:([^;,]+);base64,/i.exec(uri.slice(0, 160))?.[1]
    ?? policy.nativeMedia?.find(file => file.uri === uri || `${(apiBase ?? "").replace(/\/+$/, "")}${file.uri}` === uri)?.mime
  return mime ? authorizedMediaSource({ uri, mime }, policy, apiBase) : undefined
}
