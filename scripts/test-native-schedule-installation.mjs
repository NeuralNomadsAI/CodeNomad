// node --import tsx scripts/test-native-schedule-installation.mjs <isolated-cli> <fresh-scratch>
import assert from "node:assert/strict"
import { fixtureChildPid, spawnFixtureChild as spawn, stopFixtureChild } from "./native-fixture-guards.mjs"
import { createAttestedFetch, resolveWorktreePackage, verifyLoopbackListenerOwner } from "./native-fixture-http.mjs"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
const esbuildBinSpec = process.platform === "win32"
  ? `@esbuild/win32-${process.arch}/esbuild.exe`
  : `@esbuild/${process.platform}-${process.arch}/bin/esbuild`
process.env.ESBUILD_BINARY_PATH = fileURLToPath(resolveWorktreePackage(esbuildBinSpec))
const { build } = await import(resolveWorktreePackage("esbuild"))
const { OpenCode } = await import(resolveWorktreePackage("@opencode/client"))
const { Service } = await import(resolveWorktreePackage("@opencode/client/service"))
import { nativePluginBuild } from "../packages/server/scripts/native-plugin-build.mjs"
import { installDesktopPluginPresence } from "../packages/server/src/opencode/desktop-plugin-installation.ts"

const [cli, root] = process.argv.slice(2)
assert(cli && root && path.isAbsolute(cli) && path.isAbsolute(root) && !existsSync(root), "absolute CLI and fresh owned root required")
mkdirSync(root, { recursive: true })
const env = {}
for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH"]) if (process.env[key]) env[key] = process.env[key]
for (const name of ["CONFIG", "STATE", "CACHE", "DATA"]) env[`XDG_${name}_HOME`] = path.join(root, name.toLowerCase())
Object.assign(env, { XDG_RUNTIME_DIR: path.join(root, "runtime"), HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
  APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "localappdata"), ProgramData: path.join(root, "programdata"),
  TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp"), OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_FILEWATCHER: "true", OPENCODE_DISABLE_FFF: "true" })
for (const [key, value] of Object.entries(env)) if (/^(XDG_|HOME$|USERPROFILE$|APPDATA$|LOCALAPPDATA$|ProgramData$|TEMP$|TMP$)/.test(key)) mkdirSync(value, { recursive: true })
const project = path.join(root, "project"), config = path.join(env.XDG_CONFIG_HOME, "opencode"), data = path.join(root, "retained")
mkdirSync(project); mkdirSync(config, { recursive: true })
writeFileSync(path.join(config, "opencode.json"), JSON.stringify({ snapshots: false, update: "disable" }))
writeFileSync(path.join(config, "service.json"), JSON.stringify({ hostname: "127.0.0.1", port: 0, disabled: false }))
const registrationFile = path.join(env.XDG_STATE_HOME, "opencode", "service.json")
const rpc = { id: "codenomad.installation-qualification", methods: { observe: { input: { type: "object" }, output: { type: "object" } } }, events: {} }
const entry = path.join(root, "entry.mjs"), bundleFile = path.join(root, "fixture.mjs"), providerFile = path.join(root, "provider.mjs")
const acquisitionSource = path.resolve("packages/server/src/opencode/missions/native-schedule-installation.ts")
writeFileSync(entry, `import assert from "node:assert/strict";
import { Plugin, Rpc } from "@opencode/plugin/effect";
import { Context, Effect, Option } from "effect";
import { readFileSync, writeFileSync } from "node:fs";
import { acquireNativeScheduleInstallation } from ${JSON.stringify(acquisitionSource)};
const rpc=Rpc.define(${JSON.stringify(rpc)});
export function desktopPlugin(presence,artifacts){return Plugin.define({id:"codenomad.installation-qualification",effect(ctx){return Effect.gen(function*(){
 const setup={global:Option.isSome(yield* Effect.serviceOption(Context.Service("@opencode/Global"))),server:Option.isSome(yield* Effect.serviceOption(Context.Service("@opencode/server/ServerInfo")))};
 let previous;
 yield* ctx.rpc.register(rpc,{observe:()=>Effect.gen(function*(){
  const priorReleased=previous?(()=>{try{previous();return false}catch{return true}})():null;
  const {installation,assertCurrent}=yield* acquireNativeScheduleInstallation(artifacts);
  const active=assertCurrent();previous=assertCurrent;
  const global=yield* Context.Service("@opencode/Global"),server=yield* Context.Service("@opencode/server/ServerInfo");
  const raw=readFileSync(installation.registrationFile,"utf8"),negatives=[];
  // This exact fixture owns its service record; restore it synchronously before
  // the native registration monitor can observe a different incarnation.
  try{for(const change of [{id:"different"},{pid:process.pid+1}]){
   writeFileSync(installation.registrationFile,JSON.stringify({...JSON.parse(raw),...change}));
   let refused=false;try{assertCurrent()}catch{refused=true}assert(refused);negatives.push(refused);
  }}finally{writeFileSync(installation.registrationFile,raw)}
  assert.equal(assertCurrent(),true);
  return {installation,active,priorReleased,setup,graph:{state:global.state,urls:server.urls(),pid:process.pid},negatives,manifestFrozen:Object.isFrozen(installation)&&Object.isFrozen(installation.provider)&&Object.isFrozen(installation.runtime)};
 }).pipe(Effect.scoped)});
});}})}
`)
const entryReal = realpathSync(entry)
const repoRootReal = realpathSync(path.resolve("."))
const nodeModulesReal = realpathSync(path.resolve("node_modules"))
const withinDir = (base, target) => {
  const rel = path.relative(base, target)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}
const worktreeOnlyPlugin = {
  name: "codenomad-worktree-only-resolve",
  setup(buildApi) {
    buildApi.onLoad({ filter: /.*/ }, args => {
      const real = realpathSync(args.path)
      if (real !== entryReal && !withinDir(repoRootReal, real) && !withinDir(nodeModulesReal, real)) {
        throw new Error(`Bundled module escapes worktree root: ${real}`)
      }
      return null
    })
  },
}
let child, closed, stopPresence, attestedFetch
try {
  const built = await build({ ...nativePluginBuild, entryPoints: [entry], outfile: bundleFile,
    nodePaths: [path.resolve("node_modules")], plugins: [...(nativePluginBuild.plugins ?? []), worktreeOnlyPlugin], metafile: true })
  assert(!Object.keys(built.metafile.inputs).some(file => /node_modules[/\\](effect|@opencode[/\\]plugin)[/\\]/.test(file)), "host Effect and SDK must remain external")
  const localProvider = await build({ ...nativePluginBuild, entryPoints: [path.resolve("packages/server/src/opencode/missions/native-schedule-carrier-provider.ts")], outfile: providerFile,
    plugins: [...(nativePluginBuild.plugins ?? []), worktreeOnlyPlugin], metafile: true })
  assert(Object.values(localProvider.metafile.outputs).every(output => output.imports.length === 0), "provider artifact is dependency-free")
  const providerModule = await import(pathToFileURL(providerFile).href)
  assert.throws(() => providerModule.createNativeScheduleCarrierProvider().languageModel(), /schedule-carrier-language-unavailable/)
  const payload = readFileSync(bundleFile), provider = readFileSync(providerFile)
  stopPresence = await installDesktopPluginPresence("missions", payload, { config, data }, () => {}, () => "", provider)
  const source = readFileSync(path.join(config, "plugins", "codenomad-missions.ts"), "utf8")
  const [, artifacts] = JSON.parse(`[${/export default desktopPlugin\((.+)\)\n$/.exec(source)[1]}]`)
  child = spawn(cli, ["serve", "--service", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  closed = new Promise(resolve => child.once("exit", resolve))
  let logs = ""
  child.stdout.on("data", data => { logs += data }); child.stderr.on("data", data => { logs += data })
  let endpoint
  const pid = await fixtureChildPid(child)
  assert(Number.isSafeInteger(pid) && pid > 0, "Expected owned service PID")
  const deadline = Date.now() + 40_000
  while (!endpoint) {
    assert(child.exitCode === null && Date.now() < deadline, "private native startup deadline")
    if (existsSync(registrationFile)) {
      try {
        const raw = JSON.parse(readFileSync(registrationFile, "utf8"))
        if (raw.pid === pid && typeof raw.url === "string") {
          const auth = raw.auth ?? (raw.password ? { type: "basic", username: raw.username ?? "opencode", password: raw.password } : undefined)
          endpoint = { url: raw.url, auth }
        }
      } catch {}
    }
    if (!endpoint) await delay(100)
  }
  const origin = new URL(endpoint.url).origin
  const port = Number(new URL(endpoint.url).port)
  assert.notEqual(String(port), "28894")
  while (Date.now() < deadline) {
    assert(child.exitCode === null, "private native exited before listening")
    try { await verifyLoopbackListenerOwner(port, pid); break } catch { await delay(100) }
  }
  await verifyLoopbackListenerOwner(port, pid)
  attestedFetch = createAttestedFetch(origin, port, pid)
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint), fetch: attestedFetch })
  let info
  while (!info) {
    assert(child.exitCode === null && Date.now() < deadline, "private native ready deadline")
    try { info = await client.server.info() } catch { await delay(100) }
  }
  assert.equal(info.pid, pid)
  const observe = () => client.rpc(rpc).observe({}, { location: { directory: project }, signal: AbortSignal.timeout(20_000) })
  const first = await observe(), second = await observe()
  assert.equal(first.active, true); assert.equal(first.manifestFrozen, true)
  assert.deepEqual(first.setup, { global: false, server: false }, "private services belong to the fresh RPC graph")
  assert.equal(first.installation.registrationFile, registrationFile)
  assert.deepEqual({ provider: first.installation.provider, runtime: first.installation.runtime }, artifacts)
  assert.equal(first.graph.pid, await fixtureChildPid(child))
  assert.equal(first.graph.state, path.dirname(registrationFile))
  assert(first.graph.urls.some(url => new URL(url).href === new URL(endpoint.url).href))
  assert.equal(second.priorReleased, true)
  await stopPresence()
  assert.equal((await observe()).active, true, "fresh RPC acquisition works with backend lease absent")
  await client.debug.location.evict({ location: { directory: project } })
  const reloaded = await observe()
  assert.equal(reloaded.active, true)
  assert.equal(reloaded.priorReleased, null, "eviction reconstructs the plugin from its retained installed artifacts")
  assert.deepEqual(reloaded.installation, first.installation)
  for (const artifact of Object.values(artifacts)) assert.equal(createHash("sha256").update(readFileSync(artifact.file)).digest("hex"), artifact.sha256)
  const evidence = { completed: true, nativeVersion: info.version, cliSHA256: createHash("sha256").update(readFileSync(cli)).digest("hex"),
    first, scopeReleasedBetweenRPCs: second.priorReleased, backendPresenceAbsent: true, retainedAfterLocationEviction: true, hostRuntimeExternal: true,
    sourceSHA256: createHash("sha256").update(readFileSync(acquisitionSource)).digest("hex") }
  writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ completed: true, nativeVersion: info.version, root }))
} finally {
  let presenceError
  await attestedFetch?.close().catch(() => {})
  try { await stopPresence?.() } catch (error) { presenceError = error }
  if (child && child.exitCode === null && child.signalCode === null) await stopFixtureChild(child, closed)
  else await closed
  if (presenceError) throw presenceError
}
