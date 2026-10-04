// Private fixture manifest construction only; never discovers a user's runtime/profile.
import { createHash, randomUUID } from "node:crypto"
import { readFile, writeFile, unlink } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
const repo = fileURLToPath(new URL("../../", import.meta.url))
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
export async function addonConfig(root, mode = "crash", responseCase) {
  const generation = randomUUID(), configIdentity = path.join(root, "config.yaml").toLowerCase()
  const profile = hash(`private\0${configIdentity}`)
  const bindingFile = path.join(repo, "packages/native-host-lifetime/target/debug/codenomad_native_host_lifetime.node")
  const bindingSha256 = hash(await readFile(bindingFile)), brokerEntry = path.join(root, "broker-entry.mjs")
  const fault = ["malformed-peer", "unknown-peer-id", "unconfirmed-failure", "wrong-peer-scope", "oversize-output"].includes(responseCase)
  const source = fault
    ? `import { runFaultPeer } from ${JSON.stringify(new URL("./service-fault-peer.mjs", import.meta.url).href)};runFaultPeer(${JSON.stringify(bindingFile)},${JSON.stringify(bindingSha256)},${JSON.stringify(responseCase)}).catch(()=>process.exit(1));`
    : `import { runNativeServiceBroker } from ${JSON.stringify(new URL("../../packages/native-host-lifetime/node/service-broker.mjs", import.meta.url).href)};runNativeServiceBroker(${JSON.stringify(bindingFile)},${JSON.stringify(bindingSha256)}).catch(()=>process.exit(1));`
  await writeFile(brokerEntry, source, { flag: "wx" })
  const launcherModule = path.join(repo, "packages/server/src/workspaces/native-service-launcher.ts")
  const request = { file: process.execPath, args: [fileURLToPath(new URL("./mock-service-cli.mjs", import.meta.url)), "service", "start"], cwd: repo, windowsVerbatimArguments: false }
  const config = { v: 1, profile, generation, manager: { node: process.execPath,
    entry: fileURLToPath(new URL(responseCase ? "./service-response-manager.ts" : mode === "product-closed" ? "./addon-product-manager.ts" : "./addon-manager.ts", import.meta.url)),
    cwd: repo, loader: new URL("./loader.mjs", import.meta.url).href },
    application: { root, generation, scope: { key: profile, channel: "private", configIdentity },
      backend: { file: process.execPath, args: [path.join(repo, "packages/server/src/host-lifetime/backend-entry.ts")], cwd: repo },
      fixtureMode: responseCase ? "service-response" : mode,
      ...(responseCase ? { fixtureResponseCase: responseCase, fixtureServiceRequest: request } : {}) },
    broker: { program: { node: process.execPath, entry: brokerEntry, cwd: repo, loader: new URL("./loader.mjs", import.meta.url).href },
      launcherModule, bindingFile, bindingSha256, entrySha256: hash(source), launcherSha256: hash(await readFile(launcherModule)),
      policy: { executable: request.file, cwd: repo, windowsVerbatimArguments: false, argsPrefix: request.args } } }
  return { config, dispose: () => unlink(brokerEntry) }
}
