import { realpath } from "node:fs/promises"
import path from "node:path"
import type { WorkspaceManager } from "../workspaces/manager"
import { readFamilyAuthorityIdentity, type FamilyAuthorityClaim } from "../workspaces/family-authority-claim"
import { resolveRepoRoot } from "../workspaces/git-worktrees"
import { canonicalAuthority, rejectAuthority, type AuthorityRoot } from "./authority-protocol"
import { assertSynchronousAuthorityGuard } from "./authority-synchronous"
import type { MissionLocation } from "./model"
import type { ServiceConnection } from "../workspaces/opencode-service"

export type RootManager = Pick<WorkspaceManager, "getSharedServiceConnection" | "getExistingSharedServiceConnection" | "ownsLocation" | "getHostPathForServicePath">
export interface HeldFamilyClaim { readonly family: string; readonly claim: FamilyAuthorityClaim }
const identity = (value: string) => process.platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value)

/** Explicit claims come from the shared physical-family store, not a new
 * profile-scoped store. No acquisition on reads, expiry takeover or migration.
 * Cross-host/WSL roots require a native physical resolver; local mapping alone
 * cannot prove a Linux Git common-directory identity. */
export class CanonicalMissionRoots {
  private readonly claims: readonly HeldFamilyClaim[]
  constructor(private readonly manager: RootManager, private readonly workspaceID: string,
    claims: readonly HeldFamilyClaim[], private readonly assertClaimCurrent: (claim: HeldFamilyClaim) => true) {
    this.claims = Object.freeze(claims.map(entry => Object.freeze({ ...entry })))
  }
  async resolve(location: MissionLocation): Promise<AuthorityRoot> {
    const connection = await this.manager.getSharedServiceConnection(this.workspaceID)
    return this.resolveConnection(location, connection)
  }
  async resolveExisting(location: MissionLocation, signal: AbortSignal): Promise<AuthorityRoot> {
    signal.throwIfAborted()
    return this.resolveConnection(location, this.manager.getExistingSharedServiceConnection(this.workspaceID), "event", signal)
  }
  private async resolveConnection(location: MissionLocation, connection: ServiceConnection | undefined,
    purpose: "request" | "event" = "request", signal?: AbortSignal): Promise<AuthorityRoot> {
    if ("workspaceID" in location || !connection
      || !await this.manager.ownsLocation(this.workspaceID, location, connection.client, signal, purpose)) rejectAuthority("binding-mismatch")
    const hostPath = await this.manager.getHostPathForServicePath(this.workspaceID, location.directory)
    // No guessed WSL translation or independent Windows claim for Linux roots.
    if (!hostPath || identity(hostPath) !== identity(location.directory)) rejectAuthority("observation-unavailable")
    const checkout = identity(await realpath((await resolveRepoRoot(hostPath)).repoRoot))
    const family = await readFamilyAuthorityIdentity(hostPath)
    const held = this.claims.find(entry => entry.family === family)
    if (!held) rejectAuthority("authorization-blocked")
    await held.claim.assertCurrent()
    signal?.throwIfAborted()
    connection.assertCurrent()
    assertSynchronousAuthorityGuard(() => this.assertClaimCurrent(held), "policy-unqualified")
    return { mode: "git", directory: location.directory, family, checkout }
  }
  async assertRoots(roots: readonly AuthorityRoot[]): Promise<void> {
    for (const expected of roots) {
      const current = await this.resolve({ directory: expected.directory })
      if (canonicalAuthority(current) !== canonicalAuthority(expected)) rejectAuthority("binding-mismatch")
    }
    this.current(roots)
  }
  async assertExistingRoots(roots: readonly AuthorityRoot[], signal: AbortSignal): Promise<void> {
    for (const expected of roots) {
      const current = await this.resolveExisting({ directory: expected.directory }, signal)
      if (canonicalAuthority(current) !== canonicalAuthority(expected)) rejectAuthority("binding-mismatch")
    }
    this.current(roots)
  }
  current(roots: readonly AuthorityRoot[]): true {
    for (const root of roots) {
      if (root.mode !== "git") rejectAuthority("observation-unavailable")
      const held = this.claims.find(entry => entry.family === root.family)
      if (!held) rejectAuthority("authorization-blocked")
      assertSynchronousAuthorityGuard(() => this.assertClaimCurrent(held), "policy-unqualified")
    }
    return true
  }
  /** Called only after accepted native map-deletion evidence. Stopped maps keep
   * their exact owned references for terminal bookkeeping; retained ownership
   * does not enable sends. Other references/disposal remain with their owner. */
  async releaseAfterMapDeletion(roots: readonly AuthorityRoot[], assertAuthorityCurrent: () => true): Promise<void> {
    assertSynchronousAuthorityGuard(assertAuthorityCurrent, "policy-unqualified")
    await this.assertRoots(roots)
    assertSynchronousAuthorityGuard(assertAuthorityCurrent, "policy-unqualified")
    const families = new Set(roots.filter(root => root.mode === "git").map(root => root.family))
    for (const held of this.claims) if (families.has(held.family)) {
      assertSynchronousAuthorityGuard(assertAuthorityCurrent, "policy-unqualified")
      await held.claim.release()
    }
  }
}
