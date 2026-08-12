import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"

const LOCK_REF = "refs/codenomad/locks/repository"
const RETRY_MS = 40

function runGit(workspaceFolder: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: workspaceFolder, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.once("error", reject)
    child.once("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `git ${args.join(" ")} failed`)))
  })
}

async function ensureLockRef(workspaceFolder: string): Promise<string> {
  const existing = await runGit(workspaceFolder, ["rev-parse", "--verify", LOCK_REF]).catch(() => "")
  if (existing) return existing
  const head = await runGit(workspaceFolder, ["rev-parse", "HEAD"])
    .catch(() => runGit(workspaceFolder, ["hash-object", "-t", "tree", "/dev/null"])
      .catch(() => runGit(workspaceFolder, ["mktree"])))
  await runGit(workspaceFolder, ["update-ref", LOCK_REF, head, ""]).catch(() => undefined)
  return runGit(workspaceFolder, ["rev-parse", "--verify", LOCK_REF])
}

function prepare(workspaceFolder: string, oid: string, signal?: AbortSignal): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["update-ref", "--stdin"], { cwd: workspaceFolder, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", abort)
      error ? reject(error) : resolve(child)
    }
    const abort = () => {
      child.kill()
      finish(signal?.reason ?? new Error("Repository mutation was cancelled"))
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      if (stdout.includes("prepare: ok")) finish()
    })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.once("error", finish)
    child.once("close", (code) => {
      if (!settled) finish(new Error(stderr.trim() || `git update-ref exited with code ${code}`))
    })
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) return abort()
    child.stdin.write(`start\nupdate ${LOCK_REF} ${oid} ${oid}\nprepare\n`)
  })
}

export async function acquireGitRepositoryLock(
  workspaceFolder: string,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  const oid = await ensureLockRef(workspaceFolder)
  let child: ChildProcessWithoutNullStreams
  while (true) {
    signal?.throwIfAborted()
    try {
      child = await prepare(workspaceFolder, oid, signal)
      break
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      if (!String(error).toLowerCase().includes("lock")) throw error
      await delay(RETRY_MS, undefined, { signal })
    }
  }

  let releasePending: Promise<void> | undefined
  return () => releasePending ??= new Promise<void>((resolve) => {
    child.once("close", () => resolve())
    child.stdin.end("abort\n")
  })
}

export async function withGitRepositoryLock<T>(
  workspaceFolder: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const release = await acquireGitRepositoryLock(workspaceFolder, signal)
  try {
    return await operation()
  } finally {
    await release()
  }
}
