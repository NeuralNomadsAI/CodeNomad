import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { open } from "node:fs/promises"
import path from "node:path"
import type { ForgeProvider, ForgeWorkItemKind } from "../panel-extensions/contract"
import { runGitProcess } from "../workspaces/git-process"
import { stopWindowsProcessTree } from "../process-tree"
import { readForgeRemote } from "./remote"

/** The project's forge repository and the remote it is fetched from. */
export interface WorkItemBranchSource { provider: ForgeProvider; host: string; path: string; name: string }
export interface WorkItemBranch { kind: ForgeWorkItemKind; number: number; branch: string }
/** `repository` is the identity the host shows and binds its confirmation to (`<host>/<path>`, lower case). */
export type WorkItemBranchLookup = { status: "ok"; repository: string; branch: string | null } | { status: "conflict"; branch: string } | { status: "unavailable" }
/** `revision` is the branch tip a worktree must then check out. */
export type WorkItemBranchResult = { status: "ok"; branch: string; revision: string; created: boolean } | { status: "conflict"; branch: string }
  | { status: "unavailable" | "changed" }
export interface WorkItemBranchGuard {
  /** The checkout whose HEAD a new issue branch starts from (the displayed one); the project folder otherwise. */
  base?: string
  /** Run right before any ref or config is written: consent and project must still hold. */
  check?: () => Promise<void>
  signal?: AbortSignal
}

// Host-owned link of a local branch to one item, in the repository's own config:
// `<host>/<path>#<kind>/<number>@<start commit>/<branch>`. Git drops it with the branch; a branch
// name alone is never proof, and only a branch that still contains its start commit is
// the one CodeNomad created.
const KEY = "codenomad-work-item"
const MAX_LISTED = 200
const LINK = /^([^#]+)#(issue|pullrequest)\/([1-9]\d{0,8})@([0-9a-f]{40}|[0-9a-f]{64})\/(.+)$/
const itemBranch = (kind: ForgeWorkItemKind, number: number) => `${kind === "issue" ? "issue" : "pr"}-${number}`
const FETCH_TIMEOUT_MS = 15_000
const locks = new Map<string, Promise<unknown>>()
type Link = WorkItemBranch & { start: string }

function git(directory: string, args: string[], timeout = 10_000) {
  // Inherited repository redirection never applies; SSH transport settings do.
  const cleared = Object.fromEntries(Object.keys(process.env)
    .filter(key => key.toUpperCase().startsWith("GIT_") && !/^GIT_SSH(_COMMAND)?$/i.test(key)).map(key => [key, undefined]))
  return runGitProcess(directory, args, { priority: "foreground", timeout, maxBuffer: 4 * 1024 * 1024,
    env: { ...cleared, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } }).then(output => output.trim())
}

/** A repository's identity in links and confirmations. */
// The host is case-insensitive; the path keeps its case, as self-hosted forges may distinguish it.
export const workItemRepository = (source: Pick<WorkItemBranchSource, "host" | "path">) => `${source.host.toLowerCase()}/${source.path}`

/** Every existing local branch linked to an item of `source`'s repository, unbounded but for Git's output budget. */
async function links(directory: string, source: Pick<WorkItemBranchSource, "host" | "path">): Promise<Link[]> {
  const output = await git(directory, ["config", "--local", "--get-regexp", `^branch\\..*\\.${KEY}$`])
    .catch((error: { code?: unknown }) => { if (error.code === 1) return ""; throw error })
  const repository = workItemRepository(source)
  const linked: Link[] = []
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    // `branch.<name>.<key> <value>`: Git lowercases the section and key, never the name.
    const space = line.indexOf(" ")
    const branch = line.slice("branch.".length, space - KEY.length - 1)
    const value = LINK.exec(line.slice(space + 1))
    // The value names its own branch: `git branch -c`/`-m` carry the config to another name, never the link.
    if (branch && value?.[1] === repository && value[5] === branch) {
      linked.push({ kind: value[2] === "issue" ? "issue" : "pullRequest", number: Number(value[3]), branch, start: value[4]! })
    }
  }
  if (!linked.length) return []
  // A ref deleted without Git's branch command leaves its config behind.
  const refs = new Set((await git(directory, ["for-each-ref", "--format=%(refname)", "refs/heads/"])).split(/\r?\n/))
  return linked.filter(link => refs.has(`refs/heads/${link.branch}`))
}

/** Existing local branches linked to items of `source`'s repository, at most 200 (display only: opening uses the exact lookup). */
export async function readWorkItemBranches(directory: string, source: WorkItemBranchSource, signal?: AbortSignal): Promise<WorkItemBranch[] | undefined> {
  // The selected remote must still name the repository, as for every exact lookup.
  if (await remoteUrl(directory, source, signal) !== "ok") return undefined
  return (await links(directory, source)).slice(0, MAX_LISTED).map(({ start: _start, ...link }) => link)
}


/**
 * Whether the remote Git selects for the repository right now (no cache: an `upstream`
 * added meanwhile wins) is still `source`'s remote, naming the same repository through its
 * URL as `git remote get-url` expands it. Fetching that remote by name expands it the same
 * single way.
 */
async function remoteUrl(directory: string, source: WorkItemBranchSource, signal?: AbortSignal): Promise<"ok" | "changed" | undefined> {
  const selected = await readForgeRemote(directory, signal).catch(() => undefined)
  if (!selected) return undefined
  return selected.name === source.name && workItemRepository(selected) === workItemRepository(source) ? "ok" : "changed"
}

// The reflog message of every branch CodeNomad creates: a branch whose reflog starts otherwise is not ours.
const creationMarker = (kind: ForgeWorkItemKind, number: number) => `codenomad: work item ${kind.toLowerCase()}/${number}`

/**
 * The item's own linked branch, however many links exist, once the selected remote still names
 * the repository; `conflict` when its name now holds another branch: one that no longer contains
 * the start commit, or whose reflog begins with any other creation than CodeNomad's (a stale link,
 * its ref deleted without Git's branch command, then the name recreated). An expired reflog
 * leaves the ancestry check alone.
 */
export async function lookupWorkItemBranch(directory: string, source: WorkItemBranchSource, kind: ForgeWorkItemKind, number: number,
  signal?: AbortSignal): Promise<WorkItemBranchLookup> {
  const url = await remoteUrl(directory, source, signal)
  return !url || url === "changed" ? { status: "unavailable" } : linkedBranch(directory, source, kind, number)
}

/** The oldest reflog entry of `ref`, read from the files backend; undefined without one. */
async function firstReflogEntry(directory: string, ref: string) {
  const file = await git(directory, ["rev-parse", "--path-format=absolute", "--git-path", `logs/${ref}`]).catch(() => "")
  if (!file) return undefined
  const handle = await open(file, "r").catch(() => undefined)
  if (!handle) return undefined
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(4096), 0, 4096, 0)
    const entry = /^([0-9a-f]{40}|[0-9a-f]{64}) [0-9a-f]+ [^\t\n]*\t([^\n]*)/.exec(buffer.subarray(0, bytesRead).toString("utf8"))
    return entry ? { creation: /^0+$/.test(entry[1]!), message: entry[2]!.trim() } : undefined
  } finally { await handle.close() }
}

