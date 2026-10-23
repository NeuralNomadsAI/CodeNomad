import { randomUUID } from "crypto"
import type { PreviewSession } from "../api-types"

interface PreviewRecord {
  token: string
  sessionId: string
  target: URL
  createdAt: string
}

/** Loopback hosts can only be reached from the machine running the backend, so
 * they are the user's own services: the tier trusted to share the app origin.
 * Keep in sync with the UI predicate in browser-frame-security.ts. */
export function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase()
  return value === "localhost" || value === "0.0.0.0" || value === "::1" || value === "[::1]" || /^127(?:\.|$)/.test(value)
}

/** Document sandbox injected on path-proxied preview HTML as the response
 * `Content-Security-Policy`. Mirrors the iframe FRAME_SANDBOX in
 * packages/ui/src/components/browser-frame-security.ts. */
export function previewDocumentSandbox(allowSameOrigin: boolean): string {
  const flags = "allow-scripts allow-forms allow-modals allow-popups allow-downloads"
  return `sandbox ${allowSameOrigin ? `${flags} allow-same-origin` : flags}`
}

export class PreviewManager {
  private readonly previews = new Map<string, PreviewRecord>()

  create(sessionId: string, rawUrl: string): PreviewSession {
    const target = this.normalizeTargetUrl(rawUrl)
    const token = randomUUID()
    const record: PreviewRecord = {
      token,
      sessionId,
      target,
      createdAt: new Date().toISOString(),
    }
    this.previews.set(token, record)
    return this.toPreviewSession(record)
  }

  get(token: string): PreviewSession | undefined {
    const record = this.previews.get(token)
    return record ? this.toPreviewSession(record) : undefined
  }

  delete(token: string): boolean {
    return this.previews.delete(token)
  }

  buildTargetUrl(token: string, incomingPath: string, search = ""): URL | undefined {
    const record = this.previews.get(token)
    if (!record) return undefined

    const publicBase = this.buildProxyBasePath(token)
    let targetPath = incomingPath.startsWith(publicBase) ? incomingPath.slice(publicBase.length) : incomingPath
    targetPath = !targetPath || targetPath === "/" ? "/" : `/${targetPath.replace(/^\/+/, "")}`

    return new URL(`${targetPath}${search}`, record.target.origin)
  }

  buildProxyBasePath(token: string): string {
    return `/previews/${encodeURIComponent(token)}`
  }

  private normalizeTargetUrl(rawUrl: string): URL {
    const trimmed = rawUrl.trim()
    const explicitHttp = /^https?:\/\//i.test(trimmed)
    let implicitHostname = ""
    try {
      implicitHostname = new URL(`http://${trimmed}`).hostname.toLowerCase()
    } catch {
      // Invalid implicit URLs are rejected below.
    }
    const loopback = isLoopbackHostname(implicitHostname)
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !explicitHttp && !loopback) {
      throw new Error("Preview URL must use HTTP or HTTPS")
    }
    const withProtocol = explicitHttp ? trimmed : `${loopback ? "http" : "https"}://${trimmed}`
    const target = new URL(withProtocol)
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error("Preview URL must use HTTP or HTTPS")
    }
    if (target.username || target.password) {
      throw new Error("Preview URL cannot include credentials")
    }
    return target
  }

  private toPreviewSession(record: PreviewRecord): PreviewSession {
    return {
      token: record.token,
      sessionId: record.sessionId,
      targetUrl: record.target.toString(),
      proxyUrl: `${this.buildProxyBasePath(record.token)}${record.target.pathname}${record.target.search}${record.target.hash}`,
      createdAt: record.createdAt,
    }
  }
}
