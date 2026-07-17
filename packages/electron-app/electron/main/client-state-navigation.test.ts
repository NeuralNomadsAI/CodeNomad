import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  ClientStateIPCHandlers,
  createClientStateIPCHandlers,
  createRendererAccessNavigationCommitHandler,
} from "./client-state-ipc-handlers"
import { ClientStateNavigationController } from "./client-state-navigation"
import { ClientStateManager } from "./client-state"

test("edit then immediate reload persists the latest snapshot and rotates renderer access", async (testContext) => {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-client-state-navigation-"))
  const manager = new ClientStateManager(directory)
  const handlers: ClientStateIPCHandlers = createClientStateIPCHandlers(manager)
  testContext.after(async () => {
    await manager.drainAndReleasePrimary().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })

  handlers.claimAccess("outgoing-document")
  let navigated = false
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      getURL: () => "http://127.0.0.1:3000/app",
      executeJavaScript: async () => {
        await handlers.save("outgoing-document", { revision: 7, editor: "latest" })
      },
    },
  }
  const controller = new ClientStateNavigationController({
    clientStateManager: manager,
    getWindow: () => window as never,
    isTrustedOrigin: () => true,
    reportFlushError: (error) => assert.fail(String(error)),
  })
  const commitNavigation = createRendererAccessNavigationCommitHandler(manager, () => true)

  await controller.navigate(async () => {
    navigated = true
    assert.deepEqual(handlers.load("outgoing-document").snapshot, { revision: 7, editor: "latest" })
    commitNavigation("http://127.0.0.1:3000/app", false, true)
  })

  assert.equal(navigated, true)
  assert.throws(() => handlers.load("outgoing-document"), /has not been claimed/)
  handlers.claimAccess("new-document")
  assert.deepEqual(handlers.load("new-document").snapshot, { revision: 7, editor: "latest" })
})

test("failed loadURL retains access for the current document", async (testContext) => {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-client-state-navigation-failure-"))
  const manager = new ClientStateManager(directory)
  const handlers = createClientStateIPCHandlers(manager)
  testContext.after(async () => {
    await manager.drainAndReleasePrimary().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })
  handlers.claimAccess("current-document")

  const controller = new ClientStateNavigationController({
    clientStateManager: manager,
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        getURL: () => "http://127.0.0.1:3000/app",
        executeJavaScript: async () => {},
      },
    }) as never,
    isTrustedOrigin: () => true,
    reportFlushError: (error) => assert.fail(String(error)),
  })

  await assert.rejects(controller.navigate(() => Promise.reject(new Error("loadURL failed"))), /loadURL failed/)
  assert.equal(await handlers.save("current-document", { retained: "after-loadURL" }), true)
  assert.deepEqual(handlers.load("current-document").snapshot, { retained: "after-loadURL" })
})

test("failed reload retains access for the current document", async (testContext) => {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-client-state-reload-failure-"))
  const manager = new ClientStateManager(directory)
  const handlers = createClientStateIPCHandlers(manager)
  testContext.after(async () => {
    await manager.drainAndReleasePrimary().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })
  handlers.claimAccess("current-document")

  const controller = new ClientStateNavigationController({
    clientStateManager: manager,
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        getURL: () => "http://127.0.0.1:3000/app",
        executeJavaScript: async () => {},
      },
    }) as never,
    isTrustedOrigin: () => true,
    reportFlushError: (error) => assert.fail(String(error)),
  })

  await assert.rejects(controller.navigate(() => { throw new Error("reload failed") }), /reload failed/)
  assert.equal(await handlers.save("current-document", { retained: "after-reload" }), true)
})

test("hung renderer flush is bounded and does not deadlock reload", async () => {
  const manager = {
    isPrimary: true,
    resetRendererAccessTokenCalls: 0,
    resetRendererAccessToken() {
      this.resetRendererAccessTokenCalls += 1
    },
  }
  let navigated = false
  let reported = false
  const controller = new ClientStateNavigationController({
    clientStateManager: manager,
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        getURL: () => "http://127.0.0.1:3000/app",
        executeJavaScript: () => new Promise(() => {}),
      },
    }) as never,
    isTrustedOrigin: () => true,
    reportFlushError: () => {
      reported = true
    },
  })

  const startedAt = Date.now()
  await controller.navigate(() => {
    navigated = true
  })
  const elapsedMs = Date.now() - startedAt

  assert.equal(reported, true)
  assert.equal(manager.resetRendererAccessTokenCalls, 0)
  assert.equal(navigated, true)
  assert.ok(elapsedMs >= 900, `flush timeout ended too early after ${elapsedMs}ms`)
  assert.ok(elapsedMs < 2_000, `flush timeout was not bounded: ${elapsedMs}ms`)
})
