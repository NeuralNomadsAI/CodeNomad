// node scripts/test-native-schedule-provider-registration.mjs <isolated-cli> <fresh-scratch>
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { build } from "esbuild"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { nativePluginBuild } from "../packages/server/scripts/native-plugin-build.mjs"

const [cli, root] = process.argv.slice(2)
assert(cli && root && path.isAbsolute(cli) && path.isAbsolute(root) && !existsSync(root), "absolute CLI and fresh owned scratch required")
mkdirSync(root, { recursive: true })
const source = path.resolve("packages/server/src/opencode/missions/native-schedule-provider-registration.ts")
const entry = path.join(root, "entry.mjs"), runtimeFile = path.join(root, "plugin", "index.mjs"), providerFile = path.join(root, "provider.mjs")
const rpc = { id: "codenomad.provider-registration-qualification", methods: Object.fromEntries(["inspect", "create"].map(name =>
  [name, { input: { type: "object" }, output: { type: "object" } }])), events: {} }
writeFileSync(entry, `import { Plugin,Rpc } from "@opencode/plugin/effect";
import { Effect } from "effect";
import { registerNativeScheduleProvider,assertNativeScheduleProviderAvailable } from ${JSON.stringify(source)};
import { nativeScheduleCarrierHooks,NATIVE_SCHEDULE_CARRIER_MODEL,NATIVE_SCHEDULE_CARRIER_TITLE } from ${JSON.stringify(path.resolve("packages/server/src/opencode/missions/native-schedule-carrier.ts"))};
const rpc=Rpc.define(${JSON.stringify(rpc)});
export default Plugin.define({id:"codenomad.provider-registration-qualification",effect(ctx){return Effect.gen(function*(){
 const artifacts=ctx.options.artifacts,owned=new Set();
 yield* registerNativeScheduleProvider(ctx,artifacts);
 if(ctx.options.hooks){const h=nativeScheduleCarrierHooks(id=>owned.has(id));
  yield*ctx.aisdk.hook("language",event=>Effect.sync(()=>h.language(event)));
  for(const [name,method] of [["context","context"],["title","title"],["compaction","compaction"],["http.request","httpRequest"]])
   yield*ctx.session.hook(name,event=>Effect.sync(()=>h[method](event)));
 }
 yield*ctx.rpc.register(rpc,{
  inspect:()=>Effect.gen(function*(){
   const available=(yield*assertNativeScheduleProviderAvailable(ctx,artifacts).pipe(Effect.exit))._tag==="Success";
   const provider=yield*ctx.provider.get({providerID:NATIVE_SCHEDULE_CARRIER_MODEL.providerID});
   const models=yield*ctx.model.list({types:["chat"]}),def=yield*ctx.model.default();
   return JSON.parse(JSON.stringify({available,provider:provider.data,models:models.data.filter(m=>m.providerID===NATIVE_SCHEDULE_CARRIER_MODEL.providerID),defaultModel:def.data}));
  }),
  create:()=>Effect.gen(function*(){
   const available=(yield*assertNativeScheduleProviderAvailable(ctx,artifacts).pipe(Effect.exit))._tag==="Success";
   if(!available)return {refused:true};
   const session=yield*ctx.session.create({title:NATIVE_SCHEDULE_CARRIER_TITLE,model:NATIVE_SCHEDULE_CARRIER_MODEL});
   owned.add(session.id);return JSON.parse(JSON.stringify({session}));
  })
 });
});}});
`)
const built = await build({ ...nativePluginBuild, entryPoints: [entry], outfile: runtimeFile, nodePaths: [path.resolve("node_modules")], metafile: true })
assert(!Object.keys(built.metafile.inputs).some(file => /node_modules[/\\](effect|@opencode[/\\]plugin)[/\\]/.test(file)))
await build({ ...nativePluginBuild, entryPoints: [path.resolve("packages/server/src/opencode/missions/native-schedule-carrier-provider.ts")], outfile: providerFile })
writeFileSync(path.join(root, "plugin", "package.json"), JSON.stringify({ name: "codenomad-provider-registration-qualification", type: "module", exports: { ".": "./index.mjs" } }))
const artifact = file => ({ file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") })
const artifacts = { provider: artifact(providerFile), runtime: artifact(runtimeFile) }, requests = []
const spy = createServer((req, res) => { requests.push({ method: req.method, path: req.url }); res.writeHead(500).end("Forbidden remote provider HTTP") })
await new Promise(resolve => spy.listen(0, "127.0.0.1", resolve))
const spyPort = spy.address().port
assert.notEqual(spyPort, 28894)
const evidence = { artifacts, sourceSHA256: artifact(source).sha256, cliSHA256: artifact(cli).sha256, cases: [] }
try {
  for (const mode of ["healthy", "collision", "hookless"]) {
    const directory = path.join(root, mode), env = {}
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH"]) if (process.env[key]) env[key] = process.env[key]
    for (const name of ["CONFIG", "STATE", "DATA", "CACHE"]) env[`XDG_${name}_HOME`] = path.join(directory, name.toLowerCase())
    Object.assign(env, { HOME: path.join(directory, "home"), USERPROFILE: path.join(directory, "home"), XDG_RUNTIME_DIR: path.join(directory, "runtime"),
      APPDATA: path.join(directory, "appdata"), LOCALAPPDATA: path.join(directory, "localappdata"), ProgramData: path.join(directory, "programdata"),
      TEMP: path.join(directory, "tmp"), TMP: path.join(directory, "tmp"), OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_FILEWATCHER: "true", OPENCODE_DISABLE_FFF: "true" })
    for (const [key, value] of Object.entries(env)) if (/^(XDG_|HOME$|USERPROFILE$|APPDATA$|LOCALAPPDATA$|ProgramData$|TEMP$|TMP$)/.test(key)) mkdirSync(value, { recursive: true })
    const config = path.join(env.XDG_CONFIG_HOME, "opencode"), project = path.join(directory, "project")
    mkdirSync(config, { recursive: true }); mkdirSync(project)
    const remote = { name: "Forbidden remote default", package: "@opencode/ai/providers/openai-compatible", activation: "enabled",
      settings: { baseURL: `http://127.0.0.1:${spyPort}/v1`, apiKey: "isolated-fixture-only" }, models: { forbidden: { limit: { context: 32000, output: 4096 } } } }
    const configuration = { snapshots: false, update: "disable", plugins: [{ package: path.dirname(runtimeFile), options: { artifacts, hooks: mode !== "hookless" } }],
      model: "remote-aux/forbidden", agents: { title: { model: "remote-aux/forbidden" }, compaction: { model: "remote-aux/forbidden" } },
      providers: { "remote-aux": remote, ...(mode === "collision" ? { "codenomad-missions-local": { ...remote, models: { "schedule-noop": {} } } } : {}) } }
    const configFile = path.join(config, "opencode.json"), configBytes = JSON.stringify(configuration)
    writeFileSync(configFile, configBytes)
    writeFileSync(path.join(config, "service.json"), JSON.stringify({ hostname: "127.0.0.1", port: 0, disabled: false }))
    const registrationFile = path.join(env.XDG_STATE_HOME, "opencode", "service.json")
    const child = spawn(cli, ["serve", "--service", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    const closed = new Promise(resolve => child.once("exit", resolve))
    child.stdout.resume(); child.stderr.resume()
    try {
      let endpoint
      for (const deadline = Date.now() + 40_000; !endpoint;) {
        assert(child.exitCode === null && Date.now() < deadline, "owned service startup deadline")
        if (existsSync(registrationFile) && JSON.parse(readFileSync(registrationFile, "utf8")).pid === child.pid)
          endpoint = await Service.discover({ file: registrationFile })
        if (!endpoint) await delay(100)
      }
      assert.notEqual(new URL(endpoint.url).port, "28894")
      const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) }), info = await client.server.info()
      const qa = client.rpc(rpc), options = { location: { directory: project }, signal: AbortSignal.timeout(20_000) }
      const inspected = await qa.inspect({}, options)
      writeFileSync(path.join(directory, "catalog.json"), JSON.stringify(inspected, null, 2))
      assert.equal(inspected.defaultModel.providerID, "remote-aux")
      assert.equal(inspected.available, mode !== "collision")
      const created = await qa.create({}, options)
      let outcome, compactionIDs = []
      if (mode === "collision") {
        assert.deepEqual(created, { refused: true })
        assert.equal(inspected.provider.package, remote.package)
      } else {
        assert.equal(created.session.model.providerID, "codenomad-missions-local")
        assert.equal(created.session.title, "Mission schedule carrier")
        await client.session.prompt({ sessionID: created.session.id, text: "Bounded local carrier qualification" })
        await client.experimental.session.wait({ sessionID: created.session.id }, { signal: AbortSignal.timeout(20_000) })
        if (mode === "healthy") {
          await client.session.compact({ sessionID: created.session.id })
          await client.experimental.session.wait({ sessionID: created.session.id }, { signal: AbortSignal.timeout(20_000) })
        }
        const session = await client.session.get({ sessionID: created.session.id })
        assert.equal(session.outcome, mode === "healthy" ? "succeeded" : "failed")
        outcome = session.outcome
        if (mode === "healthy") {
          const messages = await client.message.list({ sessionID: session.id, limit: 32, order: "asc" })
          compactionIDs = messages.data.filter(message => message.type === "compaction" && message.status === "completed").map(message => message.id)
          assert.equal(compactionIDs.length, 1, "the real native compaction completed through the local hook")
        }
      }
      assert.equal(readFileSync(configFile, "utf8"), configBytes, "the plugin never authors provider configuration")
      assert.equal(requests.length, 0)
      evidence.cases.push({ mode, nativeVersion: info.version, providerConfiguredInJSON: mode === "collision", available: inspected.available,
        defaultUnchanged: true, carrierCreated: !!created.session, sessionID: created.session?.id, outcome, compactionIDs,
        technicalHooksFixture: mode === "healthy", remoteHTTP: requests.length })
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await closed
    }
  }
  writeFileSync(path.join(root, "evidence.json"), JSON.stringify({ ...evidence, completed: true, allOwnedServicesStopped: true }, null, 2))
  console.log(JSON.stringify({ completed: true, cases: evidence.cases, root }))
} finally { spy.closeAllConnections(); await new Promise(resolve => spy.close(resolve)) }
