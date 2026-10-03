import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile, rm, realpath } from "node:fs/promises"
import path from "node:path"
import { tsImport } from "tsx/esm/api"
import pino from "pino"
import { setTimeout as delay } from "node:timers/promises"

// Invoked by the isolated daemon fixture only. No service discovery/user state.
export async function testNativeWorktreeManagement({ client, root }) {
  const { listNativeWorktrees, createNativeWorktree, removeNativeWorktree } = await tsImport("../packages/server/src/workspaces/native-worktrees.ts", import.meta.url)
  const { WorktreeInventory } = await tsImport("../packages/server/src/workspaces/worktree-inventory.ts", import.meta.url)
  const repo = path.join(root, "worktree-policy")
  const external = path.join(root, "agent-created")
  const clone = path.join(root, "independent-clone")
  await mkdir(repo)
  const git = (directory, ...args) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim()
  git(repo, "init", "-b", "main")
  git(repo, "config", "user.name", "CodeNomad fixture")
  git(repo, "config", "user.email", "fixture@example.invalid")
  await mkdir(path.join(repo, "packages", "app"), { recursive: true })
  await writeFile(path.join(repo, "packages", "app", "base.txt"), "base")
  git(repo, "add", ".")
  git(repo, "commit", "-m", "base")
  git(repo, "worktree", "add", "-b", "agent", external)
  await writeFile(path.join(external, "source.txt"), "selected checkout")
  git(external, "add", ".")
  git(external, "commit", "-m", "selected checkout")
  const sourceHead = git(external, "rev-parse", "HEAD")
  await writeFile(path.join(external, "uncommitted.txt"), "stay here")
  git(root, "clone", "--no-hardlinks", repo, clone)
  const location = await client.location.get({ location: { directory: repo } })
  await client.location.get({ location: { directory: external } })
  await client.location.get({ location: { directory: clone } })
  const context = { client, location, workspacePath: repo, toHost: async directory => directory }
  const registered = await listNativeWorktrees(context, { refresh: false })
  assert.equal(registered.worktrees.length, 2, "native event locations must be registered without strategy refresh; shared-project clones remain excluded")
  let catalogue = await listNativeWorktrees(context)
  assert.equal(catalogue.worktrees.length, 2, "same-project independent clone must be excluded")
  const source = catalogue.worktrees.find(entry => entry.branch === "agent")
  assert.ok(source)
  const created = await createNativeWorktree(context, "feature/ui", source.slug)
  const expectedParent = path.join(await realpath(repo), ".codenomad", "worktrees")
  assert.equal(path.dirname(created.registeredDirectory), expectedParent)
  assert.equal(git(created.registeredDirectory, "symbolic-ref", "--short", "HEAD"), "feature/ui")
  assert.equal(git(created.registeredDirectory, "rev-parse", "HEAD"), sourceHead)
  assert.equal(git(created.registeredDirectory, "status", "--porcelain"), "")
  assert.match(git(external, "status", "--porcelain"), /uncommitted/)
  assert.ok(git(repo, "check-ignore", created.registeredDirectory))
  git(created.registeredDirectory, "branch", "-m", "feature/renamed")
  catalogue = await listNativeWorktrees(context)
  assert.equal(catalogue.worktrees.find(entry => entry.branch === "feature/renamed").slug, created.slug)
  await assert.rejects(createNativeWorktree(context, "agent"), "Git must refuse a branch already checked out")
  assert.equal((await listNativeWorktrees(context)).worktrees.length, 3, "failed branch attachment must clean up its new checkout")
  const nested = path.join(repo, "packages", "app")
  const nestedCatalogue = await listNativeWorktrees({ ...context, workspacePath: nested, location: { directory: nested } })
  assert.equal(nestedCatalogue.worktrees.find(entry => entry.slug === created.slug).directory, path.join(created.registeredDirectory, "packages", "app"))
  await writeFile(path.join(created.registeredDirectory, "dirty.txt"), "keep")
  await assert.rejects(removeNativeWorktree(context, created.serviceRoot, false))
  await rm(path.join(created.registeredDirectory, "dirty.txt"))
  await removeNativeWorktree(context, created.serviceRoot, false)
  assert.equal(git(repo, "rev-parse", "refs/heads/feature/renamed"), sourceHead, "removal must preserve the branch")
  assert.equal((await listNativeWorktrees(context)).worktrees.length, 2)
  const detached = [path.join(root, "detached-one"), path.join(root, "detached-two")]
  for (const directory of detached) git(repo, "worktree", "add", "--detach", directory, "HEAD")
  const detachedEntries = (await listNativeWorktrees(context)).worktrees.filter(entry => !entry.branch)
  assert.equal(detachedEntries.length, 2)
  assert.notEqual(detachedEntries[0].slug, detachedEntries[1].slug)
  const fromLinked = await listNativeWorktrees({ ...context, workspacePath: external, location: { directory: external } })
  assert.equal(fromLinked.defaultDirectory, catalogue.defaultDirectory, "opening a linked checkout must not nest the default parent")
  assert.equal(fromLinked.worktrees.find(entry => entry.branch === "main").removable, false)
  let scans = 0
  const changed = []
  const inventory = new WorktreeInventory({
    load: async () => { assert.ok(++scans < 8, "native refresh events must not cause a scan loop"); return listNativeWorktrees(context) },
    changed: id => changed.push(id),
    failed: (_id, error) => { throw error },
  })
  const controller = new AbortController()
  let connected
  const ready = new Promise(resolve => { connected = resolve })
  const events = (async () => {
    for await (const event of client.event.subscribe({ signal: controller.signal })) {
      if (event.type === "server.connected") connected()
      if (event.type === "worktree.updated") inventory.invalidate()
    }
  })()
  try {
    await ready
    const cached = await inventory.read("fixture")
    assert.equal(await inventory.read("fixture"), cached)
    assert.equal(scans, 1, "sequential display reads must reuse the completed native scan")
    git(external, "branch", "-m", "agent-renamed")
    inventory.invalidate("fixture")
    assert.equal(scans, 1, "invalidation must stay lazy")
    assert.equal(await inventory.read("fixture"), cached, "display must not wait for background Git")
    const updated = await inventory.read("fixture", "validated")
    assert.equal(updated.worktrees.find(entry => entry.slug === source.slug).branch, "agent-renamed")
    assert.deepEqual(changed, ["fixture"])
    assert.equal(scans, 2)
    await inventory.read("fixture", "fresh")
    assert.equal(scans, 3, "family validation must bypass a warm display cache")
    assert.deepEqual(changed, ["fixture"], "an unchanged scan must not create a reload feedback loop")
    console.log("PASS: native worktree cache reuse, lazy rename refresh and forced family validation")
  } finally {
    controller.abort()
    await events.catch(error => { if (!controller.signal.aborted) throw error })
  }
  const { WorkspaceManager } = await tsImport("../packages/server/src/workspaces/manager.ts", import.meta.url)
  const { EventBus } = await tsImport("../packages/server/src/events/bus.ts", import.meta.url)
  const { InstanceEventBridge } = await tsImport("../packages/server/src/workspaces/instance-events.ts", import.meta.url)
  const bus = new EventBus()
  let holdRefresh = false, refreshEntered = false, releaseRefresh
  const heldRefresh = new Promise(resolve => { releaseRefresh = resolve })
  const managerClient = { ...client, worktree: { ...client.worktree, refresh: async (...args) => {
    if (holdRefresh) { refreshEntered = true; await heldRefresh }
    return client.worktree.refresh(...args)
  } } }
  // Exercise the production manager's post-mutation invalidation using only
  // this fixture's authenticated client. No native discovery/user service.
  const manager = new WorkspaceManager({
    rootDir: root,
    settings: { getOwner: () => ({ environmentVariables: {} }) },
    binaryResolver: { resolveDefault: () => ({ path: process.execPath, label: "Isolated fixture" }) },
    eventBus: bus,
    logger: pino({ level: "silent" }),
    sharedService: {
      client: async () => managerClient,
      headers: async () => ({}),
      validateLocation: async location => client.location.get({ location }),
      subscribe: async options => client.event.subscribe(options),
      shutdown: async () => {},
    },
  })
  let bridge, pendingScan, eventSession
  try {
    const { workspace } = await manager.create(repo)
    const before = await manager.getWorktrees(workspace.id)
    const statuses = [], renames = []
    bus.on("instance.eventStatus", event => statuses.push(event.status))
    bus.on("instance.event", ({ event }) => { if (event.type === "session.renamed") renames.push(event.data.title) })
    bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus, logger: pino({ level: "silent" }) })
    const until = async predicate => {
      const deadline = Date.now() + 10_000
      while (!predicate()) { assert.ok(Date.now() < deadline, "native event ownership joined the held discovery refresh"); await delay(10) }
    }
    bus.publish({ type: "workspace.started", workspace })
    await until(() => statuses.includes("connected"))
    holdRefresh = true
    pendingScan = manager.getWorktrees(workspace.id, "fresh")
    await until(() => refreshEntered)
    // This location and its events are real native registrations, not a stub
    // inventory. Only this isolated manager's discovery request is held.
    eventSession = await client.session.create({ location: { directory: external } })
    await client.session.update({ sessionID: eventSession.id, title: "held-discovery-event-1" })
    await client.session.update({ sessionID: eventSession.id, title: "held-discovery-event-2" })
    await until(() => renames.length === 2)
    assert.deepEqual(renames, ["held-discovery-event-1", "held-discovery-event-2"])
    assert.equal(statuses.includes("error"), false)
    assert.equal(await manager.ownsDirectory(workspace.id, clone, "event"), false)
    releaseRefresh(); holdRefresh = false; await pendingScan
    bridge.shutdown()
    console.log("PASS: production event relay routes ordered native worktree events while a separate discovery refresh is stalled")
    const added = await manager.createWorktree(workspace.id, "cached-create")
    const afterCreate = await manager.getWorktrees(workspace.id)
    assert.equal(afterCreate.worktrees.length, before.worktrees.length + 1)
    assert.ok(afterCreate.worktrees.some(entry => entry.slug === added.slug), "create-and-use must receive the new ID immediately")
    await manager.removeWorktree(workspace.id, added.serviceRoot, false)
    const afterRemove = await manager.getWorktrees(workspace.id)
    assert.equal(afterRemove.worktrees.length, before.worktrees.length)
    assert.ok(!afterRemove.worktrees.some(entry => entry.slug === added.slug), "post-delete refresh must not resurrect a cached checkout")
    console.log("PASS: production manager warm-cache create/remove read-your-writes")
  } finally {
    bridge?.shutdown()
    releaseRefresh()
    await pendingScan
    if (eventSession) await client.session.remove({ sessionID: eventSession.id })
    await manager.shutdown()
  }
  console.log("PASS: native worktree discovery/create/remove, clone scope, selected HEAD, default parent, named branches, stable identity, nested paths and dirty/checked-out guards")
}
