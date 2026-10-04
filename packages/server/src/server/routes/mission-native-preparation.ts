import { z } from "zod"
import type { LocationRef, OpenCodeClient, SessionInfo } from "@opencode/client"
import type { WorkspaceDescriptor } from "../../api-types"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { assertSynchronousAuthorityGuard } from "../../missions/authority-synchronous"
import { readLocationRef, sameLocation } from "../../opencode/compatibility/location"

const id = z.string().min(1).max(240).regex(/^[^\s\x00-\x1f\x7f]+$/)
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const identitySchema = z.object({
  version: z.literal(1),
  scope: z.enum(["bound-native-child", "owned-family"]),
  workspaceID: id, projectID: id, rootSessionID: id, sessionID: id,
  parentSessionID: id.nullable(),
  // Full internal location is compared exactly, including historical workspaceID.
  location: z.object({ directory: z.string().min(1).max(4096).refine(value => !value.includes("\0")), workspaceID: id.optional() }).strict(),
  profileKey: id, profileGeneration: generation, connectionIncarnation: id,
  lifecycleGeneration: generation,
  task: z.object({ missionID: id, taskKey: id, generation }).strict().optional(),
  execution: z.object({
    incarnation: id, callerSessionID: id, messageID: id, callID: id,
    boundary: z.enum(["child-first-prompt", "prompt", "command", "shell", "tool-before", "shell-environment"]),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.scope === "bound-native-child" && (!value.task || !value.parentSessionID || value.rootSessionID === value.sessionID)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Missing native child identity" })
  }
})

export type MissionNativePreparationIdentity = z.infer<typeof identitySchema>
type FrozenIdentity = Readonly<Omit<MissionNativePreparationIdentity, "location" | "execution" | "task">> & {
  readonly location: Readonly<MissionNativePreparationIdentity["location"]>
  readonly execution: Readonly<MissionNativePreparationIdentity["execution"]>
  readonly task?: Readonly<NonNullable<MissionNativePreparationIdentity["task"]>>
}

/** Construction-only trusted dependency, NEVER an HTTP/model-supplied checkpoint.
 * The genuine native authority owner must validate ALL fields, including actual
 * call/daemon incarnation, profile/task/lifecycle generations and native ancestry.
 * prepare refreshes protected claims asynchronously; current is a literal-true,
 * synchronous native capability check after EVERY await and at the actual effect.
 * It must revoke on profile change, moves, reconnect, disposal and call retirement.
 * A process ID, textual attestation, cached ENV or ordinary ancestry is not proof.
 * No producer is installed here: missing genuine host authority fails closed. */
export interface MissionNativePreparationAuthority {
  prepare(identity: FrozenIdentity, signal: AbortSignal): Promise<void>
  current(identity: FrozenIdentity): true
}

/** Narrow structural view of the real WorkspaceManager. No fallback manager,
 * profile reader, daemon transport or private snapshot builder is provided. */
interface Manager {
  get(workspaceID: string): WorkspaceDescriptor | undefined
  getSharedServiceConnection(workspaceID: string): Promise<ServiceConnection | undefined>
  ownsLocation(workspaceID: string, location: LocationRef, client: OpenCodeClient, signal: AbortSignal): Promise<boolean>
  getWorktreeIdentityForPath(workspaceID: string, directory: string): Promise<string | undefined>
  getSessionEnvironment(workspaceID: string, signal: AbortSignal): Promise<Record<string, string>>
}

export class MissionNativePreparationError extends Error {
  constructor(readonly code: "native-authority-unavailable" | "native-preparation-stale" | "native-family-unresolved"
    | "native-preparation-unavailable" | "native-environment-uncertain") {
    super(code)
  }
}

export interface PreparedMissionNativeExecution {
  /** Identity-only observation for this execution incarnation, NOT durable readiness,
   * task/report authority, a process overlay or provider-configuration evidence. */
  readonly receipt: FrozenIdentity & { readonly prepared: true }
  /** Native executor calls synchronously immediately before its actual effect,
   * without another await. Captured callbacks fail after release/adapter disposal. */
  current(): true
  /** Native executor releases in finally; retain admission through its effect. */
  dispose(): void
}

/** Experimental internal seam only. No route registration, prompt/command/Shell
 * execution, instruction writes, automatic replay, ENV disclosure or ready cache.
 * Each required native boundary needs a NEW call to prepare. The identity-less
 * final Shell hook after asynchronous permission remains a native runtime gap;
 * do not invent an identity or claim that this adapter closes that gap. */
export function createMissionNativePreparation(deps: {
  manager: Manager
  fence: WorktreeDeletionFence
  authority: MissionNativePreparationAuthority
}) {
  if (!deps.authority || typeof deps.authority.prepare !== "function" || typeof deps.authority.current !== "function") {
    throw new MissionNativePreparationError("native-authority-unavailable")
  }
  // Capture trusted callbacks so replacement cannot silently adopt new authority.
  const prepareAuthority = deps.authority.prepare.bind(deps.authority)
  const currentAuthority = deps.authority.current.bind(deps.authority)
  let disposed = false
  const active = new Set<() => void>()

  return {
    async prepare(input: MissionNativePreparationIdentity, signal: AbortSignal): Promise<PreparedMissionNativeExecution> {
      let identity: FrozenIdentity
      try {
        const parsed = identitySchema.parse(input)
        identity = Object.freeze({ ...parsed, location: Object.freeze(parsed.location), execution: Object.freeze(parsed.execution),
          ...(parsed.task ? { task: Object.freeze(parsed.task) } : {}) })
      } catch { throw new MissionNativePreparationError("native-family-unresolved") }
      const workspace = deps.manager.get(identity.workspaceID)
      let connection: ServiceConnection | undefined
      let identities: string[] = []
      let release: (() => void) | undefined
      let closed = false
      const dispose = () => {
        if (closed) return
        closed = true
        release?.()
        active.delete(dispose)
      }
      active.add(dispose)
      const current = (): true => {
        if (disposed || closed || signal.aborted || !workspace || workspace.status !== "ready"
          || deps.manager.get(identity.workspaceID) !== workspace || identities.some(path => deps.fence.isBlocked(path))) {
          throw new MissionNativePreparationError("native-preparation-stale")
        }
        try {
          connection?.assertCurrent()
          assertSynchronousAuthorityGuard(() => currentAuthority(identity), "policy-unqualified")
        } catch { throw new MissionNativePreparationError("native-preparation-stale") }
        return true
      }
      const wait = async <T>(operation: () => Promise<T>): Promise<T> => {
        current()
        const result = await operation()
        current()
        return result
      }
      try {
        current()
        connection = await wait(() => deps.manager.getSharedServiceConnection(identity.workspaceID))
        if (!connection) throw new MissionNativePreparationError("native-preparation-unavailable")
        current()
        const client = connection.client

        // Walk actual native parents to the known root. Never derive a root from
        // textual project IDs, list gaps or an unresolved ancestor. 32 edges max.
        const readFamily = async (): Promise<SessionInfo[]> => {
          const members: SessionInfo[] = []
          const seen = new Set<string>()
          let sessionID = identity.sessionID
          for (let depth = 0; depth <= 32; depth++) {
            if (seen.has(sessionID)) throw new MissionNativePreparationError("native-family-unresolved")
            seen.add(sessionID)
            const session = await wait(() => client.session.get({ sessionID }, { signal }))
            if (session.id !== sessionID || session.projectID !== identity.projectID
              || !sameLocation(readLocationRef(session.location), identity.location)
              || (depth === 0 && (session.parentID ?? null) !== identity.parentSessionID)) {
              throw new MissionNativePreparationError("native-family-unresolved")
            }
            if (!await wait(() => deps.manager.ownsLocation(identity.workspaceID, session.location, client, signal))) {
              throw new MissionNativePreparationError("native-family-unresolved")
            }
            members.push(session)
            if (sessionID === identity.rootSessionID) {
              if (session.parentID) throw new MissionNativePreparationError("native-family-unresolved")
              return members
            }
            if (!session.parentID) throw new MissionNativePreparationError("native-family-unresolved")
            sessionID = session.parentID
          }
          throw new MissionNativePreparationError("native-family-unresolved")
        }
        const original = await readFamily()
        current()
        for (const session of original) {
          const path = await wait(() => deps.manager.getWorktreeIdentityForPath(identity.workspaceID, session.location.directory))
          if (!path) throw new MissionNativePreparationError("native-family-unresolved")
          identities.push(path)
        }
        identities = [...new Set(identities)]
        current()
        release = deps.fence.enter(identities)
        if (!release) throw new MissionNativePreparationError("native-preparation-stale")

        const recheckFamily = async () => {
          const fresh = await readFamily()
          current()
          if (fresh.length !== original.length || fresh.some((session, index) => session.id !== original[index].id
            || session.parentID !== original[index].parentID)) throw new MissionNativePreparationError("native-family-unresolved")
          for (const session of fresh) {
            const path = await wait(() => deps.manager.getWorktreeIdentityForPath(identity.workspaceID, session.location.directory))
            if (!path || !identities.includes(path)) throw new MissionNativePreparationError("native-preparation-stale")
          }
          current()
        }
        await wait(() => prepareAuthority(identity, signal))
        // Existing manager performs a fresh bounded profile-document read and uses
        // session-environment.ts for the COMPLETE host/WSL snapshot, stripping
        // private bridge/service credentials and storage-ownership variables.
        // ENV values remain local, never appear in receipt/error/logs/model/browser.
        const variables = await wait(() => deps.manager.getSessionEnvironment(identity.workspaceID, signal))
        await recheckFamily()
        current()
        try { await wait(() => client.session.environment({ sessionID: identity.sessionID, variables }, { signal })) }
        catch (error) {
          if (error instanceof MissionNativePreparationError) throw error
          // Transport rejection may follow an applied ENV write. Do not retry it,
          // execute the original mutation, repair a receipt or infer non-admission.
          throw new MissionNativePreparationError("native-environment-uncertain")
        }
        await wait(() => prepareAuthority(identity, signal))
        await recheckFamily()
        current()
        return Object.freeze({ receipt: Object.freeze({ ...identity, prepared: true as const }), current, dispose })
      } catch (error) {
        dispose()
        if (error instanceof MissionNativePreparationError) throw error
        // SDK/parser failures can carry request bodies/ENV; do not attach causes.
        throw new MissionNativePreparationError("native-preparation-unavailable")
      }
    },
    dispose() {
      disposed = true
      for (const release of [...active]) release()
    },
  }
}
