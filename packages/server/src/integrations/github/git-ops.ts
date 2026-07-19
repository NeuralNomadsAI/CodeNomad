import fs from "fs"
import os from "os"
import path from "path"
import { spawn } from "child_process"

type GitResult = { ok: true; stdout: string } | { ok: false; error: Error; stdout?: string; stderr?: string }

function runGit(args: string[], cwd: string, env?: Record<string, string | undefined>): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(env ?? {}) },
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString() })
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString() })
    child.once("error", (error) => resolve({ ok: false, error, stdout, stderr }))
    child.once("close", (code) => {
      if (code === 0) resolve({ ok: true, stdout })
      else resolve({ ok: false, error: new Error(stderr.trim() || `git ${args.join(" ")} failed with code ${code}`), stdout, stderr })
    })
  })
}

async function withGitAskpass<T>(token: string, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codenomad-git-"))
  const isWindows = process.platform === "win32"
  const askpassPath = path.join(tmp, isWindows ? "askpass.cmd" : "askpass.sh")
  const script = isWindows
    ? "@echo off\r\nsetlocal EnableDelayedExpansion\r\nset \"PROMPT=%*\"\r\necho !PROMPT! | findstr /I \"username\" >nul\r\nif %errorlevel%==0 (\r\n  echo x-access-token\r\n) else (\r\n  echo %GITHUB_TOKEN%\r\n)\r\n"
    : "#!/bin/sh\ncase \"$1\" in\n  *Username*|*username*)\n    echo x-access-token\n    ;;\n  *)\n    echo \"$GITHUB_TOKEN\"\n    ;;\nesac\n"
  await fs.promises.writeFile(askpassPath, script, { encoding: "utf-8", mode: isWindows ? undefined : 0o700 })
  try {
    return await fn({ GITHUB_TOKEN: token, GIT_ASKPASS: askpassPath, GIT_TERMINAL_PROMPT: "0" })
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function ensureClonedAndUpdated(params: {
  repoUrl: string
  directory: string
  defaultBranch: string
  token: string
}): Promise<void> {
  await fs.promises.mkdir(path.dirname(params.directory), { recursive: true })
  const exists = fs.existsSync(path.join(params.directory, ".git"))
  await withGitAskpass(params.token, async (env) => {
    if (!exists) {
      const clone = await runGit(["clone", "--no-tags", params.repoUrl, params.directory], process.cwd(), env)
      if (!clone.ok) throw clone.error
    }

    const dirty = await runGit(["status", "--porcelain"], params.directory, env)
    if (dirty.ok && dirty.stdout.trim()) {
      await runGit(["reset", "--hard"], params.directory, env)
      await runGit(["clean", "-fd"], params.directory, env)
    }

    const fetch = await runGit(["fetch", "origin", params.defaultBranch, "--prune"], params.directory, env)
    if (!fetch.ok) throw fetch.error
    const checkout = await runGit(["checkout", params.defaultBranch], params.directory, env)
    if (!checkout.ok) {
      const create = await runGit(["checkout", "-B", params.defaultBranch, `origin/${params.defaultBranch}`], params.directory, env)
      if (!create.ok) throw create.error
    }
    const reset = await runGit(["reset", "--hard", "FETCH_HEAD"], params.directory, env)
    if (!reset.ok) throw reset.error
    const clean = await runGit(["clean", "-fd"], params.directory, env)
    if (!clean.ok) throw clean.error
  })
}

export async function gitCurrentBranch(cwd: string): Promise<string> {
  const result = await runGit(["branch", "--show-current"], cwd)
  if (!result.ok) throw result.error
  return result.stdout.trim()
}

export async function gitIsClean(cwd: string): Promise<boolean> {
  const result = await runGit(["status", "--porcelain"], cwd)
  if (!result.ok) throw result.error
  return result.stdout.trim().length === 0
}

export async function gitPushHead(params: { cwd: string; remoteUrl: string; branch: string; token: string }): Promise<void> {
  await withGitAskpass(params.token, async (env) => {
    const push = await runGit(["push", params.remoteUrl, `HEAD:refs/heads/${params.branch}`], params.cwd, env)
    if (!push.ok) throw push.error
  })
}

export async function gitRemoteRefExists(params: { cwd: string; remoteUrl: string; ref: string; token: string }): Promise<boolean> {
  return await withGitAskpass(params.token, async (env) => {
    const result = await runGit(["ls-remote", params.remoteUrl, params.ref], params.cwd, env)
    if (!result.ok) return false
    return Boolean((result.stdout ?? "").trim().split(/\r?\n/)[0]?.trim())
  })
}

export async function gitFetchAndResetToRemote(params: { cwd: string; remoteUrl: string; ref: string; token: string }): Promise<void> {
  await withGitAskpass(params.token, async (env) => {
    const fetch = await runGit(["fetch", params.remoteUrl, params.ref], params.cwd, env)
    if (!fetch.ok) throw fetch.error
  })
  const reset = await runGit(["reset", "--hard", "FETCH_HEAD"], params.cwd)
  if (!reset.ok) throw reset.error
  const clean = await runGit(["clean", "-fd"], params.cwd)
  if (!clean.ok) throw clean.error
}
