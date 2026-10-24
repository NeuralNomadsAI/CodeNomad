import { isIP } from "node:net"
import type {
  PreviewFeatureSettings,
  PreviewOriginMode,
  PreviewSandboxSettings,
  PreviewSettings,
} from "../api-types"

export const DEFAULT_PREVIEW_SETTINGS: PreviewSettings = {
  originMode: "opaque",
  customOrigin: "",
  sandbox: {
    forms: true,
    modals: true,
    popups: true,
    downloads: true,
  },
  features: {
    camera: false,
    microphone: false,
    clipboardRead: false,
    clipboardWrite: false,
    geolocation: false,
    notifications: false,
    fullscreen: false,
  },
}

const ORIGIN_MODES: readonly PreviewOriginMode[] = ["opaque", "app", "custom"]

/** Only literal loopback hosts reach the machine running the backend. */
export function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase()
  return value === "localhost"
    || value === "0.0.0.0"
    || value === "::1"
    || value === "[::1]"
    || (isIP(value) === 4 && value.startsWith("127."))
}

/** Document sandbox string shared by the iframe attribute and the CSP the path
 * proxy injects. Scripts are always required; the configured capabilities are
 * additive, and `allow-same-origin` is reserved for explicitly trusted
 * previews. */
export function previewDocumentSandbox(allowSameOrigin: boolean, sandbox: PreviewSandboxSettings): string {
  const flags = ["allow-scripts"]
  if (sandbox.forms) flags.push("allow-forms")
  if (sandbox.modals) flags.push("allow-modals")
  if (sandbox.popups) flags.push("allow-popups")
  if (sandbox.downloads) flags.push("allow-downloads")
  if (allowSameOrigin) flags.push("allow-same-origin")
  return `sandbox ${flags.join(" ")}`
}

/** Normalize a stored or hand-edited preview policy into its safe form: unknown
 * modes and invalid origins are dropped, and every missing capability falls
 * back to the default. */
export function normalizePreviewSettings(value: unknown): PreviewSettings {
  const record = isPlainObject(value) ? value : {}
  const originMode = ORIGIN_MODES.includes(record.originMode as PreviewOriginMode)
    ? record.originMode as PreviewOriginMode
    : DEFAULT_PREVIEW_SETTINGS.originMode
  return {
    originMode,
    customOrigin: normalizeCustomOrigin(record.customOrigin),
    sandbox: normalizeSandbox(record.sandbox),
    features: normalizeFeatures(record.features),
  }
}

/** Resolve a stored policy against every origin CodeNomad itself is served
 * from. A custom origin needs a hostname of its own: an empty, invalid or
 * app-owned origin degrades to the default opaque policy, even when only the
 * port differs. A loopback app origin owns every loopback alias on its own
 * port, so `localhost`, `127.x`, `[::1]` and `0.0.0.0` cannot name the app's
 * origin. */
export function resolvePreviewSettings(value: unknown, appOrigins: Iterable<string>): PreviewSettings {
  const settings = normalizePreviewSettings(value)
  if (settings.originMode !== "custom") return settings
  const custom = originAddress(settings.customOrigin)
  if (!custom.hostname) return normalizePreviewSettings(undefined)
  for (const appOrigin of appOrigins) {
    const app = originAddress(appOrigin)
    if (!app.hostname) continue
    if (app.hostname === custom.hostname) return normalizePreviewSettings(undefined)
    if (app.port === custom.port && isLoopbackHostname(app.hostname) && isLoopbackHostname(custom.hostname)) {
      return normalizePreviewSettings(undefined)
    }
  }
  return settings
}

/** The response sandbox for a path-proxied preview. `app` mode trusts loopback
 * targets, while `custom` mode also requires the request to have arrived at
 * the configured custom origin; an invalid target or a missing `Host` stays
 * opaque.
 *
 * Callers must pass the output of {@link resolvePreviewSettings}: this helper
 * cannot tell that a stored custom origin is owned by CodeNomad itself, so an
 * app-owned custom origin reaches the loopback tier unless it was resolved
 * first. */
export function previewDocumentSandboxForTarget(
  targetUrl: string,
  settings: PreviewSettings,
  requestHost: string,
): string {
  let targetHostname = ""
  try {
    targetHostname = new URL(targetUrl).hostname
  } catch {
    // Unknown targets stay in the untrusted tier.
  }
  const targetIsLoopback = isLoopbackHostname(targetHostname)
  const customHost = settings.originMode === "custom" ? hostPort(settings.customOrigin) : ""
  const customOriginMatches = customHost.length > 0 && customHost === normalizeHostPort(requestHost)
  const allowSameOrigin = settings.originMode === "app"
    ? targetIsLoopback
    : settings.originMode === "custom"
      ? targetIsLoopback && customOriginMatches
      : false
  return previewDocumentSandbox(allowSameOrigin, settings.sandbox)
}

/** An origin's hostname and effective port; `URL` already drops default ports. */
function originAddress(origin: string): { hostname: string; port: string } {
  if (!origin) return { hostname: "", port: "" }
  try {
    const url = new URL(origin)
    return { hostname: url.hostname.toLowerCase(), port: url.port }
  } catch {
    return { hostname: "", port: "" }
  }
}

/** The configured origin's host and port; `URL` already drops the default port. */
function hostPort(origin: string): string {
  try {
    return new URL(origin).host.toLowerCase()
  } catch {
    return ""
  }
}

function normalizeHostPort(host: string): string {
  return host.trim().toLowerCase()
}

function normalizeCustomOrigin(value: unknown): string {
  if (typeof value !== "string") return ""
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return ""
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return ""
  if (url.username || url.password) return ""
  if (url.pathname !== "/" || url.search || url.hash) return ""
  return url.origin
}

function normalizeSandbox(value: unknown): PreviewSandboxSettings {
  const record = isPlainObject(value) ? value : {}
  return {
    forms: booleanOr(record.forms, DEFAULT_PREVIEW_SETTINGS.sandbox.forms),
    modals: booleanOr(record.modals, DEFAULT_PREVIEW_SETTINGS.sandbox.modals),
    popups: booleanOr(record.popups, DEFAULT_PREVIEW_SETTINGS.sandbox.popups),
    downloads: booleanOr(record.downloads, DEFAULT_PREVIEW_SETTINGS.sandbox.downloads),
  }
}

function normalizeFeatures(value: unknown): PreviewFeatureSettings {
  const record = isPlainObject(value) ? value : {}
  return {
    camera: booleanOr(record.camera, DEFAULT_PREVIEW_SETTINGS.features.camera),
    microphone: booleanOr(record.microphone, DEFAULT_PREVIEW_SETTINGS.features.microphone),
    clipboardRead: booleanOr(record.clipboardRead, DEFAULT_PREVIEW_SETTINGS.features.clipboardRead),
    clipboardWrite: booleanOr(record.clipboardWrite, DEFAULT_PREVIEW_SETTINGS.features.clipboardWrite),
    geolocation: booleanOr(record.geolocation, DEFAULT_PREVIEW_SETTINGS.features.geolocation),
    notifications: booleanOr(record.notifications, DEFAULT_PREVIEW_SETTINGS.features.notifications),
    fullscreen: booleanOr(record.fullscreen, DEFAULT_PREVIEW_SETTINGS.features.fullscreen),
  }
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
