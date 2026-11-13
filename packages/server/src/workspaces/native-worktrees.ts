import { createHash } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import type { LocationRef, OpenCodeClient } from "@opencode/client"
import type { WorktreeDescriptor, WorktreeListResponse } from "../api-types"
import { locationRequestOptions } from "../opencode/compatibility/location"
import { readCheckout, readCheckoutIdentity, readWorktreeAnnotations, createCheckoutRootVerifier, resolveRepoRoot, prepareWorktreeBranch, attachWorktreeBranch } from "./git-worktrees"
import { ensureCodenomadGitExclude } from "./worktree-map"
import { GitRequiredError } from "./git-requirement"

export interface NativeWorktreeContext {
  client: OpenCodeClient
  location: LocationRef
  workspacePath: string
  toHost: (directory: string) => Promise<string | null>
}

const servicePaths = (directory: string) => /^[A-Za-z]:[\\/]|^(?:\\\\|\/\/)/.test(directory) ? path.win32 : path.posix
const identifier = (directory: string) => `worktree-${createHash("sha256").update(directory).digest("hex").slice(0, 20)}`

async function sameDirectory(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([stat(left), stat(right)])
  return a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs
}

export async function listNativeWorktrees(context: NativeWorktreeContext, options: { refresh?: boolean; media?: { signal: AbortSignal; current: () => void } } = {}): Promise<WorktreeListResponse> {
  const { client, location, workspacePath, toHost } = context
  const signal = options.media?.signal, assertCurrent = options.media?.current
  const check = () => { signal?.throwIfAborted(); assertCurrent?.() }
  check()
  let isGitRepo: boolean
  try {
    ;({ isGitRepo } = await resolveRepoRoot(workspacePath))
    check()
  } catch (error) {
    check()
    if (!(error instanceof GitRequiredError)) throw error
    // No repository claim or discovered sibling checkouts without Git.
    return { gitAvailable: false, worktrees: [{ slug: "root", directory: workspacePath, serviceDirectory: location.directory, kind: "root", directoryOnly: true }] }
  }
  if (!isGitRepo) return { isGitRepo, worktrees: [{ slug: "root", directory: workspacePath, serviceDirectory: location.directory, kind: "root" }] }
  const local = await readCheckout(workspacePath)
  check()
  const current = await client.location.get({ location: { directory: location.directory } }, signal
    ? { ...locationRequestOptions(location), signal } : locationRequestOptions(location))
  check()
  const checkoutHost = await toHost(current.project.directory)
  check()
  if (!checkoutHost) throw new Error("OpenCode resolved a different local checkout")
  const sameCheckout = await sameDirectory(local.root, checkoutHost)
  check()
  if (!sameCheckout) throw new Error("OpenCode resolved a different local checkout")
  const mainHost = await toHost(current.project.canonical)
  check()
  if (!mainHost) throw new Error("OpenCode resolved a different local repository")
  const main = await readCheckout(mainHost)
  check()
  const sameRepository = await sameDirectory(local.common, main.common)
  check()
  if (!sameRepository) throw new Error("OpenCode resolved a different local repository")
  const requestOptions = { ...locationRequestOptions(location, { includeDirectory: true }),
    ...(signal ? { signal } : {}) }
  // Routing native events must not run strategy discovery or join a display
  // scan held inside worktree.refresh. Native registration remains authority.
  check()
  if (options.refresh !== false) {
    await client.worktree.refresh({ projectID: current.project.id }, requestOptions)
    check()
  }
  const native = await client.worktree.list({ projectID: current.project.id }, requestOptions)
  check()
  const verifyCheckoutRoot = await createCheckoutRootVerifier(workspacePath)
  check()
  const annotations = new Map<string, Awaited<ReturnType<typeof readWorktreeAnnotations>>[number]>()
  const registeredAnnotations = await readWorktreeAnnotations(workspacePath)
  check()
  for (const annotation of registeredAnnotations) {
    check()
    const registered = await realpath(annotation.root).catch(error => {
      check()
      if (error.code === "ENOENT") return undefined
      throw error
    })
    check()
    if (registered) annotations.set(registered, annotation)
  }
  const paths = servicePaths(location.directory)
  const relative = paths.relative(current.project.directory, current.directory)
  if (paths.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${paths.sep}`)) throw new Error("Workspace is outside its checkout")
  const worktrees: WorktreeDescriptor[] = []
  const seen = new Set<string>()
  // Validate native entries with bounded filesystem I/O. Branch/HEAD annotations
  // come from one Git snapshot rather than three processes per checkout.
  const pending = native.values()
  const inspect = async (entry: (typeof native)[number]) => {
    check()
    const host = await toHost(entry.directory)
    check()
    if (!host) throw new Error("Unable to translate native worktree directory")
    try {
      await stat(host)
      check()
    } catch (error) {
      check()
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    // Independent clones can share a native project ID. Git's physical common
    // directory decides local membership; branch names and remote URLs do not.
    const registeredDirectory = await realpath(host)
    check()
    const annotation = annotations.get(registeredDirectory)
    if (!annotation) return
    const checkout = await readCheckoutIdentity(host).catch(error => {
      check()
      // `git worktree remove` deletes the checkout's `.git` before the rest of
      // its folder (minutes for a large tree), and an interrupted removal can
      // leave the folder behind. A registration whose Git layout is gone is no
      // longer a checkout: omit it like a vanished directory rather than fail
      // the inventory, and with it every conversation's ownership.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    })
    check()
    if (!checkout) return
    const sameCommon = await sameDirectory(local.common, checkout.common)
    check()
    if (!sameCommon) return
    const sameRoot = await sameDirectory(checkout.root ?? mainHost, registeredDirectory)
    check()
    if (!sameRoot) throw new Error("Native worktree entry is not a checkout root")
    await verifyCheckoutRoot(host)
    check()
    if (seen.has(registeredDirectory)) return
    seen.add(registeredDirectory)
    const root = await sameDirectory(local.root, registeredDirectory)
    check()
    const removable = !root && !await sameDirectory(checkout.gitDirectory, checkout.common)
    check()
    worktrees.push({
      slug: root ? "root" : identifier(registeredDirectory),
      label: annotation.branch ?? `${path.basename(registeredDirectory)} @ ${annotation.head?.slice(0, 7) ?? "HEAD"}`,
      directory: root ? workspacePath : path.join(registeredDirectory, ...relative.split(/[\\/]/).filter(Boolean)),
      serviceDirectory: root ? current.directory : paths.join(entry.directory, relative),
      registeredDirectory,
      serviceRoot: entry.directory,
      kind: root ? "root" : "worktree",
      removable,
      branch: annotation.branch,
      head: annotation.head,
    })
  }
  let failed = false
  const scans = Array.from({ length: Math.min(8, native.length) }, async () => {
    for (const entry of pending) {
      if (failed) return
      try { check(); await inspect(entry); check() }
      catch (error) { failed = true; throw error }
    }
  })
  try { await Promise.all(scans) }
  catch (error) {
    // Keep custody of admitted reads until their filesystem/Git work has settled.
    await Promise.allSettled(scans)
    check()
    throw error
  }
  check()
  if (!worktrees.some(entry => entry.kind === "root")) throw new Error("Native worktree inventory is missing the opened checkout")
  return {
    isGitRepo,
    defaultDirectory: paths.join(current.project.canonical, ".codenomad", "worktrees"),
    worktrees: worktrees.sort((a, b) => a.kind === "root" ? -1 : b.kind === "root" ? 1 : a.label!.localeCompare(b.label!)),
  }
}

export async function createNativeWorktree(context: NativeWorktreeContext, branch: string, fromSlug = "root") {
  const catalogue = await listNativeWorktrees(context)
  const source = catalogue.worktrees.find(entry => entry.slug === fromSlug)
  if (!catalogue.isGitRepo || !source?.serviceRoot || !catalogue.defaultDirectory) throw new Error("Source worktree not found")
  const policy = await prepareWorktreeBranch(source.registeredDirectory!, branch)
  await ensureCodenomadGitExclude(context.workspacePath)
  const { client, location } = context
  const current = await client.location.get({ location: { directory: location.directory } }, locationRequestOptions(location))
  const options = locationRequestOptions(location, { includeDirectory: true })
  const created = await client.worktree.create({
    projectID: current.project.id,
    from: source.serviceRoot,
    branch: policy.revision,
    directory: catalogue.defaultDirectory,
    name: branch.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^\.+/, "") || "worktree",
  }, options)
  const host = await context.toHost(created.directory)
  const paths = servicePaths(created.directory)
  const relative = paths.relative(catalogue.defaultDirectory, created.directory)
  if (!host || !relative || paths.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${paths.sep}`)) {
    throw new Error("Native worktree creation returned an unexpected directory")
  }
  const [sourceCheckout, createdCheckout] = await Promise.all([readCheckout(source.registeredDirectory!), readCheckout(host)])
  if (!await sameDirectory(sourceCheckout.common, createdCheckout.common)) throw new Error("Created worktree belongs to another local repository")
  try {
    // Native creation deliberately detaches HEAD. Branch selection remains Git
    // policy: preserve a named branch without duplicating worktree management.
    await attachWorktreeBranch(host, branch, policy.existing)
  } catch (error) {
    try {
      await client.worktree.remove({ projectID: current.project.id, directory: created.directory, force: false }, options)
    } catch (rollback) {
      throw new Error(`Unable to attach branch: ${String(error)}; worktree cleanup failed: ${String(rollback)}`)
    }
    throw error
  }
  const updated = await listNativeWorktrees(context)
  const registered = await realpath(host)
  const result = updated.worktrees.find(entry => entry.registeredDirectory === registered)
  if (!result) throw new Error("Created worktree is missing from native inventory")
  return result
}

export async function removeNativeWorktree(context: NativeWorktreeContext, directory: string, force: boolean) {
  const { client, location } = context
  const current = await client.location.get({ location: { directory: location.directory } }, locationRequestOptions(location))
  await client.worktree.remove({ projectID: current.project.id, directory, force }, locationRequestOptions(location, { includeDirectory: true }))
}
