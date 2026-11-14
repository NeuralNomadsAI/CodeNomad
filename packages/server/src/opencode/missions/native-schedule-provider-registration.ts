import { createHash } from "node:crypto"
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"
import type { Plugin } from "@opencode/plugin/effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Effect } from "effect"
import { NATIVE_SCHEDULE_CARRIER_MODEL, NATIVE_SCHEDULE_CARRIER_TITLE } from "./native-schedule-carrier"
import type { NativeScheduleArtifacts } from "./native-schedule-installation"

type Context = Pick<Plugin.Context, "provider" | "model">
type State = { active: boolean; added: boolean; artifacts: NativeScheduleArtifacts; info: Provider.Info; model: Model.Info }
const states = new WeakMap<Context["provider"], State>()
const unavailable = () => new Error("schedule-provider-unavailable")
const providerID = Provider.ID.make(NATIVE_SCHEDULE_CARRIER_MODEL.providerID)
const modelID = Model.ID.make(NATIVE_SCHEDULE_CARRIER_MODEL.id)
// Public native results can materialize absent optional fields as undefined.
const sameDefinition = (actual: unknown, expected: unknown) => isDeepStrictEqual(
  JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)))

// Setup has static artifacts, before any service registration path is acquired.
function assertArtifacts(artifacts: NativeScheduleArtifacts) {
  for (const artifact of [artifacts.provider, artifacts.runtime]) {
    if (!path.isAbsolute(artifact.file) || /[\x00-\x1f\x7f]/.test(artifact.file) || !artifact.file.endsWith(".mjs")
      || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw unavailable()
    const fd = openSync(artifact.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = fstatSync(fd), named = lstatSync(artifact.file)
      if (!info.isFile() || named.isSymbolicLink() || info.nlink !== 1 || info.dev !== named.dev || info.ino !== named.ino
        || info.size > 8 * 1024 * 1024) throw unavailable()
      const bytes = Buffer.alloc(info.size + 1)
      let size = 0
      while (size < bytes.length) {
        const read = readSync(fd, bytes, size, bytes.length - size, size)
        if (!read) break
        size += read
      }
      if (size !== info.size || createHash("sha256").update(bytes.subarray(0, size)).digest("hex") !== artifact.sha256) throw unavailable()
    } finally { closeSync(fd) }
  }
}

/** Public, setup-scoped catalog contribution. Collisions and damaged payloads
 * leave ordinary provider definitions intact and technical scheduling disabled. */
export const registerNativeScheduleProvider = Effect.fn("missions.registerNativeScheduleProvider")(function* (ctx: Context, artifacts: NativeScheduleArtifacts) {
  const snapshot = Object.freeze({ provider: Object.freeze({ file: artifacts.provider.file, sha256: artifacts.provider.sha256 }),
    runtime: Object.freeze({ file: artifacts.runtime.file, sha256: artifacts.runtime.sha256 }) })
  const packageName = `aisdk:${pathToFileURL(snapshot.provider.file).href}`
  const info: Provider.Info = { ...Provider.Info.empty(providerID), name: NATIVE_SCHEDULE_CARRIER_TITLE,
    activation: "enabled", package: packageName, settings: {}, headers: {}, body: {} }
  const model: Model.Info = { ...Model.Info.default(providerID, modelID), name: NATIVE_SCHEDULE_CARRIER_TITLE,
    type: "chat", package: packageName, capabilities: { tools: false, input: ["text"], output: ["text"], temperature: false },
    limit: { context: 32000, input: 27904, output: 4096 }, settings: {}, headers: {}, body: {} }
  const state: State = { active: true, added: false, artifacts: snapshot, info, model }
  states.set(ctx.provider, state)
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    state.active = false
    if (states.get(ctx.provider) === state) states.delete(ctx.provider)
  }))
  yield* ctx.provider.transform(editor => {
    state.added = false
    try {
      if (!state.active || editor.get(providerID)) return
      assertArtifacts(snapshot)
      editor.add({ info: structuredClone(info), models: [structuredClone(model)] })
      state.added = true
    } catch { /* Catalog construction must keep unrelated Missions usable. */ }
  })
}, effect => effect.pipe(Effect.catchCause(() => Effect.void)))

/** Call at arming/adoption, adjacent to the owner's admission guards. Public
 * catalog reads resolve current transforms; no credential or model invocation. */
export const assertNativeScheduleProviderAvailable = Effect.fn("missions.assertNativeScheduleProviderAvailable")(function* (ctx: Context, artifacts: NativeScheduleArtifacts) {
  const state = states.get(ctx.provider)
  if (!state?.active || state.artifacts.provider.file !== artifacts.provider.file
    || state.artifacts.provider.sha256 !== artifacts.provider.sha256) throw unavailable()
  // Stored calendars retain their runtime descriptor across content-addressed
  // bundle replacement. Both runtimes must remain intact; the provider is exact.
  assertArtifacts(artifacts)
  assertArtifacts(state.artifacts)
  const provider = yield* ctx.provider.get({ providerID })
  const models = yield* ctx.model.list({ types: ["chat"] })
  if (!state.active || !state.added || !sameDefinition(provider.data, state.info)
    || models.data.length > 8192) throw unavailable()
  const owned = models.data.filter(model => model.providerID === providerID)
  if (owned.length !== 1 || !sameDefinition(owned[0], state.model)) throw unavailable()
  assertArtifacts(state.artifacts)
}, effect => effect.pipe(Effect.catchCause(() => Effect.fail(unavailable()))))
