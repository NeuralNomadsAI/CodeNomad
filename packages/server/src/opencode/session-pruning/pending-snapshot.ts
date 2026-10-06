import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Location, Rpc, type Plugin } from "@opencode/plugin/effect"
import { Form } from "@opencode/schema/form"
import { Permission } from "@opencode/schema/permission"
import { Cause, Context, Effect, MutableHashMap, Option, Predicate, RcMap, Schema, type Scope } from "effect"
import effectPackage from "effect/package.json" with { type: "json" }

export const PENDING_SNAPSHOT_RPC_ID = "codenomad.pending-requests"
export const PENDING_SNAPSHOT_NATIVE_VERSIONS = ["2.0.22", "2.0.24"] as const
export const PENDING_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024
const MAX_DIRECTORIES = 64
const MAX_REQUESTS = 1024
const MAX_LOADED_KEYS = 2048

const directory = Schema.String.check(Schema.makeFilter((value) => value.length > 0 && value.length <= 4096 && !value.includes("\0") && path.isAbsolute(value)))
export const pendingSnapshotInput = Schema.Struct({
  directories: Schema.Array(directory).check(Schema.makeFilter((values) => values.length > 0 && values.length <= MAX_DIRECTORIES)),
}).annotate({ parseOptions: { onExcessProperty: "error" } })
const snapshot = Schema.Struct({ location: Location.Ref, forms: Schema.Array(Form.Info), permissions: Schema.Array(Permission.Request) })
const result = Schema.Struct({
  originDirectory: directory,
  data: Schema.Array(Schema.Struct({ directory, status: Schema.Literal("complete"), locations: Schema.Array(snapshot) })),
})
const jsonResult = Schema.toCodecJson(result)
export const PendingSnapshotRpc = Rpc.define({
  id: PENDING_SNAPSHOT_RPC_ID,
  methods: { snapshot: {
    // Native rc.112 schema-parser sentinels are copy-local. Keep the wire schema plain JSON Schema;
    // validate absolute paths again inside the bundled handler's own Effect copy.
    // Preserve excess keys through native parsing so the handler rejects rather than silently strips them.
    input: { type: "object", properties: {
      directories: { type: "array", minItems: 1, maxItems: MAX_DIRECTORIES, items: { type: "string", minLength: 1, maxLength: 4096 } },
    }, required: ["directories"], additionalProperties: true },
    // Already encoded through the native JSON codec below; do not decode special numbers a second time.
    output: { type: "object" },
    errors: { unavailable: { type: "object", properties: {}, additionalProperties: false } },
  } },
  events: {},
})

type NativeContext = Context.Context<never>
type NativeMap = {
  readonly rcMap: RcMap.RcMap<Location.Ref, NativeContext, unknown>
  readonly contextEffectOption: (ref: Location.Ref) => Effect.Effect<Option.Option<NativeContext>, unknown, Scope.Scope>
}
type NativeQueue = { readonly list: () => Effect.Effect<unknown, unknown> }
const queueShape = Schema.Struct({ list: Schema.declare<NativeQueue["list"]>((value): value is NativeQueue["list"] => Predicate.isFunction(value)) })
const rcMapShape = Schema.Struct({
  "~effect/RcMap": Schema.Literal("~effect/RcMap"),
  state: Schema.Union([
    Schema.Struct({ _tag: Schema.Literal("Closed") }),
    Schema.Struct({ _tag: Schema.Literal("Open"), map: Schema.declare(MutableHashMap.isMutableHashMap) }),
  ]),
})
const mapShape = Schema.Struct({
  rcMap: Schema.declare<NativeMap["rcMap"]>((value): value is NativeMap["rcMap"] => Schema.is(rcMapShape)(value)),
  contextEffectOption: Schema.declare<NativeMap["contextEffectOption"]>((value): value is NativeMap["contextEffectOption"] => Predicate.isFunction(value)),
})
const contextShape = Schema.declare<NativeContext>(Context.isContext)
const contextOption = Schema.Option(contextShape)
const nativeRef = Schema.toType(Location.Ref).check(Schema.makeFilter((ref) => Schema.is(directory)(ref.directory)))
const nativeForms = Schema.Array(Schema.toType(Form.Info)).check(Schema.isMaxLength(MAX_REQUESTS))
const nativePermissions = Schema.Array(Schema.toType(Permission.Request)).check(Schema.isMaxLength(MAX_REQUESTS))

