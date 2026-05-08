import { spawn, type ChildProcess } from "child_process"
import { randomUUID } from "crypto"
import { createServer } from "net"
import { fetch } from "undici"
import type { Logger } from "../logger"
import type { SshConnectionBootstrapRequest, SshConnectionBootstrapResponse } from "../api-types"

const LOOPBACK_HOST = "127.0.0.1"
const DEFAULT_SSH_PORT = 22
const DEFAULT_REMOTE_SERVER_PORT = 9898
const PROBE_TIMEOUT_MS = 15_000
const PROBE_INTERVAL_MS = 500

interface ActiveSshSession {
  sessionId: string
  connectionProfileId?: string
  child: ChildProcess
  baseUrl: string
  localPort: number
  remoteServerPort: number
  stderr: string[]
}

export class SshConnectionSessionManager {
  private readonly sessions = new Map<string, ActiveSshSession>()
  private readonly sessionIdByProfileId = new Map<string, string>()

  constructor(private readonly logger: Logger) {}

  async connect(request: SshConnectionBootstrapRequest): Promise<SshConnectionBootstrapResponse> {
    const connectionProfileId = request.connectionProfileId?.trim() || undefined
    if (connectionProfileId) {
      const existingSessionId = this.sessionIdByProfileId.get(connectionProfileId)
      if (existingSessionId) {
        const existing = this.sessions.get(existingSessionId)
        if (existing && (await this.isReachable(existing.baseUrl))) {
          return {
            sessionId: existing.sessionId,
            baseUrl: existing.baseUrl,
            localPort: existing.localPort,
            remoteServerPort: existing.remoteServerPort,
          }
        }
        await this.disposeByProfileId(connectionProfileId)
      }
    }

    const remoteServerPort = request.remoteServerPort ?? DEFAULT_REMOTE_SERVER_PORT
    if (request.bootstrapScript?.trim()) {
      await this.runBootstrapScript({ ...request, remoteServerPort })
    }

    const localPort = await getAvailablePort()
    const target = buildSshTarget(request)
    const args = [
      "-p",
      String(request.port ?? DEFAULT_SSH_PORT),
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      "-N",
      "-L",
      `${LOOPBACK_HOST}:${localPort}:${LOOPBACK_HOST}:${remoteServerPort}`,
      target,
    ]

    const child = spawn("ssh", args, {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    })

    const sessionId = randomUUID()
    const baseUrl = `http://${LOOPBACK_HOST}:${localPort}`
    const active: ActiveSshSession = {
      sessionId,
      connectionProfileId,
      child,
      baseUrl,
      localPort,
      remoteServerPort,
      stderr: [],
    }

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim()
      if (!text) return
      active.stderr.push(text)
      if (active.stderr.length > 20) {
        active.stderr.shift()
      }
    })

    child.once("exit", (code, signal) => {
      this.logger.info({ sessionId, code, signal }, "SSH tunnel session exited")
      this.sessions.delete(sessionId)
      if (connectionProfileId) {
        this.sessionIdByProfileId.delete(connectionProfileId)
      }
    })

    this.sessions.set(sessionId, active)
    if (connectionProfileId) {
      this.sessionIdByProfileId.set(connectionProfileId, sessionId)
    }

    try {
      await this.waitForReachable(baseUrl, child, active.stderr)
    } catch (error) {
      await this.disposeSession(sessionId)
      throw error
    }

    return {
      sessionId,
      baseUrl,
      localPort,
      remoteServerPort,
    }
  }

  async disposeByProfileId(connectionProfileId: string): Promise<void> {
    const sessionId = this.sessionIdByProfileId.get(connectionProfileId)
    if (!sessionId) return
    await this.disposeSession(sessionId)
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(Array.from(this.sessions.keys()).map((sessionId) => this.disposeSession(sessionId)))
  }

  private async disposeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    this.sessions.delete(sessionId)
    if (session.connectionProfileId) {
      this.sessionIdByProfileId.delete(session.connectionProfileId)
    }

    if (!session.child.killed) {
      session.child.kill("SIGTERM")
      await waitForChildExit(session.child, 2_000).catch(() => {
        if (!session.child.killed) {
          session.child.kill("SIGKILL")
        }
      })
    }
  }

  private async runBootstrapScript(request: SshConnectionBootstrapRequest & { remoteServerPort: number }): Promise<void> {
    const target = buildSshTarget(request)
    const args = [
      "-p",
      String(request.port ?? DEFAULT_SSH_PORT),
      target,
      "sh",
      "-s",
      "--",
      String(request.remoteServerPort),
      request.remotePath?.trim() || "",
    ]

    const prelude = [
      'export CODENOMAD_REMOTE_PORT="$1"',
      'export CODENOMAD_REMOTE_PATH="$2"',
      "shift 2",
      request.bootstrapScript?.trim() || "",
      "",
    ].join("\n")

    await new Promise<void>((resolve, reject) => {
      const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] })
      let stderr = ""
      let stdout = ""

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8")
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8")
      })
      child.once("error", reject)
      child.once("close", (code) => {
        if (code === 0) {
          resolve()
          return
        }
        const detail = stderr.trim() || stdout.trim() || `SSH bootstrap exited with code ${code}`
        reject(new Error(detail))
      })

      child.stdin?.end(prelude)
    })
  }

  private async waitForReachable(baseUrl: string, child: ChildProcess, stderrLines: string[]): Promise<void> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < PROBE_TIMEOUT_MS) {
      if (child.exitCode !== null) {
        throw new Error(stderrLines[stderrLines.length - 1] || "SSH tunnel exited before the remote server became reachable")
      }

      if (await this.isReachable(baseUrl)) {
        return
      }

      await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS))
    }

    throw new Error(stderrLines[stderrLines.length - 1] || "Timed out waiting for the remote server over SSH")
  }

  private async isReachable(baseUrl: string): Promise<boolean> {
    try {
      const response = await fetch(new URL("/api/auth/status", `${baseUrl}/`), {
        method: "GET",
        headers: { Accept: "application/json" },
      })
      if (!response.ok) {
        return false
      }
      const payload = (await response.json()) as { authenticated?: unknown }
      return typeof payload?.authenticated === "boolean"
    } catch {
      return false
    }
  }
}

function buildSshTarget(request: Pick<SshConnectionBootstrapRequest, "host" | "username">): string {
  const host = request.host.trim()
  if (!host) {
    throw new Error("SSH host is required")
  }
  const username = request.username?.trim()
  return username ? `${username}@${host}` : host
}

async function getAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once("error", reject)
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve a local port for SSH tunneling")))
        return
      }

      const port = address.port
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for SSH process to exit")), timeoutMs)
    child.once("exit", () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}