/** A branch whose name differs from `name` only by case: one ref on case-insensitive file systems. */
async function caseTwin(directory: string, name: string) {
  const refs = (await git(directory, ["for-each-ref", "--format=%(refname)", "refs/heads/"]).catch(() => "")).split(/\r?\n/)
  return refs.find(ref => ref !== `refs/heads/${name}` && ref.toLowerCase() === `refs/heads/${name}`.toLowerCase())?.slice("refs/heads/".length)
}

/** The exact lookup once the remote was checked. Only the item's own name can hold its link (copies and renames never match), so it reads that one key. */
async function linkedBranch(directory: string, source: WorkItemBranchSource, kind: ForgeWorkItemKind, number: number): Promise<WorkItemBranchLookup> {
  const repository = workItemRepository(source), name = itemBranch(kind, number), ref = `refs/heads/${name}`
  const value = LINK.exec(await git(directory, ["config", "--local", "--get", `branch.${name}.${KEY}`]).catch(() => ""))
  const exists = await git(directory, ["rev-parse", "--verify", "--quiet", ref]).then(Boolean, () => false)
  const twin = await caseTwin(directory, name)
  if (twin) return { status: "conflict", branch: twin }
  if (!exists) return { status: "ok", repository, branch: null }
  // The name holds a branch that is not this item's link: nothing CodeNomad may reuse or create.
  if (!value || value[1] !== repository || value[2] !== kind.toLowerCase() || Number(value[3]) !== number || value[5] !== name) {
    return { status: "conflict", branch: name }
  }
  const link = { branch: name, start: value[4]! }
  const [contains, first, history] = await Promise.all([
    git(directory, ["merge-base", "--is-ancestor", link.start, ref])
      .then(() => true, (error: { code?: unknown }) => { if (error.code === 1 || error.code === 128) return false; throw error }),
    firstReflogEntry(directory, ref),
    git(directory, ["reflog", "show", "--format=%gs", ref, "--"]).catch(() => ""),
  ])
  // Git writes a ref's creation as a reflog entry from the null object ID, and deleting the ref
  // deletes its reflog: a surviving creation entry must be CodeNomad's own. Once it expired
  // (later entries kept) or without a reflog, ancestry alone decides.
  // `git branch -c`/`-m` carry config and reflog along, then log the copy or rename: such a
  // branch came under this name from another one, whatever its first entry says.
  // Without a reflog file (reftable, or none), Git's own reading of the oldest entry still shows the marker.
  const oldest = history.split(/\r?\n/).filter(Boolean).at(-1)
  const ours = first ? first.creation && first.message === creationMarker(kind, number) : oldest === creationMarker(kind, number)
  const recreated = (first?.creation === true && !ours) || /^Branch: (copied|renamed) /im.test(history)
  // CodeNomad's own creation entry proves the branch through any rewrite (a rebase); without it, ancestry decides.
  return !recreated && (ours || contains) ? { status: "ok", repository: workItemRepository(source), branch: link.branch } : { status: "conflict", branch: link.branch }
}

