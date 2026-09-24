import assert from "node:assert/strict"
import { describe, it } from "node:test"
import http from "node:http"
import { PassThrough } from "node:stream"
import { LiveGateway } from "./live-gateway"
import type { AuthManager } from "../auth/manager"
import type { SettingsService } from "../settings/service"
import type { Logger } from "../logger"

function createMockSettings(serverConfig: Record<string, unknown>): SettingsService {
  return {
    getOwner: () => serverConfig,
  } as unknown as SettingsService
}

const mockLogger: Logger = {
  child: () => mockLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger

describe("LiveGateway", () => {
  it("rejects non-websocket upgrade request with 400", async () => {
    const authManager = {
      getSessionFromHeaders: () => ({ username: "test", sessionId: "s1" }),
    } as unknown as AuthManager

    const settings = createMockSettings({ speech: { live: { geminiApiKey: "test" } } })
    const gateway = new LiveGateway({ authManager, settings, logger: mockLogger })

    const req = {
      headers: { upgrade: "not-ws", connection: "upgrade" },
      url: "/api/speech/live/ws",
    } as unknown as http.IncomingMessage

    const socket = new PassThrough()
    let written = ""
    socket.on("data", (chunk) => {
      written += chunk.toString()
    })

    await gateway.handleUpgrade(req, socket as any, Buffer.alloc(0))
    assert.match(written, /HTTP\/1\.1 400 Bad Request/)
  })

  it("rejects unauthorized upgrade request with 401", async () => {
    const authManager = {
      getSessionFromHeaders: () => null,
    } as unknown as AuthManager

    const settings = createMockSettings({ speech: { live: { geminiApiKey: "test" } } })
    const gateway = new LiveGateway({ authManager, settings, logger: mockLogger })

    const req = {
      headers: { upgrade: "websocket", connection: "Upgrade" },
      url: "/api/speech/live/ws",
    } as unknown as http.IncomingMessage

    const socket = new PassThrough()
    let written = ""
    socket.on("data", (chunk) => {
      written += chunk.toString()
    })

    await gateway.handleUpgrade(req, socket as any, Buffer.alloc(0))
    assert.match(written, /HTTP\/1\.1 401 Unauthorized/)
  })

  it("rejects with 502 if upstream API key is unconfigured", async () => {
    const originalEnv = process.env.GEMINI_API_KEY
    delete process.env.GEMINI_API_KEY

    try {
      const authManager = {
        getSessionFromHeaders: () => ({ username: "test", sessionId: "s1" }),
      } as unknown as AuthManager

      const settings = createMockSettings({ speech: { live: { provider: "gemini" } } })
      const gateway = new LiveGateway({ authManager, settings, logger: mockLogger })

      const req = {
        headers: { upgrade: "websocket", connection: "Upgrade" },
        url: "/api/speech/live/ws",
      } as unknown as http.IncomingMessage

      const socket = new PassThrough()
      let written = ""
      socket.on("data", (chunk) => {
        written += chunk.toString()
      })

      await gateway.handleUpgrade(req, socket as any, Buffer.alloc(0))
      assert.match(written, /HTTP\/1\.1 502 Bad Gateway/)
    } finally {
      if (originalEnv) {
        process.env.GEMINI_API_KEY = originalEnv
      }
    }
  })

  it("redacts sensitive query parameter secrets from debug logs", () => {
    const loggedMessages: Array<{ obj: any; msg?: string }> = []
    const recordingLogger: Logger = {
      child: () => recordingLogger,
      info: (obj: any, msg?: string) => loggedMessages.push({ obj, msg }),
      warn: (obj: any, msg?: string) => loggedMessages.push({ obj, msg }),
      error: (obj: any, msg?: string) => loggedMessages.push({ obj, msg }),
      debug: (obj: any, msg?: string) => loggedMessages.push({ obj, msg }),
    } as unknown as Logger

    const authManager = {
      getSessionFromHeaders: () => ({ username: "test", sessionId: "s1" }),
    } as unknown as AuthManager

    const secretKey = "super-secret-gemini-key-12345"
    const settings = createMockSettings({ speech: { live: { geminiApiKey: secretKey } } })
    const gateway = new LiveGateway({ authManager, settings, logger: recordingLogger })

    const req = {
      headers: { upgrade: "websocket", connection: "Upgrade" },
      url: "/api/speech/live/ws?provider=gemini",
    } as unknown as http.IncomingMessage

    const socket = new PassThrough()
    gateway.handleUpgrade(req, socket as any, Buffer.alloc(0))

    for (const record of loggedMessages) {
      const serialized = JSON.stringify(record)
      assert.ok(
        !serialized.includes(secretKey),
        `Found secret key in logged record: ${serialized}`
      )
    }
  })
})
