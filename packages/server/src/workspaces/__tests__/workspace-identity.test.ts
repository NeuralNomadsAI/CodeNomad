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
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

async function createLinkedWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-workspace-identity-"))
  temporaryDirectories.push(root)
  const target = path.join(root, "target")
  const link = path.join(root, "link")
  await mkdir(target)
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir")
  return { root, target, link }
}

function createManager(rootDir: string) {
  const logger = pino({ level: "silent" })
  const sharedService = {
    endpoint: async () => ({ url: "http://127.0.0.1:4321" }),
    client: async () => ({}),
    headers: async () => undefined,
    validateLocation: async ({ directory }: { directory: string }) => ({
      directory,
      project: { id: directory, directory, canonical: directory },
    }),
    subscribe: async () => ({ async *[Symbol.asyncIterator]() {} }),
    evict: async () => undefined,
  }
  const manager = new WorkspaceManager({
    rootDir,
    settings: { getOwner: () => ({ environmentVariables: {} }) },
    binaryResolver: { resolveDefault: () => ({ path: process.execPath, label: "Node.js", version: process.version }) },
    eventBus: new EventBus(logger),
    logger,
    getServerBaseUrl: () => "http://127.0.0.1:3000",
    sharedService,
  } as unknown as ConstructorParameters<typeof WorkspaceManager>[0])
  return manager
}

async function waitForOwners(manager: WorkspaceManager, count: number) {
  while ([...(manager as any).pendingWorkspaceCreations.values()][0]?.ownership.size !== count) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function createSharedLaunch() {
  const { root, target, link } = await createLinkedWorkspace()
  const manager = createManager(root)
  const launchGate = deferred<void>()
  let launches = 0
  ;(manager as any).sharedService.validateLocation = async ({ directory }: { directory: string }) => {
    launches += 1
    await launchGate.promise
    return { directory, project: { id: directory, directory, canonical: directory } }
  }
  const leader = manager.create(target, undefined, { requestId: "leader" })
  const follower = manager.create(link, undefined, { requestId: "follower" })
  await waitForOwners(manager, 2)
  return { manager, launchGate, leader, follower, launches: () => launches }
}

describe("workspace identity", () => {
  it("normalizes Windows paths without affecting POSIX case", () => {
    assert.equal(normalizeWorkspaceIdentityPath("C:\\Projects\\CodeNomad\\", "win32"), "c:\\projects\\codenomad\\")
    assert.equal(normalizeWorkspaceIdentityPath(String.raw`\\Server\Share\Repo`, "win32"), String.raw`\\server\share\repo`)
    assert.equal(normalizeWorkspaceIdentityPath("/Projects/CodeNomad/", "linux"), "/Projects/CodeNomad/")
  })

  it("canonicalizes aliases and falls back to an absolute identity for missing paths", async () => {
    const { root, target, link } = await createLinkedWorkspace()
    const [targetResult, linkResult, missing] = await Promise.all([
      resolveWorkspaceIdentity(target, root),
      resolveWorkspaceIdentity(link, root),
      resolveWorkspaceIdentity("missing", root),
    ])
    const expectedMissing = path.resolve(root, "missing")

    assert.equal(linkResult.identityKey, targetResult.identityKey)
    assert.equal(linkResult.workspacePath, targetResult.workspacePath)
    assert.equal(missing.workspacePath, expectedMissing)
    assert.equal(missing.identityKey, normalizeWorkspaceIdentityPath(expectedMissing))
  })

  it("deduplicates active canonical aliases", async () => {
    const { root, target, link } = await createLinkedWorkspace()
    const manager = createManager(root)
    const [first, second] = await Promise.all([manager.create(target), manager.create(link)])

    assert.equal(Number(first.created) + Number(second.created), 1)
    assert.equal(first.workspace.id, second.workspace.id)
    assert.equal(manager.list().length, 1)
  })

  it("shares one in-flight launch between canonical aliases", async () => {
    const shared = await createSharedLaunch()
    shared.launchGate.resolve()
    const [leader, follower] = await Promise.all([shared.leader, shared.follower])

    assert.equal(shared.launches(), 1)
    assert.equal(leader.workspace.id, follower.workspace.id)
    assert.equal(Number(leader.created) + Number(follower.created), 1)
    assert.equal(leader.workspace.status, "ready")
  })

  for (const cancelledRole of ["leader", "follower"] as const) {
    it(`detaches a cancelled ${cancelledRole} without stopping its shared owner`, async () => {
      const shared = await createSharedLaunch()
      await shared.manager.cancelCreationRequest(cancelledRole)
      shared.launchGate.resolve()
      const cancelled = shared[cancelledRole]
      const survivor = shared[cancelledRole === "leader" ? "follower" : "leader"]

      await assert.rejects(cancelled, new RegExp(`creation request ${cancelledRole} was cancelled`))
      const result = await survivor
      assert.equal(shared.launches(), 1)
      assert.equal(result.workspace.requestId, cancelledRole === "leader" ? "follower" : "leader")
      assert.equal(shared.manager.list().length, 1)
    })
  }

  for (const releasedRole of ["leader", "follower"] as const) {
    it(`retains shared ownership when the ${releasedRole} releases and the other owner cancels`, async () => {
      const shared = await createSharedLaunch()
      shared.launchGate.resolve()
      const [leader, follower] = await Promise.all([shared.leader, shared.follower])
      assert.equal(leader.workspace.id, follower.workspace.id)

      assert.equal(shared.manager.releaseCreationRequest(leader.workspace.id, releasedRole), true)
      await shared.manager.cancelCreationRequest(releasedRole === "leader" ? "follower" : "leader")
      assert.equal(shared.manager.list().length, 1)
      assert.equal(shared.manager.get(leader.workspace.id)?.requestId, undefined)
    })
  }

  it("releases a failed canonical reservation for retry", async () => {
    const { root, target, link } = await createLinkedWorkspace()
    const manager = createManager(root)
    const launchGate = deferred<void>()
    let launches = 0
    ;(manager as any).sharedService.validateLocation = async () => {
      launches += 1
      await launchGate.promise
      throw new Error("launch failed")
    }
    const failures = [
      manager.create(target, undefined, { requestId: "first" }),
      manager.create(link, undefined, { requestId: "second" }),
    ]
    await waitForOwners(manager, 2)
    launchGate.resolve()
    assert.deepEqual((await Promise.allSettled(failures)).map((result) => result.status), ["rejected", "rejected"])
    assert.equal(launches, 1)

    ;(manager as any).sharedService.validateLocation = async ({ directory }: { directory: string }) => ({
      directory,
      project: { id: directory, directory, canonical: directory },
    })
    assert.equal((await manager.create(target)).created, true)
  })

  it("allows forced canonical duplicates without replacing the reusable workspace", async () => {
    const { root, target, link } = await createLinkedWorkspace()
    const manager = createManager(root)
    const normal = await manager.create(target)
    const forced = await manager.create(link, undefined, { forceNew: true })
    assert.notEqual(normal.workspace.id, forced.workspace.id)

    await manager.delete(forced.workspace.id)
    const reused = await manager.create(link)
    assert.equal(reused.created, false)
    assert.equal(reused.workspace.id, normal.workspace.id)
  })
})
