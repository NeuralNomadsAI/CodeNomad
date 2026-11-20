import { randomUUID } from "node:crypto"
import type { ForgeProvider, ForgeWorkItemKind } from "../panel-extensions/contract"
import { runGitProcess } from "../workspaces/git-process"
import { parseRemoteUrl } from "./remote"

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
// `<host>/<path>#<kind>/<number>@<start commit>`. Git drops it with the branch; a branch
// name alone is never proof, and only a branch that still contains its start commit is
// the one CodeNomad created.
const KEY = "codenomad-work-item"
const MAX_LISTED = 200
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
export const workItemRepository = (source: Pick<WorkItemBranchSource, "host" | "path">) => `${source.host}/${source.path}`.toLowerCase()

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
    const value = /^(.+)#(issue|pullrequest)\/([1-9]\d{0,8})@([0-9a-f]{40}|[0-9a-f]{64})$/.exec(line.slice(space + 1))
    if (branch && value?.[1] === repository) {
      linked.push({ kind: value[2] === "issue" ? "issue" : "pullRequest", number: Number(value[3]), branch, start: value[4]! })
    }
  }
  if (!linked.length) return []
  // A ref deleted without Git's branch command leaves its config behind.
  const refs = new Set((await git(directory, ["for-each-ref", "--format=%(refname)", "refs/heads/"])).split(/\r?\n/))
  return linked.filter(link => refs.has(`refs/heads/${link.branch}`))
}

/** Existing local branches linked to items of `source`'s repository, at most 200 (display only: opening uses the exact lookup). */
export async function readWorkItemBranches(directory: string, source: Pick<WorkItemBranchSource, "host" | "path">): Promise<WorkItemBranch[]> {
  return (await links(directory, source)).slice(0, MAX_LISTED).map(({ start: _start, ...link }) => link)
}

/**
 * The selected remote's configured URL when its expansion still names `source`'s repository.
 * Fetching that same configured URL lets Git apply `insteadOf` once, as the validation did.
 */
async function remoteUrl(directory: string, source: WorkItemBranchSource) {
  const configured = (await git(directory, ["config", "--get-all", `remote.${source.name}.url`]).catch(() => "")).split(/\r?\n/)[0] ?? ""
  if (!configured) return undefined
  const remote = parseRemoteUrl(await git(directory, ["ls-remote", "--get-url", "--", configured]).catch(() => ""))
  return remote && workItemRepository(remote) === workItemRepository(source) ? configured : undefined
}

/**
 * The item's own linked branch, however many links exist, once the remote still names the
 * repository; `conflict` when its name now holds another branch: one that no longer contains
 * the start commit, or whose reflog begins with another creation (a stale link, its ref
 * deleted without Git's branch command, then the name recreated).
 */
export async function lookupWorkItemBranch(directory: string, source: WorkItemBranchSource, kind: ForgeWorkItemKind, number: number): Promise<WorkItemBranchLookup> {
  if (!await remoteUrl(directory, source)) return { status: "unavailable" }
  const link = (await links(directory, source)).find(candidate => candidate.kind === kind && candidate.number === number)
  if (!link) return { status: "ok", repository: workItemRepository(source), branch: null }
  const ref = `refs/heads/${link.branch}`
  const [contains, reflog] = await Promise.all([
    git(directory, ["merge-base", "--is-ancestor", link.start, ref])
      .then(() => true, (error: { code?: unknown }) => { if (error.code === 1 || error.code === 128) return false; throw error }),
    // Absent or expired reflogs leave the ancestry check alone.
    git(directory, ["reflog", "show", "--format=%gs", ref, "--"]).catch(() => ""),
  ])
  const created = reflog.split(/\r?\n/).at(-1) ?? ""
  const recreated = created.startsWith("branch: Created from ") && created !== `branch: Created from ${link.start}`
  return contains && !recreated ? { status: "ok", repository: workItemRepository(source), branch: link.branch } : { status: "conflict", branch: link.branch }
}

/**
 * The item's linked branch, or a new linked one: `issue-N` from the base checkout's
 * HEAD, or `pr-N` at the pull request's head as the repository publishes it (forks
 * included). Never replaces or moves an existing branch; an unlinked branch of that
 * name is a conflict. One creation per repository folder at a time.
 */
export function createWorkItemBranch(directory: string, source: WorkItemBranchSource, kind: ForgeWorkItemKind, number: number,
  guard: WorkItemBranchGuard = {}): Promise<WorkItemBranchResult> {
  const previous = locks.get(directory) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(() => create(directory, source, kind, number, guard))
  locks.set(directory, run)
  void run.catch(() => {}).finally(() => { if (locks.get(directory) === run) locks.delete(directory) })
  return run
}

async function create(directory: string, source: WorkItemBranchSource, kind: ForgeWorkItemKind, number: number,
  guard: WorkItemBranchGuard): Promise<WorkItemBranchResult> {
  const ready = async () => { guard.signal?.throwIfAborted(); await guard.check?.(); guard.signal?.throwIfAborted() }
  await ready()
  // The remote must still name the confirmed repository, whether the branch is reused or created.
  const found = await lookupWorkItemBranch(directory, source, kind, number)
  if (found.status !== "ok") return found
  if (found.branch) return { status: "ok", branch: found.branch, revision: await git(directory, ["rev-parse", "--verify", `refs/heads/${found.branch}^{commit}`]), created: false }
  const branch = `${kind === "issue" ? "issue" : "pr"}-${number}`
  if (await git(directory, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).catch(() => "")) return { status: "conflict", branch }
  let revision: string
  if (kind === "issue") revision = await git(guard.base ?? directory, ["rev-parse", "--verify", "HEAD^{commit}"])
  else {
    // Fetch from the URL that still names the confirmed repository, never through
    // the remote's configured refspecs (`--refmap=`), into a scratch ref only.
    const url = await remoteUrl(directory, source)
    if (!url) return { status: "unavailable" }
    const head = source.provider === "gitlab" ? `refs/merge-requests/${number}/head` : `refs/pull/${number}/head`
    const scratch = `refs/codenomad/fetch/${randomUUID()}`
    try {
      await git(directory, ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--refmap=", "--", url, `${head}:${scratch}`], FETCH_TIMEOUT_MS)
      revision = await git(directory, ["rev-parse", "--verify", `${scratch}^{commit}`])
    } catch {
      return { status: "unavailable" }
    } finally {
      await git(directory, ["update-ref", "-d", scratch]).catch(() => {})
    }
  }
  await ready()
  // The last check before writing: the remote must still name the confirmed repository.
  if (!await remoteUrl(directory, source)) return { status: "unavailable" }
  // Fails, without force, when the name was taken meanwhile.
  try { await git(directory, ["branch", "--no-track", branch, revision]) } catch { return { status: "conflict", branch } }
  try {
    await git(directory, ["config", "--local", `branch.${branch}.${KEY}`, `${workItemRepository(source)}#${kind.toLowerCase()}/${number}@${revision}`])
  } catch (error) {
    await git(directory, ["update-ref", "-d", `refs/heads/${branch}`, revision]).catch(() => {})
    throw error
  }
  return { status: "ok", branch, revision, created: true }
}
