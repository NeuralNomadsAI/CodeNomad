import test from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"

const exec = promisify(execFile)
const url = (file: string) => new URL(file, import.meta.url).href
const temp = process.platform === "win32" ? "C:/Users/Admin/AppData/Local/Temp/opencode" : tmpdir()
/** Each cache/hook/clock/timer probe has its own Node process and newly owned
 * files. No global checkout caches, native addon, profile or daemon are touched. */
async function probe(source: string, args: string[] = []) {
  const root = await mkdtemp(path.join(temp, "native-boundary-probe-"))
  try {
    const file = path.join(root, "probe.mts")
    await writeFile(file, source)
    const result = await exec(process.execPath, ["--import", "tsx", file, root, ...args], {
      cwd: process.cwd(), timeout: 20_000, maxBuffer: 64 * 1024,
    })
    assert.equal(result.stderr, "")
    assert.equal(result.stdout.trim(), "probe-passed")
  } finally { await rm(root, { recursive: true, force: true }) }
}

for (const mode of ["cache", "extension-hook"] as const) {
  test(`actual native loading rejects text .node with ${mode} SDK contamination in an isolated Node child`, async () => {
    await probe(`
import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Duplex } from "node:stream";
import path from "node:path";
import { NativeRuntimeBinding } from ${JSON.stringify(url("./native-runtime-binding.ts"))};
import { NativeRuntimeCapability } from ${JSON.stringify(url("./native-runtime.ts"))};
import { canonicalScope } from ${JSON.stringify(url("./protocol.ts"))};
import { fileURLToPath } from "node:url";
const root = process.argv[2], mode = process.argv[3];
const file = path.join(root, "isolated.node"), bytes = Buffer.from("This is JS cache bait, not a native binary");
await writeFile(file, bytes);
const scope = canonicalScope("stable", path.join(root, "config.yaml"), root, root), generation = randomUUID();
const launch = Buffer.from(JSON.stringify({ root, scope, generation, backend: {
  file: process.execPath, args: [fileURLToPath(new URL(${JSON.stringify(url("./backend-entry.ts"))}))], cwd: root
} }));
let opened = 0, hooks = 0;
const sdk = { abi: "codenomad.runtime.v1",
  async openManager() { opened++; return { channel: new Duplex({ read() {}, write(_b,_e,cb) { cb(); } }),
    nativeSession: {}, key: Buffer.alloc(32, 5), launch, attestation: Buffer.from("fake") }; },
  async verifyManager(_s, nonce) { return { nonce: nonce.toString("hex"), scope, generation, runtimeId: "f".repeat(64),
    manager: { pid: process.pid, filetime: "100" }, supervisor: { pid: process.pid + 1, filetime: "101" }, alive: true,
    assignedSuspended: true, supervisorOutsideAllJobs: true, ownerBootstrapVerified: true,
    soleJobOwnerPid: process.pid + 1, jobHandleInherited: false, limitFlags: 0x2000,
    servicePeer: { pid: process.pid + 2, filetime: "102", outsideAllJobs: true, policyScope: scope.key, launcher: "native-service-launcher-v1" } }; },
  async verifyMember() {}, async authorizeService() {}, async verifyService() {}, release() {}
};
const require = createRequire(import.meta.url);
const cached = new Module(file); cached.filename = file; cached.exports = sdk; cached.loaded = true;
const previousExtension = require.extensions[".node"];
if (mode === "cache") require.cache[file] = cached;
else require.extensions[".node"] = module => { hooks++; module.exports = sdk; };
const outcome = await NativeRuntimeBinding.load(file, createHash("sha256").update(bytes).digest("hex"))
  .then(async binding => { const capability = await NativeRuntimeCapability.open(binding); NativeRuntimeCapability.assert(capability);
    await capability.fatal("startup-failed").catch(() => {}); return "wrongly-certified"; }, error => error.code);
assert.equal(outcome, "native-runtime-binding-unverified");
assert.equal(opened, 0); assert.equal(hooks, 0);
if (mode === "cache") assert.equal(require.cache[file], cached);
else assert.notEqual(require.extensions[".node"], previousExtension);
console.log("probe-passed");
`, [mode])
  })
}

test("valid MAC reply after absolute/capped expiry rejects while all timeout callbacks are held; revokes concurrent and subsequent calls", async () => {
  await probe(`
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { createHmac, randomUUID } from "node:crypto";
import { RuntimeTransport, RuntimeOpcode } from ${JSON.stringify(url("./native-runtime-transport.ts"))};
let now = 1000;
Date.now = () => now;
const timers = new Set();
globalThis.setTimeout = (fn, ms) => { const timer = { fn, ms }; timers.add(timer); return timer; };
globalThis.clearTimeout = timer => { timers.delete(timer); };
for (const capped of [false, true]) {
  const writes = [], key = Buffer.alloc(32, 6);
  const channel = new Duplex({ read() {}, write(bytes,_e,cb) { writes.push(Buffer.from(bytes)); cb(); } });
  const transport = new RuntimeTransport(channel, key, "a".repeat(64), randomUUID());
  const start = now, deadline = start + (capped ? 100000 : 100);
  let published = false;
  const first = transport.request(RuntimeOpcode.member, Buffer.from("owned"), deadline).then(() => { published = true; }, error => error.code);
  const other = transport.request(RuntimeOpcode.member, Buffer.from("concurrent"), start + 100000).catch(error => error.code);
  const content = Buffer.from(writes[0].subarray(4, -32)); content[61] = 1;
  const mac = createHmac("sha256", key).update(content).digest(), size = Buffer.alloc(4); size.writeUInt32LE(content.length + 32);
  now = start + (capped ? 30000 : 100);
  channel.emit("data", Buffer.concat([size, content, mac]));
  assert.equal(await first, "native-runtime-timeout");
  assert.equal(await other, "native-runtime-channel-lost");
  assert.equal(published, false); assert.equal(transport.available, false); assert.equal(channel.destroyed, true);
  await assert.rejects(transport.request(RuntimeOpcode.member, Buffer.alloc(0), now + 100), /native-runtime-unavailable/);
  assert.equal(timers.size, 0); assert.ok(key.equals(Buffer.alloc(32)));
}
console.log("probe-passed");
`)
})

test("deadline observations share absolute expiry across stages; timer-lagged results cannot renew initial-manager qualification", async () => {
  await probe(`
import assert from "node:assert/strict";
import { NativeDeadline } from ${JSON.stringify(url("./native-deadline.ts"))};
let now = 1000;
Date.now = () => now;
const timers = new Set();
globalThis.setTimeout = (fn, ms) => { const timer = { fn, ms }; timers.add(timer); return timer; };
globalThis.clearTimeout = timer => { timers.delete(timer); };
let revoked = 0, startedExpired = false;
const budget = new NativeDeadline(100, undefined, () => { revoked++; });
assert.equal(await budget.observe(async () => { now += 70; return "open"; }), "open");
await assert.rejects(budget.observe(async () => { now += 30; return "verified"; }), /native-runtime-timeout/);
await assert.rejects(budget.observe(async () => { startedExpired = true; }), /native-runtime-timeout/);
assert.equal(startedExpired, false); assert.ok(revoked > 0); assert.equal(timers.size, 0);
console.log("probe-passed");
`)
})
