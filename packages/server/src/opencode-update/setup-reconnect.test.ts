import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import pino from "pino"
import type { OpenCodeClient } from "@opencode/client"
import { Service, type Endpoint } from "@opencode/client/service"
import { EventBus } from "../events/bus"
import { rememberRuntime } from "../opencode/compatibility/runtime"
import { WorkspaceManager } from "../workspaces/manager"
import { OpenCodeSharedService, type OpenCodeServiceLifecycle } from "../workspaces/opencode-service"
import { OpenCodeUpdateService } from "./service"

test("optional setup rebinds real workspace ownership without restarting the supported older daemon", async () => {
  const parent = path.join(os.tmpdir(), "opencode")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "codenomad-setup-reconnect-"))
  const originalBinary = path.join(root, "2.0.11", "opencode.exe")
  const installedBinary = path.join(root, "2.0.12", "opencode.exe")
  let selected = originalBinary
  let starts = 0
  let restarts = 0
  let reloads = 0
  const endpoint: Endpoint = { url: "http://127.0.0.1:1" }
  rememberRuntime(endpoint, { version: "2.0.11", pid: 123, discovery: "info" })
  const lifecycle: OpenCodeServiceLifecycle = {
    discover: async () => endpoint,
    ensure: async () => { starts++; throw new Error("The existing daemon must not be started again") },
    restart: async () => { restarts++; throw new Error("Restart requires a separate explicit action") },
  }
  const validatedDirectories: string[] = []
  const client = {
    location: { reload: async () => { reloads++ }, get: async ({ location }: { location: { directory: string } }) => {
      validatedDirectories.push(location.directory)
      return { directory: location.directory,
        project: { id: "fixture", directory: location.directory, canonical: location.directory } }
    } },
  } as unknown as OpenCodeClient
  const sharedService = new OpenCodeSharedService({
    headers: Service.headers,
    makeClient: () => client,
  })
  const manager = new WorkspaceManager({
    rootDir: root,
    settings: { getOwner: () => ({ environmentVariables: {} }) } as never,
    binaryResolver: { resolveDefault: () => ({ path: selected, label: "Fixture OpenCode" }) } as never,
    eventBus: new EventBus(),
    logger: pino({ level: "silent" }),
    sharedService,
    hostServiceLifecycleFactory: () => lifecycle,
  })
  const updater = new OpenCodeUpdateService({
    resolveBinary: () => ({ path: selected, label: "Fixture OpenCode" }),
    probeBinary: binary => ({ valid: true, version: binary === installedBinary ? "2.0.12" : "2.0.11" }),
    resolveLatestVersion: async () => "2.0.12",
    canUpgradeBinary: () => true,
    upgradeBinary: async () => {
      selected = installedBinary
      return { success: true, version: "2.0.12" }
    },
    lifecycle: async binary => (await manager.setupServiceOptions(binary.path)).lifecycle,
    admitActivation: binary => manager.assertSetupExecutionHost(binary.path),
    reconnect: binary => manager.reconnectAfterSetup(binary.path),
    reload: (binary, assertCurrent) => manager.reloadConfigurationAfterSetup(binary.path, assertCurrent),
  })

  try {
    const first = await manager.create(path.join(root, "first"))
    const originalConnection = await sharedService.acquire()
    await updater.upgrade()
    assert.equal((await updater.getStatus()).serviceState, "restart_available")

    // Reproduce why simply returning after installation is insufficient: the
    // resolver now selects the new executable, but client ownership is pinned.
    const nextFolder = path.join(root, "second")
    await assert.rejects(manager.create(nextFolder), /OpenCode service identity cannot change/)

    const status = await updater.start(false)
    assert.equal(status.state, "ready")
    assert.equal(status.currentVersion, "2.0.12")
    assert.equal(status.daemonVersion, "2.0.11")
    assert.equal(status.serviceState, "restart_available")
    assert.equal(status.canRestart, true, "non-disruptive reconnect retains explicit activation")
    assert.throws(() => originalConnection.assertCurrent(), /OpenCode connection changed/)

    const second = await manager.create(nextFolder)
    assert.equal(second.workspace.status, "ready")
    assert.equal(second.workspace.binaryId, installedBinary)
    assert.equal(manager.list().find(workspace => workspace.id === first.workspace.id)?.binaryId, installedBinary)
    assert.equal(manager.list().length, 2, "the failed open did not leak a workspace")
    assert.ok(validatedDirectories.includes(nextFolder))
    assert.equal(starts, 0)
    assert.equal(restarts, 0)
    assert.equal(reloads, 0, "ordinary setup must never rebuild shared native locations")
    await updater.reload()
    assert.equal(reloads, 1, "an explicit reload reaches the admitted native client")
    assert.equal(starts, 0)
    assert.equal(restarts, 0)
  } finally {
    try { await manager.shutdown() }
    finally { await rm(root, { recursive: true, force: true }) }
  }
})
