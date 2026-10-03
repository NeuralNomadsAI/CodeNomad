// Reuses the isolated CLI/database/config runner; never discovers a shared daemon.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { register } from "tsx/esm/api"
import pino from "pino"
import { runIsolated } from "./test-opencode-location-native.mjs"

export async function testNativePermissionReceiptRecovery({ client, connection, root }) {
  // One loader namespace preserves the production event-provenance WeakMap.
  const loader = register({ namespace: "permission-receipts-native" })
  const { WorkspaceManager } = await loader.import("../packages/server/src/workspaces/manager.ts", import.meta.url)
  const { EventBus } = await loader.import("../packages/server/src/events/bus.ts", import.meta.url)
  const { PermissionReceipts } = await loader.import("../packages/server/src/permissions/receipts.ts", import.meta.url)
  const { PermissionReceiptStore } = await loader.import("../packages/server/src/permissions/receipt-store.ts", import.meta.url)
  const { nativeEventConnections } = await loader.import("../packages/server/src/workspaces/opencode-service.ts", import.meta.url)
  const { InstanceEventBridge } = await loader.import("../packages/server/src/workspaces/instance-events.ts", import.meta.url)
  const repo = path.join(root, "receipt-project"), worktree = path.join(root, "receipt-worktree")
  await mkdir(repo)
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" })
  git("init"); git("config", "user.name", "Receipt fixture"); git("config", "user.email", "fixture@example.invalid")
  await mkdir(path.join(repo, "packages", "app"), { recursive: true })
  await writeFile(path.join(repo, "packages", "app", "fixture.txt"), "synthetic fixture\n")
  git("add", "."); git("commit", "-m", "fixture"); git("worktree", "add", "-b", "receipt-fixture", worktree)
  const locations = await Promise.all([repo, worktree, path.join(repo, "packages", "app"), path.join(worktree, "packages", "app")]
    .map(directory => client.location.get({ location: { directory } })))
  const bus = new EventBus(), logger = pino({ level: "silent" })
  let refreshes = 0
  const managerClient = { ...client, worktree: { ...client.worktree, refresh: async (...args) => {
    refreshes++; return client.worktree.refresh(...args)
  } } }
  const manager = new WorkspaceManager({ rootDir: root, settings: { getOwner: () => ({ environmentVariables: {} }) },
    binaryResolver: { resolveDefault: () => ({ path: process.execPath, label: "Isolated receipt fixture" }) },
    eventBus: bus, logger,
    sharedService: { client: async () => managerClient, acquire: async () => connection, headers: async () => ({}),
      subscribe: async options => (async function* () {
        for await (const event of client.event.subscribe(options)) {
          nativeEventConnections.set(event, connection)
          yield event
        }
      })(),
      validateLocation: async location => client.location.get({ location }), shutdown: async () => {} },
  })
  const { workspace } = await manager.create(repo)
  const storePath = path.join(root, "receipt-store")
  const receipts = new PermissionReceipts(new PermissionReceiptStore(storePath), manager, bus, logger)
  const sessions = [], creations = [], requests = []
  let bridge, connected = false, streamError
  bus.on("instance.eventStatus", event => {
    connected = event.status === "connected"
    if (event.status === "error") streamError = new Error(event.reason)
  })
  const until = async predicate => {
    const deadline = Date.now() + 15_000
    while (!await predicate()) {
      if (streamError) throw streamError
      assert.ok(Date.now() < deadline, "receipt recovery timed out")
      await delay(20)
    }
  }
  try {
    for (let generation = 1; generation <= 2; generation++) {
      // Initial attachment and reconnect both miss the native asked events.
      for (const [index, location] of locations.entries()) {
        const session = await client.session.create({ location: { directory: location.directory },
          permissions: [{ action: "receipt_fixture", resource: "*", effect: "ask" }] })
        sessions.push(session)
        const source = { type: "tool", messageID: `msg_receipt_fixture_${generation}_${index}`, id: `call_${generation}_${index}` }
        const resource = `synthetic-${generation}-${index}`
        const creating = client.permission.create({ sessionID: session.id, action: "receipt_fixture", resources: [resource], source })
        creations.push(creating.catch(() => {}))
        let pending
        await until(async () => { pending = (await client.permission.list({ sessionID: session.id }))[0]; return pending })
        requests.push({ ...pending, expectedResource: resource, expectedSource: source })
      }
      const unscoped = await client.permission.request.list()
      assert.ok(requests.every(request => !unscoped.data.some(value => value.id === request.id)), "daemon cwd must not contain project requests")
      const nested = requests.slice(-2)
      for (const location of locations.slice(0, 2)) {
        const rootPending = await client.permission.request.list({ location: { directory: location.directory } })
        assert.ok(nested.every(request => !rootPending.data.some(value => value.id === request.id)), "root lists must not cover descendant Location permissions")
      }
      const beforeRecovery = refreshes
      receipts.start()
      bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus, logger })
      bus.publish({ type: "workspace.started", workspace })
      await until(() => connected)
      await receipts.stop() // Drain the initial/reconnect snapshot before external decisions.
      assert.equal(refreshes, beforeRecovery, "recovery must use registered inventory without native strategy discovery")
      receipts.start()
      for (const request of requests.slice(-locations.length)) {
        await client.permission.reply({ sessionID: request.sessionID, requestID: request.id, decision: "once" })
        await until(async () => (await receipts.list(workspace.id, request.sessionID, { messageId: request.source.messageID })).receipts.length === 1)
      }
      await receipts.stop()
      bridge.shutdown()
    }
    const reload = new PermissionReceipts(new PermissionReceiptStore(storePath), manager, bus, logger)
    for (const request of requests) {
      const [receipt] = (await reload.list(workspace.id, request.sessionID, { messageId: request.source.messageID })).receipts
      assert.equal(receipt.origin, "native")
      assert.equal(receipt.action, "receipt_fixture")
      assert.deepEqual(receipt.resources, [request.expectedResource])
      assert.deepEqual(receipt.source, { messageId: request.expectedSource.messageID, callId: request.expectedSource.id })
    }
    console.log("PASS: isolated native initial/reconnect permission recovery across project + worktree roots AND descendants, external replies and reload persistence")
  } finally {
    await receipts.stop()
    bridge?.shutdown()
    await Promise.allSettled(sessions.map(session => client.session.remove({ sessionID: session.id })))
    await Promise.allSettled(creations)
    await manager.shutdown()
    await loader.unregister()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runIsolated(process.argv[2], testNativePermissionReceiptRecovery)
}
