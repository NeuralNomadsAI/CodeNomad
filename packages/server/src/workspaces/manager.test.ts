import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { LocationRef, OpenCodeClient, OpenCodeEvent } from "@opencode-ai/client"
import pino from "pino"

import { EventBus } from "../events/bus"
import {
  WorkspaceLaunchCancelledError,
  WorkspaceManager,
  WorkspaceShutdownError,
} from "./manager"
import type { OpenCodeEnsureOptions } from "./opencode-service"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class ControlledSharedService {
  readonly validationStarted = deferred<void>()
  validationGate?: ReturnType<typeof deferred<void>>
  validationCalls: Array<{ location: LocationRef; options?: OpenCodeEnsureOptions }> = []
  evictions: LocationRef[] = []
  failEvictions = 0

  async endpoint() {
    return { url: "http://127.0.0.1:4321", auth: { type: "basic" as const, username: "user", password: "pass" } }
  }

  async client() {
    return {} as OpenCodeClient
  }

  async headers() {
    return { authorization: "Basic token" }
  }

  async validateLocation(location: LocationRef, requestOptions?: { signal?: AbortSignal }, options?: OpenCodeEnsureOptions) {
    this.validationCalls.push({ location, options })
    this.validationStarted.resolve()
    if (this.validationGate) {
      await Promise.race([
        this.validationGate.promise,
        new Promise<never>((_resolve, reject) => {
          const cancel = () => reject(requestOptions?.signal?.reason)
          requestOptions?.signal?.addEventListener("abort", cancel, { once: true })
          if (requestOptions?.signal?.aborted) cancel()
        }),
      ])
    }
    return {
      directory: location.directory,
      workspaceID: location.workspaceID ?? "location-1",
      project: { id: "project-1", directory: location.directory, canonical: location.directory },
    }
  }

  async subscribe(): Promise<AsyncIterable<OpenCodeEvent>> {
    return { async *[Symbol.asyncIterator]() {} }
  }

  async evict(location: LocationRef) {
    if (this.failEvictions-- > 0) throw new Error("controlled eviction failure")
    this.evictions.push(location)
  }

  async shutdown() {}
}

function createHarness(service = new ControlledSharedService(), overrides: Record<string, unknown> = {}) {
  const eventBus = new EventBus()
  const stopped: string[] = []
  eventBus.on("workspace.stopped", (event) => stopped.push(event.workspaceId))
  const manager = new WorkspaceManager({
    rootDir: process.cwd(),
    settings: { getOwner: () => ({ environmentVariables: { OPENCODE_DB: path.join(os.tmpdir(), "user-opencode.db") } }) } as never,
    binaryResolver: { resolveDefault: () => ({ path: process.execPath, label: "OpenCode V2" }) } as never,
    eventBus,
    logger: pino({ level: "silent" }),
    sharedService: service,
    ...overrides,
  })
  return { manager, service, stopped }
}

