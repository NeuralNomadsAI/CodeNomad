import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import {
  probePosixProcesses,
  probeWindowsProcesses,
  sameProcess,
  type ProcessIdentity,
} from "./process-identity"

type ClaimKind = "workspace" | "mutation"
interface ClaimRecord { token: string; kind: ClaimKind; owner: ProcessIdentity }

const ROOT = path.join(homedir(), ".codenomad", "workspace-claims")
const STATE_ROOT = path.dirname(ROOT)
const RELEASE_ATTEMPTS = 3

function probe(pid: number): ProcessIdentity | null | undefined {
  const snapshot = process.platform === "win32"
    ? probeWindowsProcesses(spawnSync, 2_000)
    : probePosixProcesses(spawnSync, 2_000, process.platform, { pids: [pid] })
  return snapshot.ok ? snapshot.processes.get(pid) ?? null : undefined
}

function managerOwner(): ProcessIdentity {
  const identity = probe(process.pid)
  if (!identity) throw new Error("Unable to capture the CodeNomad manager process identity")
  return identity
}
const managerIdentity = managerOwner()

function claimRoot(repositoryKey: string): string {
  return path.join(ROOT, createHash("sha256").update(repositoryKey).digest("hex"))
}

async function ensurePrivateRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const metadata = await lstat(root)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Workspace claim root is not a real directory: ${root}`)
  if (process.platform !== "win32") {
    if (process.getuid && metadata.uid !== process.getuid()) throw new Error(`Workspace claim root is owned by another user: ${root}`)
    await chmod(root, 0o700)
  }
}

async function activeClaims(repositoryKey: string): Promise<ClaimRecord[]> {
  const root = claimRoot(repositoryKey)
  await ensurePrivateRoot(STATE_ROOT)
  await ensurePrivateRoot(ROOT)
  await ensurePrivateRoot(root)
  const claims: ClaimRecord[] = []
  for (const entry of await readdir(root)) {
    const claimPath = path.join(root, entry)
    try {
      const claim = JSON.parse(await readFile(claimPath, "utf8")) as ClaimRecord
      if (claim.token !== entry || !["workspace", "mutation"].includes(claim.kind) || !claim.owner) {
        throw new Error(`Malformed workspace claim: ${claimPath}`)
      }
      const current = sameProcess(claim.owner, managerIdentity) ? managerIdentity : probe(claim.owner.pid)
      if (current === undefined || (current && sameProcess(claim.owner, current))) claims.push(claim)
      else await rm(claimPath, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return claims
}

export async function hasWorkspaceLifetimeClaim(
  repositoryKey: string,
  kind?: ClaimKind,
  excludingToken?: string,
): Promise<boolean> {
  return (await activeClaims(repositoryKey)).some((claim) => claim.token !== excludingToken && (!kind || claim.kind === kind))
}

export async function acquireWorkspaceLifetimeClaim(repositoryKey: string, kind: ClaimKind): Promise<{
  token: string
  release: () => Promise<void>
}> {
  const token = randomUUID()
  const root = claimRoot(repositoryKey)
  await ensurePrivateRoot(STATE_ROOT)
  await ensurePrivateRoot(ROOT)
  await ensurePrivateRoot(root)
  const claimPath = path.join(root, token)
  await writeFile(claimPath, JSON.stringify({ token, kind, owner: managerIdentity } satisfies ClaimRecord), { flag: "wx", mode: 0o600 })
  let releasePending: Promise<void> | undefined
  const release = async () => {
    let lastError: unknown
    for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt += 1) {
      try {
        await rm(claimPath, { force: true })
        return
      } catch (error) {
        lastError = error
        if (attempt + 1 < RELEASE_ATTEMPTS) await delay(40)
      }
    }
    throw lastError
  }
  return {
    token,
    release: () => releasePending ??= release().catch((error) => {
      releasePending = undefined
      throw error
    }),
  }
}
