import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Option, Schema } from "effect"
import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { recurrenceConfigSchema, recurrenceIDSchema, type RecurrenceDocument } from "../../missions/recurrence-contract"
import { RecurrenceCreateCapacityError } from "../../missions/recurrence-store"
import { physical } from "../../missions/host-authority/private-files"
import { readFamilyAuthorityIdentity } from "../../workspaces/family-authority-claim"
import { stableToken } from "../../missions/journal"
import { z } from "zod"
import { resolveRepoRoot } from "../../workspaces/git-worktrees"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import { assertRecurrenceDispatchFeasible } from "../../missions/recurrence-read-budget"
import { assertRecurrenceBridgeProof, nativeRecurrenceControlInputSchema } from "./native-recurrence-control"

const locationTag = Context.Service<never, unknown>("@opencode/Location")
const requestSchema = Schema.Struct({ id: Schema.String, requestID: Schema.String, digest: Schema.String,
  config: Schema.Unknown, directory: Schema.String, scope: Schema.Unknown, executionHost: Schema.String, transport: Schema.Unknown })
const profileScope = z.object({ channel: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  configIdentity: z.string().min(1).max(4096), key: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const recurrenceScheduleID = (projectID: string, canonical: string, requestID: string) =>
  `rcs_${stableToken(`${projectID}\0${canonical}\0${requestID}`, 40)}`
export const recurrenceConfigDigest = (config: unknown) =>
  createHash("sha256").update(canonicalAuthority(config, 64 * 1024)).digest("hex")

/** Native service Location, Git and execution host are independent of caller
 * root claims. Paused CREATE still refuses a permanently unusable placement. */
export async function assertNativeRecurrenceCreateScope(directory: string, config: z.infer<typeof recurrenceConfigSchema>,
  rawScope: unknown, executionHost: string): Promise<void> {
  const scope = profileScope.parse(rawScope)
  const nativeHost = process.platform === "linux" && process.env.WSL_DISTRO_NAME
    ? `wsl:${process.env.WSL_DISTRO_NAME}` : "local"
  if (scope.key !== createHash("sha256").update(`${scope.channel}\0${scope.configIdentity}`).digest("hex")
    || config.profileID !== scope.key || config.executionHost !== executionHost
    || executionHost !== nativeHost) {
    throw new Error("Recurrence profile or host differs from its selected scope")
  }
  const checkout = await resolveRepoRoot(directory)
  if (!checkout.isGitRepo) throw new Error("Recurrence native checkout unavailable")
  const root = { mode: "git", directory, family: await readFamilyAuthorityIdentity(directory),
    checkout: physical(await realpath(checkout.repoRoot)) }
  if (canonicalAuthority(config.roots) !== canonicalAuthority([root])) throw new Error("Recurrence native root differs")
}

/** Fixed native RPCs. The caller cannot supply a project, host path or storage
 * identity. No standing authority is minted, and no scheduler or Job is started. */
export const nativeRecurrenceHandlers = (ctx: Pick<Plugin.Context, "location" | "storage">) => {
  const location = Effect.gen(function* () {
    const origin = yield* Effect.serviceOption(locationTag)
    if (Option.isNone(origin)) throw new Error("Native recurrence Location unavailable")
    const value = yield* Schema.decodeUnknownEffect(Schema.toType(Schema.Struct(Location.Info.fields)))(origin.value)
    if (value.directory !== ctx.location.directory || value.workspaceID !== ctx.location.workspaceID
      || value.project.id !== ctx.location.project.id || value.project.canonical !== ctx.location.project.canonical) {
      throw new Error("Native recurrence Location changed")
    }
    return value
  })
  const summary = (doc: RecurrenceDocument) => ({ schedule: {
    id: doc.id, revision: doc.revision, state: doc.state, digest: recurrenceConfigDigest(doc.config),
    projectID: doc.projectID, projectCanonical: doc.projectCanonical,
  } })
  return {
    recurrenceRead: (input: { id: string }) => Effect.gen(function* () {
      yield* location
      const store = yield* acquireNativeRecurrenceStore(ctx)
      const doc = yield* Effect.promise(() => store.read(recurrenceIDSchema.parse(input.id)))
      return doc ? summary(doc) : { schedule: null }
    }),
    recurrenceCreate: (raw: unknown) => Effect.gen(function* () {
      const native = yield* location
      const input = yield* Schema.decodeUnknownEffect(requestSchema)(raw)
      const transport = yield* Schema.decodeUnknownEffect(nativeRecurrenceControlInputSchema)(input.transport)
      if (transport.action !== "create" || transport.requestID !== input.requestID || transport.scheduleID !== input.id
        || transport.expectedRevision !== 0 || transport.configDigest !== input.digest || transport.location.directory !== native.directory
        || transport.location.workspaceID !== native.workspaceID) throw new Error("Recurrence creation transport differs")
      yield* Effect.tryPromise(() => assertRecurrenceBridgeProof(transport))
      const id = recurrenceIDSchema.parse(input.id)
      if (!/^[A-Za-z0-9_-]{3,100}$/.test(input.requestID)
        || id !== recurrenceScheduleID(native.project.id, native.project.canonical, input.requestID)
        || input.directory !== native.directory) throw new Error("Recurrence creation identity differs")
      const config = recurrenceConfigSchema.parse(input.config)
      if (recurrenceConfigDigest(config) !== input.digest || config.roots.length !== 1
        || config.roots[0].directory !== native.directory || transport.profileSource.profileID !== config.profileID
        || transport.profileSource.executionHost !== config.executionHost) throw new Error("Recurrence creation scope differs")
      assertRecurrenceDispatchFeasible(config)
      yield* Effect.promise(() => assertNativeRecurrenceCreateScope(native.directory, config, input.scope, input.executionHost))
      const store = yield* acquireNativeRecurrenceStore(ctx)
      const current = () => {
        if (ctx.location.directory !== native.directory || ctx.location.project.id !== native.project.id
          || ctx.location.project.canonical !== native.project.canonical) throw new Error("Native recurrence Location changed")
        return true as const
      }
      const existing = yield* Effect.promise(() => store.read(id))
      if (existing) {
        if (existing.revision || existing.state !== "paused" || recurrenceConfigDigest(existing.config) !== input.digest) {
          throw new Error("Recurrence request conflict")
        }
        return summary(existing)
      }
      return yield* Effect.promise(async () => {
        try { return summary(await store.create(id, config, Date.now(), current)) }
        catch (error) {
          if (!(error instanceof RecurrenceCreateCapacityError)) throw error
          return { schedule: null, noEffect: { code: "capacity" as const, id, requestID: input.requestID,
            digest: input.digest, projectID: native.project.id, projectCanonical: native.project.canonical } }
        }
      })
    }),
  }
}
