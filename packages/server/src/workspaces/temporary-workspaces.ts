import path from "node:path"
import { randomBytes } from "node:crypto"
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { isSessionNotFoundError, type OpenCodeClient, type SessionInfo } from "@opencode/client"
import type { WorkspaceManager } from "./manager"
import type { WorktreeDeletionFence } from "./worktree-session-evacuation"
import { normalizeWslUncPath } from "./worktree-directory"

const PAGE_SIZE = 200
const MAX_PAGES = 1_000

/** Stable codes the client localizes; messages stay English diagnostics. */
export type TemporaryWorkspaceErrorCode =
  | "temporary_not_found"
  | "temporary_not_temporary"
  | "temporary_open_elsewhere"
  | "temporary_running"
  | "temporary_not_empty"

export class TemporaryWorkspaceError extends Error {
  constructor(readonly code: TemporaryWorkspaceErrorCode, message: string, readonly statusCode: number) {
    super(message)
    this.name = "TemporaryWorkspaceError"
  }
}

// Host-local identity; temporary folders are never WSL UNC paths.
function hostIdentity(folder: string, platform: NodeJS.Platform): string {
  const normalized = path.normalize(folder).replace(/[\\/]+$/, "")
  return platform === "win32" ? normalized.toLowerCase() : normalized
}

/**
 * Folders created as temporary workspaces and not yet kept. Membership, not
 * location, makes a folder temporary: a kept folder stays where it is.
 */
export class TemporaryFolderRegistry {
  private readonly folders = new Map<string, string>()
  private writes: Promise<void> = Promise.resolve()

  private constructor(
    readonly root: string,
    private readonly file: string,
    private readonly platform: NodeJS.Platform,
  ) {}

  /** Creates the root, reads the registry and forgets folders that no longer exist. */
  static async open(root: string, file: string, platform = process.platform): Promise<TemporaryFolderRegistry> {
    await mkdir(root, { recursive: true })
    const registry = new TemporaryFolderRegistry(await realpath(root), file, platform)
    let saved: unknown
    try {
      saved = JSON.parse(await readFile(file, "utf8"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const folders = Array.isArray((saved as { folders?: unknown })?.folders) ? (saved as { folders: unknown[] }).folders : []
    let pruned = false
    for (const folder of folders) {
      if (typeof folder !== "string" || !registry.isUnderRoot(folder)) { pruned = true; continue }
      const exists = await realpath(folder).then(() => true, () => false)
      if (exists) registry.folders.set(hostIdentity(folder, platform), folder)
      else pruned = true
    }
    if (pruned) await registry.save()
    return registry
  }

  /** Only direct children of the CodeNomad-owned root can ever be temporary. */
  private isUnderRoot(folder: string): boolean {
    return hostIdentity(path.dirname(path.normalize(folder)), this.platform) === hostIdentity(this.root, this.platform)
  }

  has(folder: string): boolean {
    return this.isUnderRoot(folder) && this.folders.has(hostIdentity(folder, this.platform))
  }

  list(): string[] {
    return [...this.folders.values()]
  }

  sameFolder(left: string, right: string): boolean {
    return hostIdentity(left, this.platform) === hostIdentity(right, this.platform)
  }

  async add(folder: string): Promise<void> {
    this.folders.set(hostIdentity(folder, this.platform), folder)
    await this.save()
  }

  async delete(folder: string): Promise<void> {
    if (this.folders.delete(hostIdentity(folder, this.platform))) await this.save()
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify({ folders: [...this.folders.values()] }, null, 2)
    this.writes = this.writes.catch(() => {}).then(async () => {
      const temp = `${this.file}.${process.pid}.tmp`
      await writeFile(temp, snapshot, "utf8")
      await rename(temp, this.file)
    })
    return this.writes
  }
}

function normalizeDirectory(directory: string): string {
  const wsl = normalizeWslUncPath(directory)
  if (wsl) return wsl
  const normalized = directory.trim().replace(/\\/g, "/").replace(/\/+$/, "") || "/"
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized
}

function within(root: string, directory: string): boolean {
  const base = normalizeDirectory(root), target = normalizeDirectory(directory)
  return target === base || target.startsWith(`${base}/`)
}

async function listSessions(client: OpenCodeClient, directory: string): Promise<SessionInfo[]> {
  const sessions = new Map<string, SessionInfo>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await client.session.list(cursor ? { cursor: cursor as never } : { directory: directory as never, limit: PAGE_SIZE })
    for (const session of result.data) {
      if (within(directory, session.location.directory)) sessions.set(session.id, session)
    }
    const next = result.cursor.next ?? undefined
    if (!next || next === cursor) return [...sessions.values()]
    cursor = next
  }
  throw new Error("Temporary conversation inventory exceeded its page limit")
}

/** Children before parents, so native removal never sees a parent with live children. */
function deepestFirst(sessions: SessionInfo[]): SessionInfo[] {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const depth = (session: SessionInfo) => {
    let count = 0
    for (let parent = session.parentID; parent && byId.has(parent) && count < sessions.length; parent = byId.get(parent)!.parentID) count += 1
    return count
  }
  return [...sessions].sort((left, right) => depth(right) - depth(left))
}

export class TemporaryWorkspaces {
  constructor(private readonly options: {
    registry: TemporaryFolderRegistry
    workspaceManager: WorkspaceManager
    deletionFence: WorktreeDeletionFence
    /** Receives every registered folder after the registry changes. */
    onChange?: (folders: string[]) => void
  }) {}

  /** Registered folders, including ones no tab currently shows. */
  list(): string[] {
    return this.options.registry.list()
  }

  private changed() {
    this.options.onChange?.(this.options.registry.list())
  }

  /** Creates and registers an empty, uniquely named folder under the temporary root. */
  async createFolder(now = new Date()): Promise<string> {
    const { registry } = this.options
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-")
    const folder = path.join(registry.root, `${stamp}-${randomBytes(4).toString("hex")}`)
    await mkdir(folder)
    await registry.add(folder)
    this.changed()
    return folder
  }

  /** Removes a registered folder that never opened, e.g. after a failed launch. */
  async abandonFolder(folder: string): Promise<void> {
    const { registry, workspaceManager } = this.options
    if (!registry.has(folder)) throw new TemporaryWorkspaceError("temporary_not_temporary", "This folder is not temporary", 400)
    await this.options.deletionFence.run(folder, [folder], async () => {
      // The reservation compares canonical identities, refuses any open
      // workspace inside the folder and blocks new workspaces until released.
      const release = await workspaceManager.reserveWorktreeDeletion(folder).catch(() => {
        throw new TemporaryWorkspaceError("temporary_open_elsewhere", "This temporary folder is open in a tab", 409)
      })
      try {
        const entries = await readdir(folder).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return []
          throw error
        })
        if (entries.length) throw new TemporaryWorkspaceError("temporary_not_empty", "This temporary folder is not empty", 409)
        await rm(folder, { recursive: true, force: true })
      } finally {
        release()
      }
      await registry.delete(folder)
      this.changed()
    })
  }

