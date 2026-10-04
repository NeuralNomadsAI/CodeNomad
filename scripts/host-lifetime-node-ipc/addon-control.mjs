import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { addonConfig } from "./addon-config.mjs"
import { fileURLToPath } from "node:url"
import path from "node:path"
const repo = fileURLToPath(new URL("../../", import.meta.url))
const root = process.argv[2]
const { config, dispose } = await addonConfig(root, ["drain", "product-closed"].includes(process.argv[3]) ? process.argv[3] : "crash")
const data = Buffer.from(JSON.stringify(config)), size = Buffer.alloc(4); size.writeUInt32LE(data.length)
const child = spawn(path.join(repo, "packages/native-host-lifetime/target/debug/host-lifetime-fixture.exe"),
  ["supervisor-channel"], { cwd: repo, env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
const chunks = []; let output = 0
child.stdout.on("data", bytes => { output += bytes.length; if (output > 4096) child.kill(); else chunks.push(bytes) })
let failure = ""
child.stderr.on("data", bytes => { if (failure.length < 256) failure += bytes.toString() })
const timer = setTimeout(() => child.kill(), 55_000)
child.stdin.end(Buffer.concat([size, data]))
try {
  const code = await new Promise((resolve, reject) => { child.once("error", () => reject(new Error("private-addon-failed"))); child.once("close", resolve) })
  if (code !== 0) throw new Error(/^(native-[a-z0-9-]+\s*)+$/.test(failure) ? failure.trim() : "private-addon-failed")
  const proof = JSON.parse(Buffer.concat(chunks).toString())
  assert.equal(proof.compiledAddon, true); assert.equal(proof.nativePrivateChannel, true)
  assert.equal(proof.independentLaunchQualified, false); assert.equal(proof.productManagerQualified, false)
  console.log(JSON.stringify(proof))
} finally { clearTimeout(timer); if (child.exitCode === null) child.kill();await dispose() }
