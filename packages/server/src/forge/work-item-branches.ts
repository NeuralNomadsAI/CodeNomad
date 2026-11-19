import { randomUUID } from "node:crypto"
import type { ForgeProvider, ForgeWorkItemKind } from "../panel-extensions/contract"
import { runGitProcess } from "../workspaces/git-process"

/** The project's forge repository and the remote it is fetched from. */
export interface WorkItemBranchSource { provider: ForgeProvider; host: string; path: string; name: string }
export interface WorkItemBranch { kind: ForgeWorkItemKind; number: number; branch: string }
export type WorkItemBranchResult = { status: "ok"; branch: string; created: boolean } | { status: "conflict"; branch: string } | { status: "unavailable" }

// Host-owned link of a local branch to one item, in the repository's own config:
// Git drops it with the branch. A branch name alone is never proof.
const KEY = "codenomad-work-item"
const MAX_LINKS = 200
const FETCH_TIMEOUT_MS = 15_000
const locks = new Map<string, Promise<unknown>>()

function git(directory: string, args: string[], timeout = 10_000) {
  // Inherited repository redirection never applies; SSH transport settings do.
  const cleared = Object.fromEntries(Object.keys(process.env)
    .filter(key => key.toUpperCase().startsWith("GIT_") && !/^GIT_SSH(_COMMAND)?$/i.test(key)).map(key => [key, undefined]))
  return runGitProcess(directory, args, { priority: "foreground", timeout, maxBuffer: 256 * 1024,
    env: { ...cleared, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } }).then(output => output.trim())
}

const linkValue = (source: Pick<WorkItemBranchSource, "host" | "path">, kind: ForgeWorkItemKind, number: number) =>
  `${source.host}/${source.path}#${kind}/${number}`.toLowerCase()

/** Existing local branches linked to items of `source`'s repository. */
export async function readWorkItemBranches(directory: string, source: Pick<WorkItemBranchSource, "host" | "path">): Promise<WorkItemBranch[]> {
  const output = await git(directory, ["config", "--local", "--get-regexp", `^branch\\..*\\.${KEY}$`])
    .catch((error: { code?: unknown }) => { if (error.code === 1) return ""; throw error })
  const repository = `${source.host}/${source.path}`.toLowerCase()
  const links: WorkItemBranch[] = []
  for (const line of output.split(/\r?\n/).filter(Boolean).slice(0, MAX_LINKS)) {
    // `branch.<name>.<key> <value>`: Git lowercases the section and key, never the name.
    const space = line.indexOf(" ")
    const branch = line.slice("branch.".length, space - KEY.length - 1)
    const value = /^(.+)#(issue|pullrequest)\/([1-9]\d{0,8})$/.exec(line.slice(space + 1))
    if (branch && value?.[1] === repository) links.push({ kind: value[2] === "issue" ? "issue" : "pullRequest", number: Number(value[3]), branch })
  }
  if (!links.length) return []
  // A ref deleted without Git's branch command leaves its config behind.
  const refs = new Set((await git(directory, ["for-each-ref", "--format=%(refname)", ...links.map(link => `refs/heads/${link.branch}`)])).split(/\r?\n/))
  return links.filter(link => refs.has(`refs/heads/${link.branch}`))
}

/**
 * The item's linked branch, or a new linked one: `issue-N` from HEAD, or `pr-N`
 * at the pull request's head as the repository publishes it (forks included).
 * Never replaces or moves an existing branch; an unlinked branch of that name is a conflict.
 */
export function createWorkItemBranch(directory: string, source: WorkItemBranchSource, kind: ForgeWorkItemKind, number: number): Promise<WorkItemBranchResult> {
  const previous = locks.get(directory) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(() => create(directory, source, kind, number))
  locks.set(directory, run)
  void run.catch(() => {}).finally(() => { if (locks.get(directory) === run) locks.delete(directory) })
  return run
}

async function create(directory: string, source: WorkItemBranchSource, kind: ForgeWorkItemKind, number: number): Promise<WorkItemBranchResult> {
  const linked = (await readWorkItemBranches(directory, source)).find(link => link.kind === kind && link.number === number)
  if (linked) return { status: "ok", branch: linked.branch, created: false }
  const branch = `${kind === "issue" ? "issue" : "pr"}-${number}`
  if (await git(directory, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).catch(() => "")) return { status: "conflict", branch }
  let revision: string
  if (kind === "issue") revision = await git(directory, ["rev-parse", "--verify", "HEAD^{commit}"])
  else {
    const head = source.provider === "gitlab" ? `refs/merge-requests/${number}/head` : `refs/pull/${number}/head`
    const scratch = `refs/codenomad/fetch/${randomUUID()}`
    try {
      await git(directory, ["fetch", "--no-tags", "--no-recurse-submodules", "--", source.name, `${head}:${scratch}`], FETCH_TIMEOUT_MS)
      revision = await git(directory, ["rev-parse", "--verify", `${scratch}^{commit}`])
    } catch {
      return { status: "unavailable" }
    } finally {
      await git(directory, ["update-ref", "-d", scratch]).catch(() => {})
    }
  }
  // Fails, without force, when the name was taken meanwhile.
  try { await git(directory, ["branch", "--no-track", branch, revision]) } catch { return { status: "conflict", branch } }
  try {
    await git(directory, ["config", "--local", `branch.${branch}.${KEY}`, linkValue(source, kind, number)])
  } catch (error) {
    await git(directory, ["update-ref", "-d", `refs/heads/${branch}`, revision]).catch(() => {})
    throw error
  }
  return { status: "ok", branch, created: true }
}
