import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import pino from "pino"

import { EventBus } from "../../events/bus"
import { WorkspaceManager } from "../manager"
import { normalizeWorkspaceIdentityPath, resolveWorkspaceIdentity } from "../workspace-identity"

const temporaryDirectories: string[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

async function createLinkedWorkspace(): Promise<{ root: string; target: string; link: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-workspace-identity-"))
  temporaryDirectories.push(root)
  const target = path.join(root, "target")
  const link = path.join(root, "link")
  await mkdir(target)
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir")
  return { root, target, link }
}

function createManager(rootDir: string): WorkspaceManager {
  const logger = pino({ level: "silent" })
  const manager = new WorkspaceManager({
    rootDir,
    settings: { getOwner: () => ({ environmentVariables: {} }) },
    binaryResolver: {
      resolve: () => ({ path: process.execPath, label: "Node.js", version: process.version }),
    },
    eventBus: new EventBus(logger),
    logger,
    getServerBaseUrl: () => "http://127.0.0.1:3000",
  } as unknown as ConstructorParameters<typeof WorkspaceManager>[0])

  const internal = manager as any
  internal.runtime.launch = async () => ({
    pid: 123,
    port: 4321,
    exitPromise: new Promise(() => {}),
    cancellationPromise: new Promise(() => {}),
    getLastOutput: () => "",
  })
  internal.waitForWorkspaceReadiness = async () => undefined
  return manager
}

describe("workspace identity", () => {
  it("normalizes Windows drive and UNC paths without affecting POSIX case", () => {
    assert.equal(normalizeWorkspaceIdentityPath("C:\\Projects\\CodeNomad\\", "win32"), "c:\\projects\\codenomad\\")
    assert.equal(normalizeWorkspaceIdentityPath(String.raw`\\Server\Share\Repo`, "win32"), String.raw`\\server\share\repo`)
    assert.equal(normalizeWorkspaceIdentityPath("/Projects/CodeNomad/", "linux"), "/Projects/CodeNomad/")
  })

  it("resolves a symlink and its target to the same canonical launch path", async () => {
    const { root, target, link } = await createLinkedWorkspace()
    const targetResult = await resolveWorkspaceIdentity(target, root)
    const linkResult = await resolveWorkspaceIdentity(link, root)

    assert.equal(linkResult.identityKey, targetResult.identityKey)
    assert.equal(linkResult.workspacePath, targetResult.workspacePath)
    assert.notEqual(linkResult.workspacePath, path.normalize(link))
  })

  it("falls back to a normalized absolute identity when realpath fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-workspace-missing-"))
    temporaryDirectories.push(root)
    const result = await resolveWorkspaceIdentity("missing", root)
    const expected = path.resolve(root, "missing")

    assert.equal(result.workspacePath, expected)
    assert.equal(result.identityKey, normalizeWorkspaceIdentityPath(expected))
  })

  it("atomically reuses an active workspace reached through a symlink", async () => {
    const { root, target, link } = await createLinkedWorkspace()
    const manager = createManager(root)
    const [targetResult, linkResult] = await Promise.all([manager.create(target), manager.create(link)])

    assert.equal(Number(targetResult.created) + Number(linkResult.created), 1)
    assert.equal(targetResult.workspace.id, linkResult.workspace.id)
    assert.equal(manager.list().length, 1)
  })

  it("shares an in-flight startup between canonical aliases", async () => {
    const { root, target, link } = await createLinkedWorkspace()
    const manager = createManager(root)
    const launchGate = deferred<void>()
    let launches = 0
    ;(manager as any).runtime.launch = async () => {
      launches += 1
      await launchGate.promise
      return {
        pid: 123,
        port: 4321,
        exitPromise: new Promise(() => {}),
        cancellationPromise: new Promise(() => {}),
        getLastOutput: () => "",
      }
    }

    const firstPromise = manager.create(target, undefined, { requestId: "restore-request" })
    const secondPromise = manager.create(link)
    while (![...(manager as any).pendingWorkspaceCreations.values()][0]?.followerCount) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    launchGate.resolve()
    const [first, second] = await Promise.all([firstPromise, secondPromise])

    assert.equal(launches, 1)
    assert.equal(first.created, false)
    assert.equal(first.workspace.requestId, undefined)
    assert.equal(first.workspace.id, second.workspace.id)
    assert.equal(first.workspace.status, "ready")
    assert.equal(second.workspace.status, "ready")
  })

  it("keeps one cleanup owner when two restore requests share a canonical launch", async () => {
    const { root, target, link } = await createLinkedWorkspace()
    const manager = createManager(root)
    const [first, second] = await Promise.all([
      manager.create(target, undefined, { requestId: "restore-first" }),
      manager.create(link, undefined, { requestId: "restore-second" }),
    ])

    assert.equal(Number(first.created) + Number(second.created), 1)
    assert.equal(first.workspace.id, second.workspace.id)
    assert.ok(first.workspace.requestId === "restore-first" || first.workspace.requestId === "restore-second")
  })

  it("releases a failed identity reservation so creation can be retried", async () => {
    const { root, target, link } = await createLinkedWorkspace()
    const manager = createManager(root)
    const launchGate = deferred<void>()
    let launches = 0
    ;(manager as any).runtime.launch = async () => {
      launches += 1
      await launchGate.promise
      throw new Error("launch failed")
    }

    const firstFailure = manager.create(target)
    const secondFailure = manager.create(link)
    while (![...(manager as any).pendingWorkspaceCreations.values()][0]?.followerCount) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    launchGate.resolve()
    const failed = await Promise.allSettled([firstFailure, secondFailure])
    assert.deepEqual(failed.map((result) => result.status), ["rejected", "rejected"])
    assert.equal(launches, 1)

    ;(manager as any).runtime.launch = async () => ({
      pid: 456,
      port: 5432,
      exitPromise: new Promise(() => {}),
      cancellationPromise: new Promise(() => {}),
      getLastOutput: () => "",
    })
    const retry = await manager.create(target)

    assert.equal(retry.created, true)
    assert.equal(retry.workspace.status, "ready")
  })

  it("allows an explicit second workspace for the same canonical path", async () => {
    const { root, target, link } = await createLinkedWorkspace()
    const manager = createManager(root)
    const [first, second] = await Promise.all([
      manager.create(target, undefined, { forceNew: true }),
      manager.create(link, undefined, { forceNew: true }),
    ])

    assert.equal(first.created, true)
    assert.equal(second.created, true)
    assert.notEqual(first.workspace.id, second.workspace.id)
    assert.equal(manager.list().length, 2)
  })

  it("does not reuse restore-owned workspaces until hydration releases ownership", async () => {
    const { root, target, link } = await createLinkedWorkspace()
    const manager = createManager(root)
    const restore = await manager.create(target, undefined, {
      forceNew: true,
      requestId: "restore-request",
    })

    const concurrent = await manager.create(link)
    assert.equal(concurrent.created, true)
    assert.notEqual(concurrent.workspace.id, restore.workspace.id)

    assert.equal(manager.releaseCreationRequest(restore.workspace.id, "wrong-request"), false)
    assert.equal(manager.releaseCreationRequest(restore.workspace.id, "restore-request"), true)
    assert.equal(manager.releaseCreationRequest(restore.workspace.id, "restore-request"), true)
    await manager.delete(concurrent.workspace.id)
    const reused = await manager.create(link)
    assert.equal(reused.created, false)
    assert.equal(reused.workspace.id, restore.workspace.id)
  })

  it("keeps the canonical reservation when a forced duplicate is deleted", async () => {
    const { root, target, link } = await createLinkedWorkspace()
    const manager = createManager(root)
    const normalLaunch = deferred<{
      pid: number
      port: number
      exitPromise: Promise<never>
      cancellationPromise: Promise<never>
      getLastOutput: () => string
    }>()
    const forcedLaunch = deferred<{
      pid: number
      port: number
      exitPromise: Promise<never>
      cancellationPromise: Promise<never>
      getLastOutput: () => string
    }>()
    let launches = 0
    const launchedWorkspaceIds: string[] = []
    ;(manager as any).runtime.launch = (options: { workspaceId: string }) => {
      launches += 1
      launchedWorkspaceIds.push(options.workspaceId)
      return launches === 1 ? normalLaunch.promise : forcedLaunch.promise
    }

    const first = manager.create(target)
    while (launchedWorkspaceIds.length < 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    const forced = manager.create(link, undefined, { forceNew: true })
    const forcedRejected = assert.rejects(forced, /launch was cancelled/)
    while (launchedWorkspaceIds.length < 2) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    const forcedDeletion = manager.delete(launchedWorkspaceIds[1]!)

    const reused = manager.create(link)
    normalLaunch.resolve({ pid: 123, port: 4321, exitPromise: new Promise(() => {}), cancellationPromise: new Promise(() => {}), getLastOutput: () => "" })
    forcedLaunch.resolve({ pid: 456, port: 5432, exitPromise: new Promise(() => {}), cancellationPromise: new Promise(() => {}), getLastOutput: () => "" })
    await forcedDeletion
    const [firstResult, reusedResult] = await Promise.all([first, reused])

    await forcedRejected
    assert.equal(launches, 2)
    assert.equal(firstResult.workspace.id, reusedResult.workspace.id)
    assert.equal(reusedResult.created, false)
  })

  it("cancels an in-flight startup when its workspace is deleted", async () => {
    const { root, target } = await createLinkedWorkspace()
    const manager = createManager(root)
    const launch = deferred<{
      pid: number
      port: number
      exitPromise: Promise<never>
      cancellationPromise: Promise<never>
      getLastOutput: () => string
    }>()
    let workspaceId = ""
    ;(manager as any).runtime.launch = (options: { workspaceId: string }) => {
      workspaceId = options.workspaceId
      return launch.promise
    }
    const events: any[] = []
    ;(manager as any).options.eventBus.onEvent((event: any) => events.push(event))

    const creation = manager.create(target)
    const creationRejected = assert.rejects(creation, /launch was cancelled/)
    while (!workspaceId) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    const deletion = manager.delete(workspaceId)
    launch.resolve({ pid: 123, port: 4321, exitPromise: new Promise(() => {}), cancellationPromise: new Promise(() => {}), getLastOutput: () => "" })

    await Promise.all([creationRejected, deletion])
    assert.equal(manager.get(workspaceId), undefined)
    assert.equal(events.filter((event) => event.type === "workspace.stopped" && event.workspaceId === workspaceId).length, 1)
  })

  it("waits for and cancels forced creations during shutdown", async () => {
    const { root, target } = await createLinkedWorkspace()
    const manager = createManager(root)
    const launch = deferred<{
      pid: number
      port: number
      exitPromise: Promise<never>
      cancellationPromise: Promise<never>
      getLastOutput: () => string
    }>()
    let workspaceId = ""
    ;(manager as any).runtime.launch = (options: { workspaceId: string }) => {
      workspaceId = options.workspaceId
      return launch.promise
    }

    const creation = manager.create(target, undefined, { forceNew: true })
    const creationRejected = assert.rejects(creation, /launch was cancelled/)
    while (!workspaceId) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    const shutdown = manager.shutdown()
    launch.resolve({ pid: 123, port: 4321, exitPromise: new Promise(() => {}), cancellationPromise: new Promise(() => {}), getLastOutput: () => "" })

    await Promise.all([creationRejected, shutdown])
    assert.equal(manager.list().length, 0)
  })
})
