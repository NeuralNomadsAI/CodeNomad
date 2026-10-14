import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { it } from "node:test"
import pino from "pino"
import { parseCliOptions } from "../../index"
import { AuthManager } from "../../auth/manager"
import { createHttpServer } from "../http-server"

for (const value of ["false", "1"]) {
  it(`CODENOMAD_SKIP_AUTH=${value} preserves the parsed auth policy through real HTTP routes`, async () => {
    const originalEnv = process.env
    let options: ReturnType<typeof parseCliOptions>
    try {
      process.env = { ...originalEnv, CODENOMAD_SKIP_AUTH: value }
      for (const name of ["CODENOMAD_GENERATE_TOKEN", "CLI_UNRESTRICTED_ROOT", "CLI_UI_NO_UPDATE", "CLI_LAUNCH"]) {
        delete process.env[name]
      }
      options = parseCliOptions(["--https", "false", "--http", "true", "--password", "x"])
    } finally {
      process.env = originalEnv
    }
    const tempRoot = path.join(os.tmpdir(), "opencode")
    await fs.mkdir(tempRoot, { recursive: true })
    const directory = await fs.mkdtemp(path.join(tempRoot, "codenomad-auth-boolean-"))
    const logger = pino({ level: "silent" })
    const authManager = new AuthManager({
      configPath: path.join(directory, "config.yaml"), username: options.authUsername,
      password: options.authPassword, cookieName: options.authCookieName,
      generateToken: options.generateToken, dangerouslySkipAuth: options.dangerouslySkipAuth,
    }, logger)
    const stub = new Proxy({}, { get: () => () => undefined }) as never
    const { instance: app } = createHttpServer({
      bindHost: "127.0.0.1", bindPort: 0, defaultPort: 0, protocol: "http",
      workspaceManager: stub, settings: stub, fileSystemBrowser: stub, eventBus: stub,
      serverMeta: { localUrl: "http://localhost:0", eventsUrl: "/api/events", listeningMode: "local", localPort: 0, hostLabel: "test", workspaceRoot: directory, addresses: [] } as never,
      instanceStore: stub, speechService: stub, sidecarManager: stub, previewManager: stub,
      clientConnectionManager: stub, remoteProxySessionManager: stub, yoloManager: stub,
      authManager, logger, nativeParent: stub, automationBridgeToken: "fixture-token",
      remoteControlManager: stub, uiStaticDir: directory,
    })
    app.get("/api/test/protected", async () => ({ ok: true }))
    try {
      const protectedResponse = await app.inject({ method: "GET", url: "/api/test/protected" })
      assert.equal(protectedResponse.statusCode, value === "false" ? 401 : 200)
      const status = await app.inject({ method: "GET", url: "/api/auth/status" })
      assert.equal(status.statusCode, 200)
      if (value === "false") assert.deepEqual(status.json(), { authenticated: false })
      else assert.equal(status.json().authenticated, true)
    } finally {
      await app.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
}
