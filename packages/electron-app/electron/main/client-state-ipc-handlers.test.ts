import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ClientStateManager } from "./client-state"
import {
  createClientStateIPCHandlers,
  shouldResetRendererAccessTokenForNavigation,
} from "./client-state-ipc-handlers"

test("only trusted full main-frame navigation resets renderer access", () => {
  const trusted = (url: string) => new URL(url).origin === "http://127.0.0.1:3000"

  assert.equal(
    shouldResetRendererAccessTokenForNavigation("http://127.0.0.1:3000/reload", false, true, trusted),
    true,
  )
  assert.equal(
    shouldResetRendererAccessTokenForNavigation("http://127.0.0.1:3000/frame", false, false, trusted),
    false,
  )
  assert.equal(
    shouldResetRendererAccessTokenForNavigation("http://127.0.0.1:3000/#route", true, true, trusted),
    false,
  )
  assert.equal(
    shouldResetRendererAccessTokenForNavigation("https://untrusted.example/reload", false, true, trusted),
    false,
  )
})

test("client-state handlers require the claimed nonempty renderer token", async (testContext) => {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-client-state-ipc-"))
  const manager = new ClientStateManager(directory)
  const handlers = createClientStateIPCHandlers(manager)
  testContext.after(async () => {
    await manager.drainAndReleasePrimary().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })

  assert.throws(() => handlers.claimAccess(""), /nonempty string/)
  assert.throws(() => handlers.load("not-claimed"), /has not been claimed/)
  assert.equal(handlers.claimAccess("trusted-renderer-token"), true)
  assert.equal(handlers.claimAccess("trusted-renderer-token"), true)
  assert.throws(() => handlers.claimAccess("child-frame-token"), /does not match/)

  for (const invoke of [
    () => handlers.load("child-frame-token"),
    () => handlers.save("child-frame-token", { denied: true }),
    () => handlers.setRestoreEnabled("child-frame-token", false),
    () => handlers.clear("child-frame-token"),
  ]) {
    assert.throws(invoke, /has not been claimed/)
  }

  assert.equal(await handlers.save("trusted-renderer-token", { shutdownFlush: true }), true)
  assert.deepEqual(handlers.load("trusted-renderer-token").snapshot, { shutdownFlush: true })
})

test("trusted renderer navigation reset invalidates the old token before a new claim", async (testContext) => {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-client-state-token-reset-"))
  const manager = new ClientStateManager(directory)
  const handlers = createClientStateIPCHandlers(manager)
  testContext.after(async () => {
    await manager.drainAndReleasePrimary().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })

  handlers.claimAccess("first-document")
  manager.resetRendererAccessToken()

  assert.throws(() => handlers.load("first-document"), /has not been claimed/)
  assert.equal(handlers.claimAccess("reloaded-document"), true)
  assert.equal(handlers.load("reloaded-document").isPrimary, true)
})