/**
 * The item's linked branch, or a new linked one: `issue-N` from the base checkout's
 * HEAD, or `pr-N` at the pull request's head as the repository publishes it (forks
 * included). Never replaces or moves an existing branch; an unlinked branch of that
 * name is a conflict. One creation per repository folder at a time.
 */
export function createWorkItemBranch(directory: string, source: WorkItemBranchSource, kind: ForgeWorkItemKind, number: number,
  guard: WorkItemBranchGuard = {}): Promise<WorkItemBranchResult> {
  // One lock per repository: linked checkouts and nested folders share their Git common directory.
  const key = git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).then(common => path.resolve(common).toLowerCase(), () => directory)
  return key.then(key => {
    const previous = locks.get(key) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(() => create(directory, source, kind, number, guard))
    locks.set(key, run)
    void run.catch(() => {}).finally(() => { if (locks.get(key) === run) locks.delete(key) })
    return run
  })
}

/**
 * The pull request fetch, a network process outside the shared Git worker (whose two
 * slots serve local reads), killed when the caller goes away or after 15 s.
 */
function fetchHead(directory: string, remote: string, head: string, scratch: string, signal?: AbortSignal) {
  const cleared = Object.fromEntries(Object.keys(process.env)
    .filter(key => key.toUpperCase().startsWith("GIT_") && !/^GIT_SSH(_COMMAND)?$/i.test(key)).map(key => [key, undefined]))
  return new Promise<void>((resolve, reject) => {
    // POSIX: its own process group, so the transport helpers it starts end with it.
    const child = spawn("git", ["-C", directory, "fetch", "--no-tags", "--no-prune", "--no-recurse-submodules", "--no-write-fetch-head", "--refmap=", "--",
      remote, `${head}:${scratch}`], {
      windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ...cleared, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    })
    // Taken once the process exists: the tree stop admits a root started no later than this.
    const spawnedBy = new Date()
    let stderr = "", failure: unknown, fallback: ReturnType<typeof setTimeout> | undefined
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 64 * 1024) stderr += chunk.toString() })
    const killTree = () => {
      if (child.pid === undefined || child.exitCode !== null) return
      if (process.platform === "win32") void stopWindowsProcessTree(child.pid, spawnedBy).then(stopped => { if (stopped === 0) child.kill() }, () => child.kill())
      else try { process.kill(-child.pid, "SIGKILL") } catch { child.kill("SIGKILL") }
    }
    // The caller learns the outcome once the process tree has closed, so nothing writes the scratch ref after.
    const stop = (reason: unknown) => {
      if (failure !== undefined) return
      failure = reason
      killTree()
      // A tree that never closes still frees the caller (stopping one on Windows takes a few seconds).
      fallback = setTimeout(() => { child.kill("SIGKILL"); reject(reason) }, 35_000)
      fallback.unref()
    }
    const abort = () => stop(signal!.reason ?? new Error("Fetch abandoned"))
    const timer = setTimeout(() => stop(new Error("Pull request fetch timed out")), FETCH_TIMEOUT_MS)
    signal?.addEventListener("abort", abort, { once: true })
    const settle = (error?: unknown) => {
      clearTimeout(timer)
      clearTimeout(fallback)
      signal?.removeEventListener("abort", abort)
      if (failure !== undefined) reject(failure)
      else if (error) reject(error)
      else resolve()
    }
    child.once("error", error => settle(error))
    child.once("close", code => settle(code === 0 ? undefined : new Error(stderr.trim() || `git fetch exited with ${code}`)))
    if (signal?.aborted) abort()
  })
}