  private requireTemporary(workspaceId: string) {
    const workspace = this.options.workspaceManager.get(workspaceId)
    if (!workspace) throw new TemporaryWorkspaceError("temporary_not_found", "Workspace not found", 404)
    if (!this.options.registry.has(workspace.path)) {
      throw new TemporaryWorkspaceError("temporary_not_temporary", "This workspace is not temporary", 400)
    }
    return workspace
  }

  /** Keeps the folder and its conversations as an ordinary project. */
  async keep(workspaceId: string): Promise<void> {
    const workspace = this.requireTemporary(workspaceId)
    await this.options.registry.delete(workspace.path)
    this.options.workspaceManager.clearTemporary(workspace.path)
    this.changed()
  }

  /**
   * Removes a temporary workspace's conversations, closes the workspace and
   * deletes its folder. Running conversations and other open tabs of the
   * folder block the discard; nothing is removed in that case.
   */
  async discard(workspaceId: string): Promise<void> {
    const manager = this.options.workspaceManager
    const workspace = this.requireTemporary(workspaceId)
    if (manager.list().some((other) => other.id !== workspaceId && this.options.registry.sameFolder(other.path, workspace.path))) {
      throw new TemporaryWorkspaceError("temporary_open_elsewhere", "This temporary folder is open in another tab", 409)
    }
    const serviceDirectory = manager.getServiceDirectory(workspaceId) ?? workspace.path
    await this.options.deletionFence.run(workspace.path, [workspace.path, serviceDirectory], async () => {
      const client = await manager.getSharedServiceClient()
      const sessions = await listSessions(client, serviceDirectory)
      const active = await client.session.active()
      if (sessions.some((session) => Object.prototype.hasOwnProperty.call(active, session.id))) {
        throw new TemporaryWorkspaceError("temporary_running", "A conversation is still running in this temporary instance", 409)
      }
      for (const session of deepestFirst(sessions)) {
        try {
          await client.session.remove({ sessionID: session.id })
        } catch (error) {
          // A parent removal may already have taken its children.
          if (!isSessionNotFoundError(error)) throw error
        }
      }
      await manager.delete(workspaceId)
      const release = await manager.reserveWorktreeDeletion(workspace.path)
      try {
        await rm(workspace.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } finally {
        release()
      }
      // A failed removal stays registered; the home page lists it for another discard.
      await this.options.registry.delete(workspace.path)
      this.changed()
    })
  }
}
