import path from "node:path"
import { Rpc, type Plugin } from "@opencode/plugin/effect"
import { Cause, Context, Effect, Option, Predicate } from "effect"
import { z } from "zod"
import { readDesktopPluginFile } from "./desktop-plugin-artifact"
import { gitPluginRevision, PLUGIN_VERSIONS_RPC_ID, pluginVersionsSchema } from "./plugin-package-versions-contract"

type Resolver = { resolve(target: string): Effect.Effect<unknown, unknown> }
const npmTag = Context.Service<never, unknown>("@opencode/Npm")

/** Read-only native cache resolution: OpenCode owns its execution host, XDG roots and generations. */
export const readPluginPackageVersions = Effect.fn("readPluginPackageVersions")(function* (plugin: Plugin.Context["plugin"]) {
  const service = yield* Effect.serviceOption(npmTag)
  if (Option.isNone(service) || !Predicate.hasProperty(service.value, "resolve") || !Predicate.isFunction(service.value.resolve)) return []
  const resolver = service.value as Resolver
  const inventory = yield* plugin.list({})
  const sources = new Map<string, string>()
  for (const entry of inventory.data) {
    if (entry.source.type !== "package") continue
    const revision = gitPluginRevision(entry.source.target, entry.source.version)
    if (revision) sources.set(entry.source.target, revision)
    if (sources.size > 64) return []
  }
  const result: z.infer<typeof pluginVersionsSchema> = []
  for (const [target, revision] of sources) {
    const value = yield* Effect.gen(function* () {
      const effect = resolver.resolve(target)
      if (!Effect.isEffect(effect)) return
      const installed = z.object({ directory: z.string().refine(path.isAbsolute), version: z.literal(revision) }).safeParse(yield* effect)
      if (!installed.success) return
      const bytes = yield* Effect.tryPromise(() => readDesktopPluginFile(path.join(installed.data.directory, "package.json"), 64 * 1024))
      if (!bytes) return
      const manifest = yield* Effect.try(() => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
      const parsed = pluginVersionsSchema.element.safeParse({ target, revision, version: manifest?.version })
      return parsed.success ? parsed.data : undefined
    }).pipe(Effect.catchCause(cause => Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(undefined)))
    if (value) result.push(value)
  }
  return result
}, Effect.catchCause(cause => Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed([])),
Effect.timeoutOption("2 seconds"), Effect.map(Option.getOrElse(() => [])))

const PluginVersionsRpc = Rpc.define({
  id: PLUGIN_VERSIONS_RPC_ID,
  methods: { list: { input: { type: "object", additionalProperties: false }, output: { type: "array" } } },
  events: {},
})

export const registerPluginPackageVersions = (ctx: Plugin.Context) => ctx.rpc.register(PluginVersionsRpc, {
  list: () => readPluginPackageVersions(ctx.plugin),
})
