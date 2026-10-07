/** Explicit native-owner prerequisite: run in the provisioned Windows job after the
 * addon artifact is built. Missing/wrong artifacts FAIL, never skip or fall back
 * to SDK JS. This fixture builds nothing and qualifies loader behavior only. */
import test from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"

test("actual compiled N-API artifact loads despite cache/hook bait; native exports reject fabricated session", async () => {
  const bytes = await readFile(new URL("../../../native-host-lifetime/target/debug/codenomad_native_host_lifetime.node", import.meta.url))
  // Loader regression only: actual native owner produced this addon; copying
  // its existing bytes creates an isolated single-link artifact. No native
  // bootstrap, supervisor, profile, daemon or package artifacts are mutated.
  const parent = path.join(tmpdir(), "opencode")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "native-positive-loader-"))
  try {
    const artifact = path.join(root, "compiled.node"), script = path.join(root, "probe.mts")
    await writeFile(artifact, bytes)
    await writeFile(script, `
import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { NativeRuntimeBinding } from ${JSON.stringify(new URL("./native-runtime-binding.ts", import.meta.url).href)};
const file = process.argv[2], digest = process.argv[3], require = createRequire(import.meta.url);
let jsCalls = 0;
const bait = { abi: "codenomad.runtime.v1" };
for (const method of ["openManager", "verifyManager", "verifyMember", "authorizeService", "verifyService", "release"])
  bait[method] = () => { jsCalls++; throw new Error("wrongly-used-JS"); };
const cached = new Module(file); cached.exports = bait; cached.loaded = true; require.cache[file] = cached;
const hook = module => { jsCalls++; module.exports = bait; }; require.extensions[".node"] = hook;
const binding = await NativeRuntimeBinding.load(file, digest);
NativeRuntimeBinding.assert(binding);
assert.equal(binding.production, true); assert.equal(binding.sdk.abi, "codenomad.runtime.v1");
assert.notEqual(binding.sdk, bait);
await assert.rejects(Promise.resolve().then(() => binding.sdk.verifyMember({}, process.pid, Buffer.alloc(32), Buffer.alloc(0))), /native-runtime-request-refused/);
assert.equal(jsCalls, 0); assert.equal(require.cache[file], cached); assert.equal(require.extensions[".node"], hook);
console.log("compiled-loader-positive");
`)
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", script, artifact, createHash("sha256").update(bytes).digest("hex")], {
      cwd: process.cwd(), timeout: 20_000, maxBuffer: 64 * 1024,
    })
    assert.equal(result.stderr, "")
    assert.equal(result.stdout.trim(), "compiled-loader-positive")
  } finally { await rm(root, { recursive: true, force: true }) }
})