async function create(directory: string, source: WorkItemBranchSource, kind: ForgeWorkItemKind, number: number,
  guard: WorkItemBranchGuard): Promise<WorkItemBranchResult> {
  const ready = async () => { guard.signal?.throwIfAborted(); await guard.check?.(); guard.signal?.throwIfAborted() }
  await ready()
  // The remote must still name the confirmed repository, whether the branch is reused or created.
  const first = await remoteUrl(directory, source, guard.signal)
  if (first === "changed") return { status: "changed" }
  if (!first) return { status: "unavailable" }
  const found = await linkedBranch(directory, source, kind, number)
  if (found.status !== "ok") return found
  if (found.branch) return { status: "ok", branch: found.branch, revision: await git(directory, ["rev-parse", "--verify", `refs/heads/${found.branch}^{commit}`]), created: false }
  const branch = itemBranch(kind, number)
  if (await git(directory, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).catch(() => "")) return { status: "conflict", branch }
  let revision: string
  if (kind === "issue") revision = await git(guard.base ?? directory, ["rev-parse", "--verify", "HEAD^{commit}"])
  else {
    // Fetch from the remote that still names the confirmed repository, never through
    // its configured refspecs (`--refmap=`), into a scratch ref only.
    const head = source.provider === "gitlab" ? `refs/merge-requests/${number}/head` : `refs/pull/${number}/head`
    const scratch = `refs/codenomad/fetch/${randomUUID()}`
    try {
      await fetchHead(directory, source.name, head, scratch, guard.signal)
      revision = await git(directory, ["rev-parse", "--verify", `${scratch}^{commit}`])
    } catch {
      guard.signal?.throwIfAborted()
      return { status: "unavailable" }
    } finally {
      await git(directory, ["update-ref", "-d", scratch]).catch(() => {})
    }
  }
  // The selected remote and consent are checked right before the write and again after
  // it: a change during either check undoes the write (only that ref at that tip).
  const admitted = async (): Promise<WorkItemBranchResult | undefined> => {
    const url = await remoteUrl(directory, source, guard.signal)
    if (url === "changed") return { status: "changed" }
    if (!url) return { status: "unavailable" }
    await ready()
    return undefined
  }
  const refused = await admitted()
  if (refused) return refused
  // A case-only twin is the same ref on case-insensitive file systems: never shadow it.
  const twin = await caseTwin(directory, branch)
  if (twin) return { status: "conflict", branch: twin }
  // Created only if absent (empty old value), with CodeNomad's own reflog marker.
  try { await git(directory, ["update-ref", "-m", creationMarker(kind, number), `refs/heads/${branch}`, revision, ""]) } catch { return { status: "conflict", branch } }
  // Undoing removes only CodeNomad's link; the ref goes too unless something adopted it
  // meanwhile (a checkout, or other branch settings), and then only at that exact tip.
  const undo = async () => {
    await git(directory, ["config", "--local", "--unset-all", `branch.${branch}.${KEY}`]).catch(() => {})
    const [worktrees, settings] = await Promise.all([git(directory, ["worktree", "list", "--porcelain"]).catch(() => undefined),
      git(directory, ["config", "--local", "--get-regexp", `^branch\\.${branch.replace(/[.\\^$*+?()[\]{}|]/g, "\\$&")}\\.`]).catch(() => "")])
    if (worktrees === undefined || worktrees.split(/\r?\n/).includes(`branch refs/heads/${branch}`) || settings) return
    await git(directory, ["update-ref", "-d", `refs/heads/${branch}`, revision]).catch(() => {})
  }
  try {
    await git(directory, ["config", "--local", `branch.${branch}.${KEY}`, `${workItemRepository(source)}#${kind.toLowerCase()}/${number}@${revision}/${branch}`])
    const late = await admitted()
    if (late) { await undo(); return late }
  } catch (error) {
    await undo()
    throw error
  }
  return { status: "ok", branch, revision, created: true }
}
