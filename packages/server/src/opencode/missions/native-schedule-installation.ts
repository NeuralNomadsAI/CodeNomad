import { opendir } from "node:fs/promises"
import path from "node:path"
import { Service } from "@opencode/client/service"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import { assertNativeScheduleCarrierArtifacts, type NativeScheduleCarrierInstallation } from "./native-schedule-carrier-binding"
import { nativeScheduleIncarnationGuard, readNativeScheduleIncarnation } from "./native-schedule-transport-identity"

export type NativeScheduleArtifacts = Readonly<Pick<NativeScheduleCarrierInstallation, "provider" | "runtime">>
const globalTag = Context.Service<never, unknown>("@opencode/Global")
const serverTag = Context.Service<never, unknown>("@opencode/server/ServerInfo")
const globalShape = Schema.Struct({ state: Schema.String })
const callable = Schema.declare<() => unknown>((value): value is () => unknown => Predicate.isFunction(value))
const serverShape = Schema.Struct({ urls: callable })
const deny = (): never => { throw new Error("schedule-installation-unavailable") }

/** Own-process registration is also needed by pure immediate business RPCs.
 * Its acquisition has no calendar/provider capability dependency. */
export const acquireNativeMissionServiceRegistration = Effect.fn("missions.acquireServiceRegistration")(function* () {
  const observedGlobal = yield* Effect.serviceOption(globalTag), observedServer = yield* Effect.serviceOption(serverTag)
  if (Option.isNone(observedGlobal) || Option.isNone(observedServer)) return yield* Effect.fail(new Error("schedule-installation-unavailable"))
  const global = observedGlobal.value, server = observedServer.value
  const { state } = yield* Schema.decodeUnknownEffect(globalShape)(global)
  const { urls } = yield* Schema.decodeUnknownEffect(serverShape)(server)
  if (!path.isAbsolute(state) || state.length > 4096 || /[\x00-\x1f\x7f]/.test(state)) deny()
  const files = yield* Effect.tryPromise(async () => {
    const names: string[] = [], directory = await opendir(state)
    let count = 0
    for await (const entry of directory) {
      if (++count > 256) deny()
      if (!/^service(?:-[a-zA-Z0-9._-]+)?\.json$/.test(entry.name)) continue
      if (!entry.isFile() || names.length >= 64) deny()
      names.push(path.join(state, entry.name))
    }
    return names
  })
  const own = files.flatMap(file => {
    const publicInfo = readNativeScheduleIncarnation(file)
    return publicInfo.pid === process.pid ? [{ file, publicInfo }] : []
  })
  if (own.length !== 1) deny()
  const { file: registrationFile, publicInfo } = own[0]!
  const processGuard = nativeScheduleIncarnationGuard(registrationFile, publicInfo)
  let active = true
  yield* Effect.addFinalizer(() => Effect.sync(() => { active = false }))
  const assertCurrent = (): true => {
    try {
      if (!active || Schema.decodeUnknownSync(globalShape)(global).state !== state
        || Schema.decodeUnknownSync(serverShape)(server).urls !== urls) deny()
      const currentURLs = urls()
      if (!Array.isArray(currentURLs) || !currentURLs.length || currentURLs.length > 16
        || !currentURLs.every(url => typeof url === "string" && url.length <= 4096)
        || !currentURLs.some(url => new URL(url).href === new URL(publicInfo.url).href)) deny()
      processGuard()
      return true
    } catch { return deny() }
  }
  assertCurrent()
  // Native Service.discover probes are read-only and internally time-bounded.
  // A cancelled/late Promise has no access to this graph or any mutation.
  const endpoint = yield* Effect.tryPromise(() => Service.discover({ file: registrationFile })).pipe(Effect.timeout("4 seconds"))
  assertCurrent()
  if (!endpoint || endpoint.url !== publicInfo.url) deny()
  return Object.freeze({ registrationFile, assertCurrent })
}, effect => effect.pipe(Effect.catchCause(() => Effect.fail(new Error("schedule-installation-unavailable")))))

/** Arming adds the immutable technical artifacts to the same registration proof. */
export const acquireNativeScheduleInstallation = Effect.fn("missions.acquireNativeScheduleInstallation")(function* (artifacts: NativeScheduleArtifacts) {
  const provider = Object.freeze({ file: artifacts.provider.file, sha256: artifacts.provider.sha256 })
  const runtime = Object.freeze({ file: artifacts.runtime.file, sha256: artifacts.runtime.sha256 })
  const registration = yield* acquireNativeMissionServiceRegistration()
  const installation = Object.freeze({ registrationFile: registration.registrationFile, provider, runtime })
  const assertCurrent = (): true => { registration.assertCurrent(); return assertNativeScheduleCarrierArtifacts(installation) }
  assertCurrent()
  return Object.freeze({ installation, assertCurrent })
}, effect => effect.pipe(Effect.catchCause(() => Effect.fail(new Error("schedule-installation-unavailable")))))