// Private qualified 2.0.22/2.0.24 / Effect rc.112 internals, not a supported native pending API.
// Optional lookup keeps the public RPC handler's R=never without importing Core or constructing a graph.
const mapTag = Context.Service<never, unknown>("@opencode/example/LocationServiceMap")
const formTag = Context.Service<never, unknown>("@opencode/Form")
const permissionTag = Context.Service<never, unknown>("@opencode/Permission")
const locationTag = Context.Service<never, unknown>("@opencode/Location")
const nativeVersion = Schema.Union(PENDING_SNAPSHOT_NATIVE_VERSIONS.map((version) => Schema.Literal(version)))
const compatible = (version: unknown) => Schema.is(nativeVersion)(version) && effectPackage.version === "4.0.0-rc.112"
const hostShape = Schema.Struct({
  app: Schema.Struct({ version: nativeVersion }),
  rpc: Schema.declare<Plugin.Context["rpc"]>((value): value is Plugin.Context["rpc"] =>
    Predicate.isFunction(value) && Predicate.hasProperty(value, "register") && Predicate.isFunction(value.register)),
})
const unavailable = () => Effect.fail(new Error("Pending snapshot unavailable"))
const sameRef = (left: Location.Ref, right: Location.Ref) => left.directory === right.directory && left.workspaceID === right.workspaceID
const directoryKey = (value: string) => process.platform === "win32" ? path.normalize(value).toLowerCase() : value
const queueEffect = Schema.declare<Effect.Effect<unknown, unknown>>((value): value is Effect.Effect<unknown, unknown> => Effect.isEffect(value))
const contextEffect = Schema.declare<ReturnType<NativeMap["contextEffectOption"]>>((value): value is ReturnType<NativeMap["contextEffectOption"]> => Effect.isEffect(value))

const loadedRefs = Effect.fn("pendingSnapshot.loadedRefs")(function* (map: NativeMap, requested: Set<string>) {
  const keys = Array.from(yield* RcMap.keys(map.rcMap))
  if (keys.length > MAX_LOADED_KEYS) return yield* unavailable()
  // Validate every key before filtering: a changed key representation must not become cold coverage.
  yield* Schema.decodeUnknownEffect(Schema.Array(nativeRef))(keys)
  return keys.filter((ref) => requested.has(directoryKey(ref.directory)))
})
const existingContext = Effect.fn("pendingSnapshot.existingContext")(function* (map: NativeMap, ref: Location.Ref) {
  const effect = yield* Schema.decodeUnknownEffect(contextEffect)(map.contextEffectOption(ref))
  const found = yield* Schema.decodeUnknownEffect(contextOption)(yield* effect)
  if (Option.isNone(found)) return yield* unavailable()
  return found.value
})
const queues = Effect.fn("pendingSnapshot.queues")(function* (context: NativeContext, ref: Location.Ref) {
  const location = yield* Schema.decodeUnknownEffect(nativeRef)(Context.get(context, locationTag))
  if (!sameRef(ref, location)) return yield* unavailable()
  const formValue = Context.get(context, formTag), permissionValue = Context.get(context, permissionTag)
  const forms = yield* Schema.decodeUnknownEffect(queueShape)(formValue)
  const permissions = yield* Schema.decodeUnknownEffect(queueShape)(permissionValue)
  return { location, forms, permissions, formValue, permissionValue, locationValue: Context.get(context, locationTag) }
})

