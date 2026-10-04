// Trusted installed entry calls this with manifest constants, never args/env/HTTP.
import { Module } from "node:module"
import { createHash, randomBytes } from "node:crypto"
import { readFile, lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { framed, write } from "./channel-codec.mjs"
import { prepareOwnedStarter } from "./owned-starter.mjs"
const loadNative = process.dlopen.bind(process)
export async function runNativeServiceBroker(bindingFile, bindingSha256, trustedLauncher) {
  if (!path.isAbsolute(bindingFile) || path.extname(bindingFile) !== ".node" || !/^[a-f0-9]{64}$/.test(bindingSha256)) throw new Error("native-binding-required")
  const stat = await lstat(bindingFile)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || path.resolve(await realpath(bindingFile)) !== path.resolve(bindingFile)
    || createHash("sha256").update(await readFile(bindingFile)).digest("hex") !== bindingSha256) throw new Error("native-binding-refused")
  // Load actual native exports, not cached/hooked JS-shaped authority.
  const nativeModule = new Module(bindingFile)
  nativeModule.filename = bindingFile
  loadNative(nativeModule, bindingFile)
  const sdk = nativeModule.exports
  if (sdk.abi !== "codenomad.runtime.v1" || Object.hasOwn(sdk, "fixtureAuthorizeNestedResponse")
    || ["openServicePeer", "prepareServiceStarter", "readServiceStarter", "waitServiceStarter", "killServiceStarter",
      "finishServiceStarter", "closeServiceStarter", "release"].some(name => typeof sdk[name] !== "function")) throw new Error("native-binding-refused")
  Object.freeze(sdk)
  const opened = await sdk.openServicePeer(randomBytes(32))
  const { launcherModule, launcherSha256 } = opened.application
  if (trustedLauncher && (launcherModule !== trustedLauncher.launcherModule || launcherSha256 !== trustedLauncher.launcherSha256)) {
    opened.channel.destroy(); sdk.release(opened.nativeSession); throw new Error("native-launcher-refused")
  }
  if (createHash("sha256").update(await readFile(launcherModule)).digest("hex") !== launcherSha256) throw new Error("native-launcher-refused")
  const { createNativeServiceLauncher, prepareServiceStarter } = await import(pathToFileURL(launcherModule).href)
  const pending = new Map(), starters = new Map()
  let incoming = 0, stopping = false
  const reply = (id, result, error) => write(opened.channel, { v: 1, id, profile: opened.application.profile, generation: opened.application.generation,
    result, ...(error ? { error } : {}) })
  const stop = async () => {
    if (stopping) return; stopping = true
    for (const child of starters.values()) child.kill("SIGKILL")
    await Promise.allSettled(pending.values())
    sdk.release(opened.nativeSession); process.exit(1)
  }
  opened.channel.on("error", () => { void stop() }); opened.channel.on("close", () => { void stop() })
  const receive = async value => {
    if (value.id !== ++incoming || !Number.isSafeInteger(value.deadline) || value.deadline <= Date.now()) { void stop(); return }
    if (value.method === "cancel") { starters.get(value.params?.id)?.kill("SIGKILL"); await reply(value.id, {}); return }
    if (stopping || value.method !== "service.start" || pending.size >= 16) { await reply(value.id, undefined, "native-service-refused"); return }
    const bytes = Buffer.from(value.params.bytes, "hex"), grant = Buffer.from(value.params.grant, "hex")
    const envelope = JSON.parse(bytes.toString())
    let owned
    const launcher = createNativeServiceLauncher(async (file, args, options, deadline) => {
      if (deadline !== envelope.deadline || file !== envelope.request.file || JSON.stringify(args) !== JSON.stringify(envelope.request.args)
        || options.cwd !== envelope.request.cwd || JSON.stringify(options.env) !== JSON.stringify(envelope.request.env)
        || options.windowsVerbatimArguments !== envelope.request.windowsVerbatimArguments || stopping) throw new Error("native-service-execution-mismatch")
      const prepared = await prepareOwnedStarter(sdk, opened.nativeSession, grant, bytes, prepareServiceStarter)
      owned = prepared.starter
      if (stopping) { owned.kill("SIGKILL"); owned.release(); throw new Error("native-service-fenced") }
      starters.set(value.id, owned); return prepared.handoff
    })
    const operation = (async () => {
      let executionFailed = false
      try {
        let output
        try { output = await launcher(envelope.request, envelope.deadline) }
        catch { executionFailed = Boolean(owned); throw new Error("native-service-execution-failed") }
        const receipt = await owned.receipt()
        await reply(value.id, { output, receipt: receipt.toString("hex") })
      } catch { await reply(value.id, undefined, executionFailed ? "native-service-failed" : "native-service-refused") }
      finally { starters.delete(value.id); owned?.release() }
    })()
    pending.set(value.id, operation)
    try { await operation } finally { pending.delete(value.id) }
  }
  // The native open authenticates S before any service frame reaches this callback.
  framed(opened.channel, value => { void receive(value).catch(stop) }, () => { void stop() })
}
