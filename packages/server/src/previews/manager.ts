import { randomUUID } from "crypto"
import type { PreviewSession } from "../api-types"

interface PreviewRecord {
  token: string
  sessionId: string
  target: URL
  createdAt: string
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
    if (!targetPath || targetPath === "/") {
      targetPath = record.target.pathname || "/"
    } else if (!targetPath.startsWith("/")) {
      targetPath = `/${targetPath}`
    }

    return new URL(`${targetPath}${search}`, record.target.origin)
  }

  buildProxyBasePath(token: string): string {
    return `/previews/${encodeURIComponent(token)}`
  }

  private normalizeTargetUrl(rawUrl: string): URL {
    const trimmed = rawUrl.trim()
    const withProtocol = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
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
