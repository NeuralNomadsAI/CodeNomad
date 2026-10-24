import type { RuntimeEnvironment } from "../lib/runtime-env"
import type { PreviewFeatureSettings, PreviewSandboxSettings, PreviewSettings } from "../../../server/src/api-types"

const FRAME_SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-downloads"
const SAME_ORIGIN_FLAG = "allow-same-origin"
const CAPABILITY_HOST_SUFFIX = ".preview.localhost"

/** Browser features in the order they appear in the iframe `allow`
 * attribute. Disabled features are serialized as `'none'` so a same-origin
 * frame cannot fall back to the inherited `self` default. */
const PREVIEW_FEATURES: ReadonlyArray<readonly [keyof PreviewFeatureSettings, string]> = [
  ["camera", "camera"],
  ["microphone", "microphone"],
  ["clipboardRead", "clipboard-read"],
  ["clipboardWrite", "clipboard-write"],
  ["geolocation", "geolocation"],
  ["notifications", "notifications"],
  ["fullscreen", "fullscreen"],
]

/**
 * `allow-same-origin` lets a frame's own fetches and WebSocket handshakes stay
 * same-origin, so the `SameSite=Lax` session cookie reaches app-authenticated
 * routes. Reserved for app-proxied content the user explicitly configured
 * (SideCars and trusted previews): without it the sandboxed frame is an opaque
 * origin, its requests carry `Origin: null`, and authenticated routes reject
 * them before the proxy runs.
 */
export function getBrowserFramePolicy(
  _environment: Pick<RuntimeEnvironment, "host" | "windowContext">,
  options: { trustedSameOrigin?: boolean; sandboxFlags?: string } = {},
) {
  const flags = (options.sandboxFlags ?? FRAME_SANDBOX).split(" ").filter(Boolean)
  if (options.trustedSameOrigin && !flags.includes(SAME_ORIGIN_FLAG)) flags.push(SAME_ORIGIN_FLAG)
  return {
    sandbox: flags.join(" "),
    canInspectDom: false,
  }
}

/** Iframe `sandbox` tokens for a preview policy. Scripts are always required
 * and `allow-same-origin` is added only by {@link getBrowserFramePolicy} for a
 * trusted frame. Mirrors the server document sandbox in
 * `packages/server/src/previews/policy.ts`. */
export function previewSandboxFlags(settings: PreviewSandboxSettings): string {
  const flags = ["allow-scripts"]
  if (settings.forms) flags.push("allow-forms")
  if (settings.modals) flags.push("allow-modals")
  if (settings.popups) flags.push("allow-popups")
  if (settings.downloads) flags.push("allow-downloads")
  return flags.join(" ")
}

/** Iframe `allow` attribute for the configured browser features. */
export function previewAllowAttribute(features: PreviewFeatureSettings): string {
  return PREVIEW_FEATURES.map(([key, token]) => (features[key] ? token : `${token} 'none'`)).join("; ")
}

/** Only a literal loopback host reaches the machine running the backend. */
function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase()
  if (value === "localhost" || value === "0.0.0.0" || value === "::1" || value === "[::1]") return true
  const octets = value.split(".")
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}

export function isLoopbackPreviewUrl(rawUrl: string): boolean {
  try {
    const target = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`)
    return isLoopbackHostname(target.hostname)
  } catch {
    return false
  }
}

/** Strict anchor-href check for transcript links: only an explicit http(s)
 * URL on a loopback host is routed through the session preview. Anything
 * else (relative, schemed non-loopback, bare hostnames) keeps default link
 * behavior. Keep the hostname set in sync with the server's
 * isLoopbackHostname in packages/server/src/previews/policy.ts. */
export function isLoopbackHttpUrl(rawUrl: string): boolean {
  if (!/^https?:\/\//i.test(rawUrl)) return false
  try {
    return isLoopbackHostname(new URL(rawUrl).hostname)
  } catch {
    return false
  }
}

export function normalizeBrowserPreviewUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (!trimmed || trimmed.length > 2_048) throw new TypeError()
  const explicitHttp = /^https?:\/\//i.test(trimmed)
  const loopback = isLoopbackPreviewUrl(trimmed)
  const target = new URL(explicitHttp ? trimmed : `${loopback ? "http" : "https"}://${trimmed}`)
  if (!explicitHttp && /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new TypeError()
  }
  if (!target.hostname || target.username || target.password) throw new TypeError()
  return target.href
}

/** Path previews only share an origin with a loopback target in app or custom
 * mode. Opaque mode never trusts a preview, and custom mode needs a real
 * configured origin before it can be trusted. */
export function isTrustedPreviewSameOrigin(targetUrl: string, settings: PreviewSettings): boolean {
  if (settings.originMode === "opaque") return false
  if (settings.originMode === "custom" && !settings.customOrigin) return false
  return isLoopbackPreviewUrl(targetUrl)
}

/** Desktop local previews keep their isolated per-token capability host before
 * the web origin mode applies. */
function capabilityFrameSource(
  preview: { token: string; targetUrl: string },
  parentUrl: string,
): string | undefined {
  const source = new URL(parentUrl)
  if (source.protocol !== "http:" || !isLoopbackHostname(source.hostname)) return undefined
  const target = new URL(preview.targetUrl)
  source.hostname = `${preview.token}${CAPABILITY_HOST_SUFFIX}`
  source.pathname = target.pathname
  source.search = target.search
  source.hash = target.hash
  return source.href
}

export function getPreviewFrameSource(
  environment: Pick<RuntimeEnvironment, "host" | "windowContext">,
  preview: { token: string; targetUrl: string; proxyUrl: string },
  parentUrl: string,
  settings: PreviewSettings,
): string {
  if (environment.windowContext === "local" && (environment.host === "electron" || environment.host === "tauri")) {
    const capabilitySource = capabilityFrameSource(preview, parentUrl)
    if (capabilitySource) return capabilitySource
  }
  if (settings.originMode === "custom" && settings.customOrigin) {
    return `${settings.customOrigin}${preview.proxyUrl}`
  }
  return preview.proxyUrl
}

/** Whether a frame source is the desktop capability host rather than a path
 * preview at the app or custom origin. */
export function isCapabilityPreviewFrame(
  environment: Pick<RuntimeEnvironment, "host" | "windowContext">,
  frameSource: string,
): boolean {
  if (environment.windowContext !== "local" || (environment.host !== "electron" && environment.host !== "tauri")) return false
  try {
    const source = new URL(frameSource)
    return (source.protocol === "http:" || source.protocol === "https:")
      && source.hostname.toLowerCase().endsWith(CAPABILITY_HOST_SUFFIX)
  } catch {
    return false
  }
}

/** Expected `event.origin` for a preview's comment/location bridge. */
export function getPreviewMessageOrigin(
  environment: Pick<RuntimeEnvironment, "host" | "windowContext">,
  frameSource: string,
  targetUrl: string,
  settings: PreviewSettings,
  parentOrigin: string,
): string {
  if (isCapabilityPreviewFrame(environment, frameSource)) {
    try {
      return new URL(frameSource).origin
    } catch {
      return "null"
    }
  }
  if (!isTrustedPreviewSameOrigin(targetUrl, settings)) return "null"
  return settings.originMode === "custom" ? settings.customOrigin : parentOrigin
}