describe("workspace manager shared service lifecycle", () => {
  it("uses bounded WSL mappings for root and real git worktree ownership", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "codenomad-wsl-ownership-"))
    const repo = path.join(base, "repo")
    const worktree = path.join(base, "feature")
    execFileSync("git", ["init", repo], { stdio: "ignore", timeout: 5_000 })
    await writeFile(path.join(repo, "tracked.txt"), "tracked")
    execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore", timeout: 5_000 })
    execFileSync("git", ["-C", repo, "-c", "user.name=CodeNomad", "-c", "user.email=test@example.com", "commit", "-m", "initial"], {
      stdio: "ignore",
      timeout: 5_000,
    })
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "feature", worktree], { stdio: "ignore", timeout: 5_000 })
    const service = new ControlledSharedService()
    const servicePaths = new Map([[repo, "/service/repo"], [worktree, "/service/feature"]])
    const hostPaths = new Map(Array.from(servicePaths, ([host, servicePath]) => [servicePath, host]))
    const { manager } = createHarness(service, {
      rootDir: base,
      platform: "win32",
      binaryResolver: {
        resolveDefault: () => ({ path: String.raw`\\wsl.localhost\Ubuntu\home\dev\opencode`, label: "OpenCode V2" }),
      },
      wslServiceDirectoryResolver: (directory: string, _distro: string, timeoutMs: number) => {
        assert.ok(timeoutMs > 0 && timeoutMs <= 30_000)
        return servicePaths.get(directory) ?? null
      },
      wslHostDirectoryResolver: (directory: string, _distro: string, timeoutMs: number) => {
        assert.ok(timeoutMs > 0 && timeoutMs <= 30_000)
        return hostPaths.get(directory) ?? null
      },
    })
    try {
      const { workspace } = await manager.create(repo)
      assert.equal(manager.getServiceDirectory(workspace.id), "/service/repo")
      assert.equal(await manager.ownsDirectory(workspace.id, "/service/repo"), true)
      assert.equal(await manager.ownsDirectory(workspace.id, "/service/feature"), true)
      assert.equal(await manager.ownsDirectory(workspace.id, "/service/foreign"), false)
      assert.equal(await manager.getServiceDirectoryForPath(workspace.id, worktree), "/service/feature")
    } finally {
      await manager.shutdown().catch(() => undefined)
      await rm(base, { recursive: true, force: true })
    }
  })
  it("shares one in-flight logical location creation", async () => {
    const harness = createHarness()
    harness.service.validationGate = deferred<void>()
    const first = harness.manager.create(process.cwd())
    await harness.service.validationStarted.promise
    const second = harness.manager.create(process.cwd())
    harness.service.validationGate.resolve()

    const [leader, follower] = await Promise.all([first, second])
    assert.equal(leader.workspace.id, follower.workspace.id)
    assert.equal(Number(leader.created) + Number(follower.created), 1)
    assert.equal(harness.service.validationCalls.length, 1)
  })

  it("evicts only after the last logical owner of a location is deleted", async () => {
    const harness = createHarness()
    const first = await harness.manager.create(process.cwd())
    const forced = await harness.manager.create(process.cwd(), undefined, { forceNew: true })

    await harness.manager.delete(forced.workspace.id)
    assert.deepEqual(harness.service.evictions, [])
    assert.equal(harness.manager.get(first.workspace.id)?.status, "ready")

    await harness.manager.delete(first.workspace.id)
    assert.deepEqual(harness.service.evictions, [{ directory: process.cwd(), workspaceID: "location-1" }])
    assert.deepEqual(harness.stopped, [forced.workspace.id, first.workspace.id])
  })

  it("cancels validation and cleans its logical location", async () => {
    const harness = createHarness()
    harness.service.validationGate = deferred<void>()
    const creation = harness.manager.create(process.cwd())
    await harness.service.validationStarted.promise
    const record = [...(harness.manager as any).workspaces.values()][0]
    const deletion = harness.manager.delete(record.id)

    await assert.rejects(creation, WorkspaceLaunchCancelledError)
    await deletion
    assert.deepEqual(harness.manager.list(), [])
    assert.deepEqual(harness.service.evictions, [{ directory: process.cwd() }])
  })

  it("refuses deletion while another workspace occupies the worktree", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "codenomad-worktree-owner-"))
    const worktree = path.join(temp, "worktree")
    const nested = path.join(worktree, "apps", "web")
    await mkdir(nested, { recursive: true })
    const harness = createHarness()
    try {
      const { workspace } = await harness.manager.create(nested)
      await assert.rejects(() => harness.manager.reserveWorktreeDeletion(worktree), /open as another workspace/)
      await harness.manager.delete(workspace.id)
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  it("keeps a failed eviction retryable and reports shutdown failures", async () => {
    const harness = createHarness()
    const { workspace } = await harness.manager.create(process.cwd())
    harness.service.failEvictions = 1

    await assert.rejects(harness.manager.shutdown(), (error: unknown) => {
      assert.ok(error instanceof WorkspaceShutdownError)
      assert.match(String(error.errors[0]), /controlled eviction failure/)
      return true
    })
    assert.equal(harness.manager.get(workspace.id)?.status, "ready")

    await harness.manager.delete(workspace.id)
    assert.equal(harness.manager.get(workspace.id), undefined)
  })

})
