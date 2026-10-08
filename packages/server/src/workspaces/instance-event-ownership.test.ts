import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { LocationRef, OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import pino from "pino"
import { EventBus } from "../events/bus"
import { WorkspaceManager } from "./manager"
import { InstanceEventBridge } from "./instance-events"

test("event ownership does not join a stalled native discovery refresh", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "codenomad-relay-ownership-"))
  const linked = path.join(root, "linked")
  const repo = path.join(root, "repo")
  const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: "pipe" }).trim()
  git(root, "init", "-b", "main", repo)
  git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture")
  git(repo, "worktree", "add", "-b", "linked", linked)
  const events = new EventBus()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let refreshes = 0
  const client = {
    location: { get: async ({ location }: { location: { directory: string } }) => ({
      directory: location.directory,
      project: { id: "fixture", directory: git(location.directory, "rev-parse", "--show-toplevel"), canonical: repo },
    }) },
    worktree: {
      refresh: async () => { refreshes++; await held },
      list: async () => [{ directory: repo }, { directory: linked }],
    },
  } as unknown as OpenCodeClient
  const logger = pino({ level: "silent" })
  const manager = new WorkspaceManager({ rootDir: root, eventBus: events, logger,
    settings: { getOwner: () => ({ environmentVariables: {} }) } as any,
    binaryResolver: { resolveDefault: () => ({ path: process.execPath, label: "Fixture" }) } as any,
    sharedService: {
      client: async () => client, validateLocation: async (location: LocationRef) => client.location.get({ location }),
      headers: async () => ({}), shutdown: async () => {},
      subscribe: async (options: { signal: AbortSignal }) => (async function* () {
        yield { type: "server.connected", data: {} } as OpenCodeEvent
        yield { id: "delta", created: Date.now(), type: "session.text.delta", location: { directory: linked }, data: { sessionID: "s", delta: "fixture" } } as OpenCodeEvent
        await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }))
      })(),
    } as any,
  })
  let bridge: InstanceEventBridge | undefined
  let scan: Promise<unknown> | undefined
  t.after(async () => { bridge?.shutdown(); release(); await scan; await manager.shutdown(); rmSync(root, { recursive: true, force: true }) })
  const { workspace } = await manager.create(repo)
  scan = manager.getWorktrees(workspace.id)
  while (!refreshes) await new Promise(resolve => setTimeout(resolve, 1))
  let delivered!: () => void
  const received = new Promise<void>(resolve => { delivered = resolve })
  events.on("instance.event", event => { if (event.event.type === "session.text.delta") delivered() })
  bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: events, logger })
  events.publish({ type: "workspace.started", workspace })
  // Allow real Git/filesystem checks on loaded CI hosts. The refresh remains
  // unresolved throughout, so this tests isolation, not a latency threshold.
  const timeout = setTimeout(() => delivered(), 10_000)
  let published = false
  events.on("instance.event", event => { if (event.event.type === "session.text.delta") published = true })
  await received
  clearTimeout(timeout)
  assert.equal(published, true, "a delta must be routed before the unrelated discovery scan completes")
  assert.equal(refreshes, 1, "event authorization must not start its own native discovery mutation")
})

test("registered-only event ownership retains clone, nested-folder, alias and invalidation fences", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "codenomad-event-authority-"))
  const repo = path.join(root, "repo"), linked = path.join(root, "linked"), clone = path.join(root, "clone")
  const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: "pipe" }).trim()
  git(root, "init", "-b", "main", repo)
  git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture")
  git(repo, "worktree", "add", "-b", "linked", linked)
  git(root, "clone", "--no-hardlinks", repo, clone)
  for (const directory of [repo, linked, clone]) mkdirSync(path.join(directory, "nested"))
  const alias = path.join(root, "alias")
  symlinkSync(linked, alias, process.platform === "win32" ? "junction" : "dir")
  let registered = [repo, linked, clone]
  let refreshes = 0
  const client = {
    location: { get: async ({ location }: { location: { directory: string } }) => ({ directory: location.directory,
      project: { id: "same-project", directory: git(location.directory, "rev-parse", "--show-toplevel"), canonical: repo },
    }) },
    worktree: { refresh: async () => { refreshes++ }, list: async () => registered.map(directory => ({ directory })) },
  } as unknown as OpenCodeClient
  const manager = new WorkspaceManager({ rootDir: root, eventBus: new EventBus(), logger: pino({ level: "silent" }),
    settings: { getOwner: () => ({ environmentVariables: {} }) } as any,
    binaryResolver: { resolveDefault: () => ({ path: process.execPath, label: "Fixture" }) } as any,
    sharedService: { client: async () => client, validateLocation: async (location: LocationRef) => client.location.get({ location }),
      headers: async () => ({}), evictLocation: async () => {}, shutdown: async () => {} } as any,
  })
  t.after(async () => { await manager.shutdown(); rmSync(root, { recursive: true, force: true }) })
  const { workspace } = await manager.create(path.join(repo, "nested"))
  const owns = (directory: string) => manager.ownsDirectory(workspace.id, directory, "event")
  assert.equal(await owns(path.join(linked, "nested")), true)
  assert.equal(await owns(path.join(alias, "nested")), true)
  assert.equal(await owns(linked), false, "a nested opening must not grant the whole sibling checkout")
  assert.equal(await owns(path.join(clone, "nested")), false, "native project IDs cannot authorize an independent physical clone")
  assert.equal(refreshes, 0)
  assert.equal(await manager.getServiceDirectoryForPath(workspace.id, path.join(alias, "nested"), "event"), realpathSync(path.join(linked, "nested")))
  // Even if the files remain present, removal from the native registration is
  // sufficient to revoke membership after a worktree event/mutation fence.
  registered = [repo, clone]
  manager.invalidateWorktrees("blocking")
  assert.equal(await owns(path.join(linked, "nested")), false)
  assert.equal(refreshes, 0, "negative refresh-on-miss must remain registered-only")
  registered = [repo, linked, clone]
  manager.invalidateWorktrees()
  assert.equal(await owns(path.join(linked, "nested")), true)
  // Keep the ordinary discovery path unchanged, including newly agent-created
  // worktrees which have not produced any native event or registration yet.
  await manager.getWorktrees(workspace.id, "fresh")
  assert.equal(refreshes, 1)
  await manager.delete(workspace.id)
  assert.equal(await owns(path.join(linked, "nested")), false)
})
