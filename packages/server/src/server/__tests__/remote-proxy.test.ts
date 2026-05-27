import assert from "node:assert/strict"
import { after, afterEach, describe, it } from "node:test"
import fs from "node:fs"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import os from "node:os"
import path from "node:path"

import { Agent, fetch } from "undici"

import type { AuthManager } from "../../auth/manager"
import type { Logger } from "../../logger"
import { RemoteProxySessionManager } from "../remote-proxy"
import { resolveHttpsOptions } from "../tls"

const sharedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-remote-proxy-test-"))
const sharedTls = resolveHttpsOptions({
  enabled: true,
  configDir: sharedTempDir,
  host: "127.0.0.1",
  logger: createStubLogger(),
})

if (!sharedTls) {
  throw new Error("Failed to generate HTTPS options for remote proxy tests")
}

const sharedHttpsOptions = sharedTls.httpsOptions

const httpsDispatcher = new Agent({ connect: { rejectUnauthorized: false } })
const managers = new Set<RemoteProxySessionManager>()

afterEach(async () => {
  for (const manager of managers) {
    await disposeManager(manager)
  }
  managers.clear()
})

after(() => {
  fs.rmSync(sharedTempDir, { recursive: true, force: true })
  httpsDispatcher.close().catch(() => {})
})

describe("RemoteProxySessionManager", () => {
  it("blocks proxying before activation and keeps bootstrap tokens scoped per session", async () => {
    await withUpstreamServer(async (upstreamBaseUrl) => {
      const manager = createSessionManager()
      const session1 = await createSession(manager, `${upstreamBaseUrl}/base`)
      const session2 = await createSession(manager, `${upstreamBaseUrl}/base`)

      const blocked = await proxyFetch(`${session1.proxyOrigin}/status`)
      assert.equal(blocked.status, 403)

      const wrongTokenResponse = await proxyFetch(`${session1.proxyOrigin}/__codenomad/api/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: session2.token }),
      })
      assert.equal(wrongTokenResponse.status, 401)

      assert.equal(await activateSession(session1), true)
      assert.equal(await activateSession(session2), true)
    }, (req, res) => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end(req.url ?? "")
    })
  })

  it("preserves remote base paths and rewrites same-origin redirects to the local proxy origin", async () => {
    await withUpstreamServer(async (upstreamBaseUrl) => {
      const manager = createSessionManager()
      const session = await createSession(manager, `${upstreamBaseUrl}/base`)

      await activateSession(session)

      const apiResponse = await proxyFetch(`${session.proxyOrigin}/api/auth/status?foo=bar`)
      assert.equal(apiResponse.status, 200)
      assert.equal(await apiResponse.text(), "/base/api/auth/status?foo=bar")

      const redirectResponse = await proxyFetch(`${session.proxyOrigin}/redirect`, { redirect: "manual" })
      assert.equal(redirectResponse.status, 302)
      assert.equal(redirectResponse.headers.get("location"), `${session.proxyOrigin}/base/after?ok=1`)
    }, (req, res) => {
      const requestUrl = req.url ?? ""
      if (requestUrl === "/base/redirect") {
        res.writeHead(302, { location: "/base/after?ok=1" })
        res.end()
        return
      }

      res.writeHead(200, { "content-type": "text/plain" })
      res.end(requestUrl)
    })
  })

  it("rewrites set-cookie names for the proxy and restores cookie names on proxied requests", async () => {
    await withUpstreamServer(async (upstreamBaseUrl) => {
      const manager = createSessionManager()
      const session = await createSession(manager, `${upstreamBaseUrl}/base`)

      await activateSession(session)

      const loginResponse = await proxyFetch(`${session.proxyOrigin}/login`)
      assert.equal(loginResponse.status, 200)
      const setCookie = getSetCookie(loginResponse)[0]

      assert.match(setCookie, /^cnrp_[0-9a-f]+_session=abc123/i)
      assert.doesNotMatch(setCookie, /domain=/i)

      const cookieHeader = setCookie.split(";", 1)[0]
      const whoamiResponse = await proxyFetch(`${session.proxyOrigin}/whoami`, {
        headers: { cookie: cookieHeader },
      })

      assert.equal(await whoamiResponse.text(), "session=abc123")
    }, (req, res) => {
      const requestUrl = req.url ?? ""
      if (requestUrl === "/base/login") {
        res.writeHead(200, {
          "content-type": "text/plain",
          "set-cookie": "session=abc123; Path=/; Secure; HttpOnly; Domain=127.0.0.1",
        })
        res.end("ok")
        return
      }

      if (requestUrl === "/base/whoami") {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end(req.headers.cookie ?? "")
        return
      }

      res.writeHead(404, { "content-type": "text/plain" })
      res.end(requestUrl)
    })
  })

  it("supports explicit deletion and idle cleanup of sessions", async () => {
    await withUpstreamServer(async (upstreamBaseUrl) => {
      const manager = createSessionManager()
      const session = await createSession(manager, `${upstreamBaseUrl}/base`)

      assert.equal(await manager.deleteSession(session.sessionId), true)
      assert.equal(await manager.deleteSession(session.sessionId), false)

      const session3 = await createSession(manager, `${upstreamBaseUrl}/base`)
      const internalSessions = (manager as any).sessions as Map<string, { lastAccessAt: number }>
      const internalCleanup = (manager as any).cleanupExpiredSessions as () => Promise<void>

      internalSessions.get(session3.sessionId)!.lastAccessAt = Date.now() - 31 * 60_000
      await internalCleanup.call(manager)

      assert.equal(internalSessions.has(session3.sessionId), false)
      assert.equal(await manager.deleteSession(session3.sessionId), false)
    }, (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("ok")
    })
  })
})

function createSessionManager() {
  const manager = new RemoteProxySessionManager({
    authManager: {
      isLoopbackRequest: () => true,
    } as unknown as AuthManager,
    logger: createStubLogger(),
    httpsOptions: sharedHttpsOptions,
  })
  managers.add(manager)
  return manager
}

async function createSession(manager: RemoteProxySessionManager, baseUrl: string) {
  const created = await manager.createSession(baseUrl, false)
  const windowUrl = new URL(created.windowUrl)
  return {
    sessionId: created.sessionId,
    windowUrl,
    proxyOrigin: windowUrl.origin,
    token: decodeURIComponent(windowUrl.hash.replace(/^#/, "")),
  }
}

async function activateSession(session: { proxyOrigin: string; token: string }) {
  const response = await proxyFetch(`${session.proxyOrigin}/__codenomad/api/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: session.token }),
  })
  if (!response.ok) {
    return false
  }
  const body = (await response.json()) as { ok?: boolean }
  return body.ok === true
}

function getSetCookie(response: Awaited<ReturnType<typeof fetch>>): string[] {
  const values = (response.headers as any).getSetCookie?.() as string[] | undefined
  if (Array.isArray(values) && values.length > 0) {
    return values
  }
  const fallback = response.headers.get("set-cookie")
  return fallback ? [fallback] : []
}

async function proxyFetch(url: string, init?: Parameters<typeof fetch>[1]) {
  return fetch(url, { dispatcher: httpsDispatcher, ...init })
}

async function disposeManager(manager: RemoteProxySessionManager) {
  const sessions = Array.from(((manager as any).sessions as Map<string, unknown>).keys())
  for (const sessionId of sessions) {
    await manager.deleteSession(sessionId)
  }
  clearInterval((manager as any).cleanupTimer as NodeJS.Timeout)
}

async function withUpstreamServer(
  callback: (baseUrl: string) => Promise<void>,
  handler: (req: IncomingMessage, res: ServerResponse<IncomingMessage>) => void,
) {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))

  try {
    const address = server.address()
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve upstream server address")
    }
    await callback(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

function createStubLogger(): Logger {
  const logger = {
    info() {},
    warn() {},
    error() {},
    child() {
      return logger
    },
  }

  return logger as unknown as Logger
}
