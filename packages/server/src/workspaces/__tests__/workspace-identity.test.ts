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
      resolveDefault: () => ({ path: process.execPath, label: "Node.js", version: process.version }),
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
    let launches = 0
    ;(manager as any).runtime.launch = async () => {
      launches += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return {
        pid: 123,
        port: 4321,
        exitPromise: new Promise(() => {}),
        getLastOutput: () => "",
      }
    }

    const [first, second] = await Promise.all([manager.create(target), manager.create(link)])

    assert.equal(launches, 1)
    assert.equal(Number(first.created) + Number(second.created), 1)
    assert.equal(first.workspace.id, second.workspace.id)
    assert.equal(first.workspace.status, "ready")
    assert.equal(second.workspace.status, "ready")
  })

  it("releases a failed identity reservation so creation can be retried", async () => {
    const { root, target, link } = await createLinkedWorkspace()
    const manager = createManager(root)
    let launches = 0
    ;(manager as any).runtime.launch = async () => {
      launches += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      throw new Error("launch failed")
    }

    const failed = await Promise.allSettled([manager.create(target), manager.create(link)])
    assert.deepEqual(failed.map((result) => result.status), ["rejected", "rejected"])
    assert.equal(launches, 1)

    ;(manager as any).runtime.launch = async () => ({
      pid: 456,
      port: 5432,
      exitPromise: new Promise(() => {}),
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

  it("keeps the canonical reservation when a forced duplicate is deleted", async () => {
    const { root, target, link } = await createLinkedWorkspace()
    const manager = createManager(root)
    const normalLaunch = deferred<{
      pid: number
      port: number
      exitPromise: Promise<never>
      getLastOutput: () => string
    }>()
    const forcedLaunch = deferred<{
      pid: number
      port: number
      exitPromise: Promise<never>
      getLastOutput: () => string
    }>()
    let launches = 0
    ;(manager as any).runtime.launch = () => {
      launches += 1
      return launches === 1 ? normalLaunch.promise : forcedLaunch.promise
    }

    const first = manager.create(target)
    while (manager.list().length < 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    const forced = manager.create(link, undefined, { forceNew: true })
    const forcedRejected = assert.rejects(forced, /Workspace creation cancelled/)
    while (manager.list().length < 2) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    const forcedWorkspace = manager.list().find((workspace) => workspace.id !== manager.list()[0].id)!
    await manager.delete(forcedWorkspace.id)

    const reused = manager.create(link)
    normalLaunch.resolve({ pid: 123, port: 4321, exitPromise: new Promise(() => {}), getLastOutput: () => "" })
    forcedLaunch.resolve({ pid: 456, port: 5432, exitPromise: new Promise(() => {}), getLastOutput: () => "" })
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
      getLastOutput: () => string
    }>()
    ;(manager as any).runtime.launch = () => launch.promise
    const events: any[] = []
    ;(manager as any).options.eventBus.onEvent((event: any) => events.push(event))

    const creation = manager.create(target)
    const creationRejected = assert.rejects(creation, /Workspace creation cancelled/)
    while (manager.list().length === 0) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    const workspaceId = manager.list()[0].id
    await manager.delete(workspaceId)
    launch.resolve({ pid: 123, port: 4321, exitPromise: new Promise(() => {}), getLastOutput: () => "" })

    await creationRejected
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
      getLastOutput: () => string
    }>()
    ;(manager as any).runtime.launch = () => launch.promise

    const creation = manager.create(target, undefined, { forceNew: true })
    const creationRejected = assert.rejects(creation, /Workspace creation cancelled/)
    while (manager.list().length === 0) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    const shutdown = manager.shutdown()
    launch.resolve({ pid: 123, port: 4321, exitPromise: new Promise(() => {}), getLastOutput: () => "" })

    await Promise.all([creationRejected, shutdown])
    assert.equal(manager.list().length, 0)
  })
})