export const readPendingSnapshot = Effect.fn("readPendingSnapshot")(function* (input: unknown, executingVersion: unknown) {
  if (!compatible(executingVersion)) return yield* unavailable()
  const decoded = yield* Schema.decodeUnknownEffect(pendingSnapshotInput)(input, { onExcessProperty: "error" })
  const origin = yield* Schema.decodeUnknownEffect(nativeRef)(yield* Effect.serviceOption(locationTag).pipe(Effect.flatMap(Effect.fromOption)))
  const found = yield* Effect.serviceOption(mapTag)
  if (Option.isNone(found)) return yield* unavailable()
  const map = yield* Schema.decodeUnknownEffect(mapShape)(found.value)
  const requested = new Set(decoded.directories.map(directoryKey))
  const before = yield* loadedRefs(map, requested)
  if (before.length > MAX_DIRECTORIES) return yield* unavailable()
  const captured = []
  const snapshots: Array<typeof snapshot.Type> = []
  for (const ref of before) {
    const queue = yield* queues(yield* existingContext(map, ref), ref)
    const formEffect = yield* Schema.decodeUnknownEffect(queueEffect)(queue.forms.list())
    const permissionEffect = yield* Schema.decodeUnknownEffect(queueEffect)(queue.permissions.list())
    const forms = yield* Schema.decodeUnknownEffect(nativeForms)(yield* formEffect)
    const permissions = yield* Schema.decodeUnknownEffect(nativePermissions)(yield* permissionEffect)
    snapshots.push({ location: queue.location, forms, permissions })
    captured.push({ ref, ...queue })
  }
  const after = yield* loadedRefs(map, requested)
  if (before.length !== after.length || before.some((ref, index) => !sameRef(ref, after[index]))) return yield* unavailable()
  for (const old of captured) {
    const current = yield* queues(yield* existingContext(map, old.ref), old.ref)
    if (old.formValue !== current.formValue || old.permissionValue !== current.permissionValue || old.locationValue !== current.locationValue) return yield* unavailable()
  }
  // ponytail: bounded all-or-nothing coverage; any failure is non-authoritative, never a truncated queue.
  const data = [...new Set(decoded.directories)].map((value) => {
    const locations = snapshots.filter((entry) => directoryKey(entry.location.directory) === directoryKey(value))
    return { directory: value, status: "complete" as const, locations }
  })
  if (data.some((entry) => entry.locations.reduce((count, item) => count + item.forms.length, 0) > MAX_REQUESTS ||
    entry.locations.reduce((count, item) => count + item.permissions.length, 0) > MAX_REQUESTS)) return yield* unavailable()
  const output = yield* Schema.encodeUnknownEffect(jsonResult)({ originDirectory: origin.directory, data })
  const serialized = yield* Effect.try(() => JSON.stringify({ output }))
  if (new TextEncoder().encode(serialized).byteLength > PENDING_SNAPSHOT_MAX_BYTES) return yield* unavailable()
  // Unknown metadata may contain BigInt, functions, toJSON or non-finite values; never silently omit/coerce it.
  if (!isDeepStrictEqual(output, yield* Effect.try(() => JSON.parse(serialized).output))) return yield* unavailable()
  return output
}, Effect.scoped, Effect.timeout("2 seconds"))

export const registerPendingSnapshot = Effect.fn("registerPendingSnapshot")(function* (ctx: Plugin.Context) {
  // Authority comes from native setup, not browser input or plugin options. Existing pruning has no version gate.
  if (!compatible(ctx.app?.version) || !Schema.is(hostShape)(ctx)) return
  let present = true
  yield* ctx.rpc.register(PendingSnapshotRpc, {
    snapshot: (input, call) => Effect.gen(function* () {
      if (!present) return yield* unavailable()
      const output = yield* readPendingSnapshot(input, ctx.app.version)
      if (!present) return yield* unavailable()
      return output
    }).pipe(Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.interrupt :
      Effect.fail(call.error("unavailable", "Pending requests unavailable; retain existing queues", {})))),
  })
  yield* Effect.addFinalizer(() => Effect.sync(() => { present = false }))
})
