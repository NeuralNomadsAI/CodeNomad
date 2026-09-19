import type { RuntimeEnvironment } from "../lib/runtime-env"

const FRAME_SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-downloads"

export function getBrowserFramePolicy(_environment: Pick<RuntimeEnvironment, "host" | "windowContext">) {
  return {
    sandbox: FRAME_SANDBOX,
    canInspectDom: false,
  }
}

export function isLoopbackPreviewUrl(rawUrl: string): boolean {
  try {
    const target = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`)
    const hostname = target.hostname.toLowerCase()
    return hostname === "localhost" || hostname === "0.0.0.0" || hostname === "[::1]" || /^127(?:\.|$)/.test(hostname)
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

export function getPreviewFrameSource(
  environment: Pick<RuntimeEnvironment, "host" | "windowContext">,
  preview: { token: string; targetUrl: string; proxyUrl: string },
  parentUrl: string,
): string {
  if (environment.windowContext !== "local" || (environment.host !== "electron" && environment.host !== "tauri")) {
    return preview.proxyUrl
  }
  const source = new URL(parentUrl)
  const loopback = source.hostname === "localhost" || source.hostname === "[::1]" || /^127(?:\.|$)/.test(source.hostname)
  if (source.protocol !== "http:" || !loopback) return preview.proxyUrl
  const target = new URL(preview.targetUrl)
  source.hostname = `${preview.token}.preview.localhost`
  source.pathname = target.pathname
  source.search = target.search
  source.hash = target.hash
  return source.href
}
