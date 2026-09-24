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

export async function listNativeWorktrees(context: NativeWorktreeContext): Promise<WorktreeListResponse> {
  const { client, location, workspacePath, toHost } = context
  let isGitRepo: boolean
  try {
    ;({ isGitRepo } = await resolveRepoRoot(workspacePath))
  } catch (error) {
    if (!(error instanceof GitRequiredError)) throw error
    // No repository claim or discovered sibling checkouts without Git.
    return { gitAvailable: false, worktrees: [{ slug: "root", directory: workspacePath, serviceDirectory: location.directory, kind: "root", directoryOnly: true }] }
  }
  if (!isGitRepo) return { isGitRepo, worktrees: [{ slug: "root", directory: workspacePath, serviceDirectory: location.directory, kind: "root" }] }
  const local = await readCheckout(workspacePath)
  const current = await client.location.get({ location: { directory: location.directory } }, locationRequestOptions(location))
  const checkoutHost = await toHost(current.project.directory)
  if (!checkoutHost || !await sameDirectory(local.root, checkoutHost)) throw new Error("OpenCode resolved a different local checkout")
  const mainHost = await toHost(current.project.canonical)
  if (!mainHost || !await sameDirectory(local.common, (await readCheckout(mainHost)).common)) {
    throw new Error("OpenCode resolved a different local repository")
  }
  const options = locationRequestOptions(location, { includeDirectory: true })
  await client.worktree.refresh({ projectID: current.project.id }, options)
  const native = await client.worktree.list({ projectID: current.project.id }, options)
  const verifyCheckoutRoot = await createCheckoutRootVerifier(workspacePath)
  const annotations = new Map<string, Awaited<ReturnType<typeof readWorktreeAnnotations>>[number]>()
  for (const annotation of await readWorktreeAnnotations(workspacePath)) {
    const registered = await realpath(annotation.root).catch(error => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
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
    const host = await toHost(entry.directory)
    if (!host) throw new Error("Unable to translate native worktree directory")
    try {
      await stat(host)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    // Independent clones can share a native project ID. Git's physical common
    // directory decides local membership; branch names and remote URLs do not.
    const registeredDirectory = await realpath(host)
    const annotation = annotations.get(registeredDirectory)
    if (!annotation) return
    const checkout = await readCheckoutIdentity(host)
    if (!await sameDirectory(local.common, checkout.common)) return
    if (!await sameDirectory(checkout.root ?? mainHost, registeredDirectory)) throw new Error("Native worktree entry is not a checkout root")
    await verifyCheckoutRoot(host)
    if (seen.has(registeredDirectory)) return
    seen.add(registeredDirectory)
    const root = await sameDirectory(local.root, registeredDirectory)
    worktrees.push({
      slug: root ? "root" : identifier(registeredDirectory),
      label: annotation.branch ?? `${path.basename(registeredDirectory)} @ ${annotation.head?.slice(0, 7) ?? "HEAD"}`,
      directory: root ? workspacePath : path.join(registeredDirectory, ...relative.split(/[\\/]/).filter(Boolean)),
      serviceDirectory: root ? current.directory : paths.join(entry.directory, relative),
      registeredDirectory,
      serviceRoot: entry.directory,
      kind: root ? "root" : "worktree",
      removable: !root && !await sameDirectory(checkout.gitDirectory, checkout.common),
      branch: annotation.branch,
      head: annotation.head,
    })
  }
  await Promise.all(Array.from({ length: Math.min(8, native.length) }, async () => {
    for (const entry of pending) await inspect(entry)
  }))
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
