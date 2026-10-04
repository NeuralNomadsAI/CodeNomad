import assert from "node:assert/strict"
import { tsImport } from "tsx/esm/api"
import Fastify from "fastify"
import pino from "pino"
import { OpenCode } from "@opencode/client"
import { freshSettings } from "../missions-authority-spike/broker.mjs"
import { AsyncLocalStorage } from "node:async_hooks"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { childAdmission } from "./admission.mjs"
import { CHILD_ENV_RPC } from "./schema.mjs"

export async function ownedBackend({ root, project, cli, running, settingsFile, token, observations, deadline }) {
  const { WorkspaceManager } = await tsImport("../../packages/server/src/workspaces/manager.ts", import.meta.url)
  const { EventBus } = await tsImport("../../packages/server/src/events/bus.ts", import.meta.url)
  const { rememberRuntime } = await tsImport("../../packages/server/src/opencode/compatibility/runtime.ts", import.meta.url)
  const { registerInstanceProxyRoutes } = await tsImport("../../packages/server/src/server/http-server.ts", import.meta.url)
  const { WorktreeDeletionFence } = await tsImport("../../packages/server/src/workspaces/worktree-session-evacuation.ts", import.meta.url)
  const { DesktopPluginLifecycle } = await tsImport("../../packages/server/src/opencode/desktop-plugin-lifecycle.ts", import.meta.url)
  const { resolveDesktopPluginPaths } = await tsImport("../../packages/server/src/opencode/desktop-plugin-paths.ts", import.meta.url)
  const { createAutomationBridgeRegistration, publishAutomationBridge } = await tsImport("../../packages/server/src/opencode/automation-plugin.ts", import.meta.url)
  const { registerAutomationPluginRoute } = await tsImport("../../packages/server/src/server/routes/automation-plugin.ts", import.meta.url)
  const { AuthManager } = await tsImport("../../packages/server/src/auth/manager.ts", import.meta.url)
  const endpoint = { url: running.url, auth: { type: "basic", username: "opencode", password: process.env.OPENCODE_SERVER_PASSWORD } }
  rememberRuntime(endpoint, { version: running.info.version, pid: running.info.pid, discovery: "info" })
  const logger = pino({ level: "silent" })
  const scope = new AsyncLocalStorage(), defaults = freshSettings(settingsFile, observations)
  const settings = { getOwner: (...args) => defaults.getOwner(...args),
    readEnvironmentForAdmission: signal => freshSettings(scope.getStore() ?? settingsFile, observations).readEnvironmentForAdmission(signal) }
  const manager = new WorkspaceManager({ rootDir: root, logger, eventBus: new EventBus(), settings,
    binaryResolver: { resolveDefault: () => ({ path: cli, label: "Assigned private child environment fixture" }) },
    hostServiceLifecycleFactory: () => ({ discover: async () => endpoint, ensure: async () => endpoint }) })
  const app = Fastify({ logger: false })
  const bridge = Fastify({ logger: false })
  const password = randomUUID()
  const authManager = new AuthManager({ configPath: path.join(root, "backend-config.yaml"), username: "fixture", password, generateToken: false }, logger)
  assert(authManager.validateLogin("fixture", password))
  const authSession = authManager.createSession("fixture")
  const cookie = `${authManager.getCookieName()}=${authSession.id}`
  let removeBridge, presence, admission
  const detach = async () => {
    admission?.dispose()
    await removeBridge?.(); removeBridge = undefined
    await bridge.close()
    await presence?.stop(); presence = undefined
    await app.close()
  }
  try {
    const { workspace } = await manager.create(project)
    assert(await manager.ownsLocation(workspace.id, { directory: project }), "Real canonical workspace ownership required")
    app.addHook("preHandler", async (request, reply) => {
      if (!authManager.isLoopbackRequest(request) || !authManager.getSessionFromRequest(request)) return reply.code(403).send({ code: "private-only" })
    })
    const fence = new WorktreeDeletionFence()
    registerInstanceProxyRoutes(app, { workspaceManager: manager, logger, worktreeDeletionFence: fence })
    admission = childAdmission({ app, authManager, manager, workspace, fence, scope, defaultFile: settingsFile, rpcSchema: CHILD_ENV_RPC, deadline })
    await app.listen({ host: "127.0.0.1", port: 0 })
    const proxy = OpenCode.make({ baseUrl: `http://127.0.0.1:${app.server.address().port}/workspaces/${workspace.id}/instance/`,
      headers: { "x-private-fixture": token, cookie } })
    await writeFile(path.join(root, "child-admission-seed.json"), JSON.stringify({ url: `http://127.0.0.1:${app.server.address().port}/private/child-environment`, cookie, deadline }), { mode: 0o600 })
    const registration = createAutomationBridgeRegistration("http://127.0.0.1:1")
    registerAutomationPluginRoute(bridge, { workspaceManager: manager, worktreeDeletionFence: fence,
      authManager,
      bridgeToken: registration.token, nativeParent: {}, developerCdp: {} })
    await bridge.listen({ host: "127.0.0.1", port: 0 })
    registration.url = `http://127.0.0.1:${bridge.server.address().port}/api/opencode-plugin/automation`
    removeBridge = await publishAutomationBridge(registration)
    const paths = await resolveDesktopPluginPaths({ client: running.client, assertCurrent() {} }, { kind: "host", platform: process.platform, binary: cli })
    assert.equal(paths.config, process.env.OPENCODE_CONFIG_DIR)
    presence = new DesktopPluginLifecycle("missions")
    await presence.start(paths)
    return { proxy, manager, workspace, admission, detach, close: async () => { await detach(); await manager.shutdown() } }
  } catch (error) { await Promise.allSettled([detach(), manager.shutdown()]); throw error }
}
