import assert from "node:assert/strict"
import test from "node:test"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { build } from "esbuild"
import { OpenCode } from "@opencode/client"

const cli = process.env.MISSIONS_LIFETIME_NATIVE_CLI
test("private native mission plugin retains only unsettled work across presence loss", {
  skip: !cli, timeout: 90_000,
}, async () => {
  assert(cli && path.isAbsolute(cli), "Use an explicitly selected isolated CLI")
  const approved = path.join(os.tmpdir(), "opencode")
  await mkdir(approved, { recursive: true })
  const root = await mkdtemp(path.join(approved, "missions-lifetime-native-"))
  const project = path.join(root, "project")
  const presence = path.join(root, "presence")
  const plugin = path.join(root, "plugin")
  const config = path.join(root, "config")
  await Promise.all([project, presence, plugin, config].map(directory => mkdir(directory)))
  const lease = path.join(presence, "abc.lease")
  await writeFile(lease, "")
  const definition = { id: "missions.lifetime.fixture", methods: {
    invoke: { input: { type: "object" }, output: { type: "string" } },
    corrupt: { input: { type: "object" }, output: { type: "boolean" } },
    count: { input: { type: "object" }, output: { type: "integer" } },
    setups: { input: { type: "object" }, output: { type: "integer" } },
    hold: { input: { type: "object" }, output: { type: "boolean" } },
    held: { input: { type: "object" }, output: { type: "boolean" } },
    release: { input: { type: "object" }, output: { type: "boolean" } },
    cleanup: { input: { type: "object" }, output: { type: "boolean" } },
  }, events: {} }
  const source = fileURLToPath(new URL("./desktop-plugin.ts", import.meta.url))
  let releaseModel: (() => void) | undefined
  const provider = createServer(async (request, response) => {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    if (request.headers["x-lifetime-kind"] === "primary") {
      await new Promise<void>(resolve => { releaseModel = resolve; response.once("close", resolve) })
    }
    if (response.destroyed) return
    if (!body.stream) {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ id: "fixture", choices: [{ message: { role: "assistant", content: "Fixture" }, finish_reason: "stop" }] }))
      return
    }
    response.setHeader("content-type", "text/event-stream")
    for (const [delta, finish_reason] of [[{ role: "assistant", content: "Done" }, null], [{}, "stop"]]) {
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture",
        choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    }
    response.end("data: [DONE]\n\n")
  })
  // Same native plugin ID/storage. Test-only RPC invokes real tool executors and
  // the actual cleanup returned by desktop.setup. Only a deterministic local
  // provider is used; no backend ownership claim or credential copy.
  const entry = `import { desktopPlugin } from ${JSON.stringify(source)};
const desktop = desktopPlugin(${JSON.stringify(presence)});
export default { ...desktop, async setup(ctx) {
  await ctx.session.hook('http.request', event => event.request.headers.set('x-lifetime-kind', event.kind));
  let setups = 0, hold = false, release;
  const dispose = await desktop.setup({ ...ctx, tool: { ...ctx.tool,
    transform: async callback => { setups++; return ctx.tool.transform(callback); }
  }, storage: { ...ctx.storage, scan: async input => {
    if (hold) { hold = false; await new Promise(resolve => { release = resolve; }); }
    return ctx.storage.scan(input);
  } } });
  await ctx.rpc.register(${JSON.stringify(definition)}, {
    count: async () => (await ctx.tool.list()).filter(tool => tool.id === 'mission_inspect').length,
    setups: async () => setups,
    hold: async () => { hold = true; return true; },
    held: async () => Boolean(release),
    release: async () => { release?.(); release = undefined; return true; },
    cleanup: async () => { await dispose(); return true; },
    invoke: async input => {
      const tool = (await ctx.tool.list()).find(tool => tool.id === 'mission_' + input.tool);
      if (!tool) throw new Error('Mission tool unavailable');
      const result = await tool.execute(input.input, { sessionID: input.sessionID,
        messageID: 'msg_fixture', id: input.callID, progress: async () => {}, signal: new AbortController().signal });
      return result.content;
    },
    corrupt: async () => {
      const page = await ctx.storage.scan({ prefix: 'codenomad-missions/v2', limit: 100 });
      const key = page.entries[0].key;
      await ctx.storage.set(key + '-invalid', { invalid: true });
      return true;
    },
  });
  return dispose;
} };`
  await build({ stdin: { contents: entry, resolveDir: path.dirname(source), loader: "ts" },
    bundle: true, platform: "node", format: "esm", outfile: path.join(plugin, "index.js") })
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve))
  const address = provider.address()
  assert(address && typeof address === "object")
  await writeFile(path.join(config, "opencode.json"), "{}\n")
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(OPENCODE_|XDG_|CODENOMAD_)/i.test(key)))
  Object.assign(env, { HOME: root, USERPROFILE: root, LOCALAPPDATA: root,
    OPENCODE_TEST_HOME: root, OPENCODE_CONFIG_DIR: config, OPENCODE_DB: path.join(root, "fixture.db"),
    XDG_DATA_HOME: path.join(root, "data"), XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: path.join(root, "state"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_RUNTIME_DIR: root,
    OPENCODE_SERVER_PASSWORD: "isolated-lifetime", OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: [plugin], model: "fixture/fixture",
      providers: { fixture: { package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture" }, models: { fixture: {} } } } }),
  })
  delete env.WSL_DISTRO_NAME
  const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"],
    { cwd: root, env, windowsHide: true })
  const stopped = new Promise(resolve => child.once("close", resolve))
  let output = ""
  child.stdout.on("data", data => { output += data })
  child.stderr.on("data", data => { output += data })
  const until = async (predicate: () => Promise<boolean> | boolean) => {
    for (let i = 0; i < 150; i++) {
      if (await predicate()) return
      if (child.exitCode !== null) throw new Error(output.slice(-3000))
      await delay(100)
    }
    throw new Error("Private native lifetime observation timed out: " + output.slice(-3000))
  }
  try {
    await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output))
    const client = OpenCode.make({ baseUrl: output.match(/http:\/\/127\.0\.0\.1:\d+/)![0],
      headers: { authorization: `Basic ${Buffer.from("opencode:isolated-lifetime").toString("base64")}` } })
    const location = { directory: project }
    await client.plugin.list({ location })
    const rpc = client.rpc(definition)
    const count = async () => rpc.count({}, { location }) as Promise<number>
    await until(async () => await count() === 1)
    await unlink(lease)
    await until(async () => await count() === 0)
    await writeFile(lease, "")
    await until(async () => await count() === 1)
    assert.equal(await rpc.setups({}, { location }), 2)
    const coordinator = await client.session.create({ location, title: "Lifetime fixture" })
    const invoke = (tool: string, input: unknown, callID: string) => rpc.invoke({
      tool, input, sessionID: coordinator.id, callID,
    }, { location })
    await invoke("inspect", { start: { objective: "Finish after close", template: "custom" } }, "start")
    await client.session.prompt({ sessionID: coordinator.id, text: "Deterministic lifetime fixture" })
    await until(() => Boolean(releaseModel))
    await unlink(lease)
    await delay(2_500)
    assert.equal(await count(), 1, "active work survives close")
    releaseModel!()
    await client.session.wait({ sessionID: coordinator.id }, { signal: AbortSignal.timeout(10_000) })
    await writeFile(lease, "")
    await delay(2_500)
    assert.equal(await count(), 1, "reopen retains one registration")
    assert.equal(await rpc.setups({}, { location }), 2, "reopen does not run setup again")
    await unlink(lease)
    await invoke("report", { outcome: "completed", summary: "Done", evidence: [], next: [], final: true }, "finish")
    await until(async () => await count() === 0)
    await writeFile(lease, "")
    await until(async () => await count() === 1)
    await rpc.corrupt({}, { location })
    await unlink(lease)
    await delay(2_500)
    assert.equal(await count(), 1, "unknown damaged storage retains conservatively")
    await rpc.hold({}, { location })
    await until(async () => await rpc.held({}, { location }) === true)
    const setups = await rpc.setups({}, { location })
    let cleaned = false
    const cleanup = rpc.cleanup({}, { location }).then(() => { cleaned = true })
    await delay(100)
    assert.equal(cleaned, false, "actual plugin cleanup waits for held lifetime callback")
    await writeFile(lease, "")
    await rpc.release({}, { location })
    await cleanup
    assert.equal(await count(), 0)
    await delay(2_500)
    assert.equal(await count(), 0, "late callback and renewed presence cannot resurrect cleaned plugin")
    assert.equal(await rpc.setups({}, { location }), setups)
    console.log(JSON.stringify({ cli, root, cases: ["close idle", "close native model busy", "native model settles after close",
      "reopen once", "finish after close", "unknown retained", "actual plugin cleanup fences pending lifetime callback"] }))
  } finally {
    releaseModel?.()
    child.kill()
    await stopped
    await new Promise<void>(resolve => provider.close(() => resolve()))
  }
})
