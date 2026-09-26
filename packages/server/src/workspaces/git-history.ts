import type { GitCommitDetails, GitCommitFile, GitHistoryPage, GitCommitDiff } from "../git-history-types"
import { runGitProcess } from "./git-process"

const git = (directory: string, args: string[]) => runGitProcess(directory, args, { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 })

function commitId(value: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error("Invalid commit ID")
  return value
}

async function headId(directory: string): Promise<string | null> {
  try { return (await git(directory, ["rev-parse", "--verify", "--quiet", "HEAD"])).trim() }
  catch (error) {
    if ((error as { code?: number }).code === 1) return null // Unborn branch.
    throw error
  }
}

export async function getGitHistory(directory: string, offset = 0, snapshot?: string): Promise<GitHistoryPage> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid history offset")
  const head = snapshot ? commitId(snapshot) : await headId(directory)
  const branch = (await git(directory, ["branch", "--show-current"])).trim() || null
  if (!head) return { head, branch, commits: [], hasMore: false }
  const output = await git(directory, ["log", "-z", "--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%D", "--max-count=51", `--skip=${offset}`, head, "--"])
  const fields = output.split("\0")
  const commits = []
  for (let i = 0; i + 5 < fields.length; i += 6) {
    commits.push({ id: fields[i]!, parents: fields[i + 1]!.split(" ").filter(Boolean), author: fields[i + 2]!,
      date: fields[i + 3]!, subject: fields[i + 4]!, refs: fields[i + 5]! })
  }
  return { head, branch, commits: commits.slice(0, 50), hasMore: commits.length > 50 }
}

export async function getGitCommit(directory: string, revision: string): Promise<GitCommitDetails> {
  const id = commitId(revision)
  if ((await git(directory, ["cat-file", "-t", id])).trim() !== "commit") throw new Error("Object is not a commit")
  const parents = (await git(directory, ["show", "-s", "--format=%P", id, "--"])).trim().split(" ").filter(Boolean)
  const parent = parents[0] ? commitId(parents[0]) : null
  const output = await git(directory, ["diff-tree", "--root", "--no-commit-id", "-r", "-M", "--name-status", "-z", ...(parent ? [parent, id] : [id]), "--"])
  const tokens = output.split("\0")
  const files: GitCommitFile[] = []
  for (let i = 0; i < tokens.length && tokens[i];) {
    const status = tokens[i++]!
    const first = tokens[i++]!
    const renamed = status.startsWith("R") || status.startsWith("C")
    const path = renamed ? tokens[i++]! : first
    files.push({ path, originalPath: renamed ? first : null, status: status[0]! })
  }
  const message = (await git(directory, ["show", "-s", "--format=%B", id, "--"])).trimEnd()
  return { id, parent, message, files }
}

export async function getGitCommitDiff(directory: string, revision: string, filePath: string): Promise<GitCommitDiff> {
  const commit = await getGitCommit(directory, revision)
  // Authoritative file membership prevents arbitrary revision/path expressions.
  const file = commit.files.find(file => file.path === filePath)
  if (!file) throw new Error("File does not belong to this commit")
  const [before, after] = await Promise.all([
    !commit.parent || file.status === "A" ? "" : readCommitFile(directory, commit.parent, file.originalPath ?? file.path),
    file.status === "D" ? "" : readCommitFile(directory, commit.id, file.path),
  ])
  const isBinary = before.includes("\0") || after.includes("\0")
  return { path: file.path, before: isBinary ? "" : before, after: isBinary ? "" : after, isBinary }
}

async function readCommitFile(directory: string, revision: string, filePath: string): Promise<string> {
  const entry = await git(directory, ["ls-tree", "-z", revision, "--", `:(literal)${filePath}`])
  const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t/.exec(entry)
  if (!match) throw new Error("Commit file is unavailable")
  // Gitlinks point to another repository; never read a submodule's working tree
  // or mistake its commit object/message for the file's contents.
  if (match[1] === "160000") return `Subproject commit ${match[3]}\n`
  return git(directory, ["cat-file", "blob", match[3]!])
}
