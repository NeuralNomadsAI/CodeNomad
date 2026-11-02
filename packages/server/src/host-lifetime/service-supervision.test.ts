import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { mkdtemp, mkdir, lstat, readFile, rm, writeFile, link } from "node:fs/promises"
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import {
  applySupervisionControl, initialSupervisionManifest, parseSupervisionManifest, supervisionKey,
  supervisionStatus, type SupervisionNamespace, type SupervisionObservation,
} from "./service-supervision-contract"
import { ServiceSupervisionStore } from "./service-supervision-store"
import type { StoragePolicy } from "./storage"
import { readSupervisionHealth } from "./service-supervision-health"
import { privateStorage } from "./storage"
import { HostError } from "./protocol"
import { setTimeout } from "node:timers/promises"

const namespace: SupervisionNamespace = { platform: "win32", host: "test-host", user: "S-1-5-21-1-2-3-1000",
  configDirectory: "C:\\test\\config\\opencode", stateDirectory: "C:\\test\\state\\opencode", registrationName: "service.json" }
const target = { binary: "C:\\Program Files\\OpenCode\\opencode.exe", provenance: "npm" as const }
const initial = () => initialSupervisionManifest(namespace, target)
const control = (action: "on" | "off" | "first-play" | "retry", expectedRevision: number) => ({ requestID: randomUUID(), action, expectedRevision })
const acknowledge = (value: ReturnType<typeof initial>) => parseSupervisionManifest({ ...value, reconciledRevision: value.revision })
const observation = (revision: number): SupervisionObservation => ({ revision, resources: "installed", guard: "active",
  health: { state: "healthy", pid: 123, id: "instance", startIdentity: "start" } })
// Storage permissions have their own native evaluator tests. These deterministic
// store tests retain type/link checks and exercise real atomic filesystem effects.
const policy: StoragePolicy = { async verify(file, directory) {
  const stat = await lstat(file)
  assert.equal(stat.isSymbolicLink(), false)
  assert.equal(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1, true)
} }
async function fixture(t: TestContext) {
  const temp = path.join(os.tmpdir(), "opencode")
  await mkdir(temp, { recursive: true })
  const root = await mkdtemp(path.join(temp, "codenomad-supervision-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, store: new ServiceSupervisionStore(root, namespace, target, policy) }
}

test("service key is shared across profiles/binaries/incarnations, and distinguishes channels/UID/host/distro/roots", () => {
  const key = supervisionKey(namespace)
  assert.equal(key, supervisionKey({ ...namespace, stateDirectory: namespace.stateDirectory.toUpperCase() }))
  for (const changed of [{ registrationName: "service-beta.json" }, { user: "S-1-5-21-1-2-3-1001" },
    { host: "other" }, { stateDirectory: "C:\\other\\opencode" }, { configDirectory: "C:\\other\\config" }])
    assert.notEqual(key, supervisionKey({ ...namespace, ...changed }))
  const wsl: SupervisionNamespace = { platform: "wsl", host: "test-host", user: "1000", distro: "Ubuntu",
    configDirectory: "/home/u/.config/opencode", stateDirectory: "/home/u/.local/state/opencode", registrationName: "service.json" }
  assert.notEqual(supervisionKey(wsl), supervisionKey({ ...wsl, distro: "Other" }))
  assert.throws(() => supervisionKey({ ...wsl, distro: undefined }))
  assert.throws(() => supervisionKey({ ...namespace, stateDirectory: "C:\\test\\..\\state" }))
  assert.throws(() => supervisionKey({ ...namespace, registrationName: "../service.json" }))
})

test("creation is unset, first Play defaults ON, explicit OFF survives first Play and retries", () => {
  const start = initial()
  assert.equal(start.desired, "unset")
  assert.equal(applySupervisionControl(start, control("first-play", 0)).desired, "on")
  const off = applySupervisionControl(start, control("off", 0))
  assert.deepEqual(applySupervisionControl(off, control("first-play", 1)), off)
  assert.deepEqual(applySupervisionControl(off, control("retry", 1)), off)
})

test("lost ACK reuses exact receipt; stale ON cannot cross OFF; unfinished operation stays fenced", () => {
  const on = control("on", 0), value = applySupervisionControl(initial(), on)
  assert.deepEqual(applySupervisionControl(value, on), value)
  assert.throws(() => applySupervisionControl(value, { ...on, action: "off" }), /conflict/)
  assert.throws(() => applySupervisionControl(value, control("on", 1)), /busy/)
  const off = applySupervisionControl(value, control("off", 1))
  assert.equal(off.desired, "off")
  assert.throws(() => applySupervisionControl(off, on), /conflict/)
  assert.equal(off.receipt?.appliedRevision, 2)
})

test("binary selection keeps service identity and preference; namespace/argv/secrets never enter the manifest", () => {
  const value = applySupervisionControl(initial(), { requestID: randomUUID(), expectedRevision: 0,
    action: "select-binary", target: { binary: "C:\\new path\\opencode.exe", provenance: "custom" } })
  assert.equal(value.key, initial().key)
  assert.equal(value.desired, "unset")
  assert.equal(value.target.binary, "C:\\new path\\opencode.exe")
  for (const target of [{ ...value.target, arguments: ["serve"] }, { ...value.target, environment: { TOKEN: "secret" } },
    { ...value.target, binary: "opencode" }]) assert.throws(() => parseSupervisionManifest({ ...value, target }), /invalid/)
  assert.throws(() => parseSupervisionManifest({ ...value, namespace: { ...namespace, user: "other-user" } }), /invalid/)
  assert.throws(() => parseSupervisionManifest({ ...value, secret: "hidden" }), /invalid/)
})

test("status requires matching revision, exact OS install, active guard and healthy service", () => {
  const pending = applySupervisionControl(initial(), control("on", 0)), on = acknowledge(pending)
  assert.equal(supervisionStatus(pending, observation(1)).state, "pending")
  assert.equal(supervisionStatus(on, observation(1)).state, "running")
  assert.equal(supervisionStatus(on, { ...observation(1), guard: "absent" }).cause, "guard-absent")
  assert.equal(supervisionStatus(on, { ...observation(1), guard: "absent" }).serviceResponding, true)
  assert.equal(supervisionStatus(on, observation(0)).cause, "observation-stale")
  assert.equal(supervisionStatus(on, observation(0)).serviceResponding, false)
  for (const state of ["unknown", "unhealthy", "absent"] as const)
    assert.equal(supervisionStatus(on, { ...observation(1), health: { state } }).state, "failing")
  assert.equal(supervisionStatus(on, { ...observation(1), health: { state: "starting" } }).state, "installed")
  const off = acknowledge(applySupervisionControl(on, control("off", 1)))
  assert.deepEqual(supervisionStatus(off, { ...observation(2), resources: "absent", guard: "absent" }), {
    desired: "off", revision: 2, state: "off", cause: null, serviceResponding: true,
  })
})

test("two stores share atomic intent/CAS and exact read-only request reconciliation", async t => {
  const { root, store } = await fixture(t), other = new ServiceSupervisionStore(root, namespace, target, policy)
  const on = control("on", 0)
  assert.equal((await store.control(on)).desired, "on")
  assert.deepEqual(await other.control(on), await store.read())
  assert.equal((await other.request(on.requestID))?.revision, 1)
  await store.acknowledge(1)
  const off = await other.control(control("off", 1))
  assert.equal(off.desired, "off")
  assert.equal(await store.request(on.requestID), undefined)
  await assert.rejects(store.control(on), /conflict/)
  await assert.rejects(store.acknowledge(1), /conflict/)
  assert.equal((await store.read()).revision, 2)
  assert.equal((await readFile(path.join(store.directory, "manifest.json"), "utf8")).includes("password"), false)
})

test("other POSIX metadata gates stay closed after an unconfirmed writer exit", { skip: ["win32", "linux", "darwin"].includes(process.platform) }, async t => {
  const { root, store } = await fixture(t)
  await store.read()
  const gate = path.join(store.directory, "manifest-mutation")
  await mkdir(gate)
  const module = new URL("./service-supervision-store.ts", import.meta.url).href
  const script = `import { ServiceSupervisionStore } from ${JSON.stringify(module)};
    const store = new ServiceSupervisionStore(${JSON.stringify(root)}, ${JSON.stringify(namespace)}, ${JSON.stringify(target)},
      { verify: async () => {} });
    try { await store.control(${JSON.stringify(control("on", 0))}); process.exitCode = 2; }
    catch (error) { if (error.code !== 'busy') throw error; }`
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], {
    windowsHide: true, stdio: "pipe",
  })
  let error = ""
  child.stderr.on("data", bytes => { error += bytes })
  assert.equal(await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve) }), 0, error)
  await assert.rejects(store.control(control("on", 0)), /busy/)
  await rm(gate, { recursive: true }) // Test owns this deliberately abandoned gate.
  assert.equal((await store.control(control("off", 0))).desired, "off")
})

test("Windows OS admission lock excludes other profiles and is released after a holder crash", { skip: process.platform !== "win32" }, async t => {
  const { root, store } = await fixture(t)
  await store.control(control("on", 0))
  const file = path.join(store.directory, "admission.lock")
  const ps = path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe")
  const script = `$h=[IO.File]::Open('${file.replace(/'/g, "''")}','OpenOrCreate','ReadWrite','None');
    [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); [void][Console]::In.ReadLine(); $h.Dispose()`
  const holder = spawn(ps, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    windowsHide: true, stdio: "pipe",
  })
  const exit = new Promise(resolve => holder.once("exit", resolve))
  t.after(async () => { holder.kill(); await exit })
  await new Promise<void>((resolve, reject) => {
    holder.once("error", reject)
    holder.stdout.once("data", data => { assert.match(String(data), /READY/); resolve() })
  })
  const other = new ServiceSupervisionStore(root, namespace, target, policy)
  await assert.rejects(other.control(control("off", 1)), /busy/)
  holder.kill()
  await exit
  assert.equal((await other.control(control("off", 1))).desired, "off")
  assert.equal((await store.read()).revision, 2)
  assert.equal((await lstat(file)).isFile(), true, "inert file survives; ownership is the OS handle")
})

test("Windows writer crash releases its helper handle and cannot publish a late manifest", { skip: process.platform !== "win32" }, async t => {
  const { store } = await fixture(t)
  await store.read()
  const module = new URL("./service-supervision-windows-gate.ts", import.meta.url).href
  const file = path.join(store.directory, "manifest.json")
  const script = `import { mutateWindowsSupervisionFile } from ${JSON.stringify(module)};
    await mutateWindowsSupervisionFile(${JSON.stringify(file)}, async () => {
      process.stdout.write('READY'); await new Promise(() => {}); return '{}';
    });`
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], {
    windowsHide: true, stdio: "pipe",
  })
  const exit = new Promise(resolve => child.once("exit", resolve))
  t.after(async () => { child.kill(); await exit })
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject)
    child.stdout.once("data", data => { assert.equal(String(data), "READY"); resolve() })
  })
  child.kill()
  await exit
  const off = control("off", 0)
  let applied = false
  for (let attempt = 0; attempt < 10; attempt++) {
    try { assert.equal((await store.control(off)).revision, 1); applied = true; break }
    catch (error) { if ((error as { code?: string }).code !== "busy") throw error }
    await setTimeout(100)
  }
  assert.equal(applied, true)
  assert.equal((await store.read()).desired, "off")
})

test("malformed, foreign, oversized and linked manifest files refuse mutation", async t => {
  const { store } = await fixture(t)
  await store.read()
  const file = path.join(store.directory, "manifest.json")
  for (const bytes of ["{bad", "x".repeat(65537), JSON.stringify({ ...initial(), key: "0".repeat(64) })]) {
    await writeFile(file, bytes)
    await assert.rejects(store.control(control("off", 0)), /invalid|unsafe-storage/)
    assert.equal(await readFile(file, "utf8"), bytes)
  }
  await rm(file)
  const original = path.join(store.directory, "owned-original.json")
  await writeFile(original, JSON.stringify(initial()))
  await link(original, file)
  await assert.rejects(store.control(control("off", 0)))
  assert.equal(await readFile(original, "utf8"), JSON.stringify(initial()))
})

test("native private root and ancestor policy remain enforced by the store", async t => {
  const { root } = await fixture(t)
  if (process.platform === "win32") {
    const ps = path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe")
    const script = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';
      $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User;
      $acl = [System.Security.AccessControl.DirectorySecurity]::new();
      $acl.SetOwner($user); $acl.SetAccessRuleProtection($true, $false);
      foreach ($sid in @($user, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
      }; Set-Acl -LiteralPath '${root.replace(/'/g, "''")}' -AclObject $acl`
    execFileSync(ps, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      windowsHide: true, env: { ...process.env, PSModulePath: path.join(path.dirname(ps), "Modules") },
    })
  }
  const store = new ServiceSupervisionStore(root, namespace, target)
  try { await privateStorage.verify(root, true) } catch (error) {
    assert.ok(error instanceof HostError && error.code === "unsafe-storage-ancestor")
    await assert.rejects(store.control(control("off", 0)), /unsafe-storage/)
    t.diagnostic("Native private leaf provisioned; this runner's ancestor chain is refused. No existing ancestor ACL was changed.")
    return
  }
  assert.equal((await store.control(control("off", 0))).desired, "off")
  assert.equal((await store.read()).revision, 1)
})

test("health uses only exact-file read-only discovery; same live PID recovers without lifecycle effects", async t => {
  const { root } = await fixture(t), file = path.join(root, "service.json")
  const identity = { pid: 123, id: "instance", url: "http://127.0.0.1:12345", version: "future-version", password: "not-for-status" }
  await writeFile(file, JSON.stringify(identity))
  let healthy = false, calls = 0
  const deps = { lookup: async () => ({ state: "live" as const, startIdentity: "same-start" }),
    discover: async (input: unknown) => {
      calls++; assert.deepEqual(input, { file })
      return healthy ? { url: identity.url, auth: { type: "basic" as const, username: "opencode", password: identity.password } } : undefined
    } }
  assert.deepEqual(await readSupervisionHealth(file, deps), { state: "unhealthy" })
  healthy = true
  const result = await readSupervisionHealth(file, deps)
  assert.deepEqual(result, { state: "healthy", pid: 123, id: "instance", startIdentity: "same-start" })
  assert.equal(JSON.stringify(result).includes(identity.password), false)
  assert.equal(calls, 2)
  assert.deepEqual(await readSupervisionHealth(file, { ...deps, discover: async () => { throw new Error(identity.password) } }), { state: "unknown" })
})

test("health refuses incarnation replacement, process reuse, malformed metadata and incomplete process evidence", async t => {
  const { root } = await fixture(t), file = path.join(root, "service.json")
  const identity = { pid: 123, id: "a", url: "http://127.0.0.1:12345" }
  const lookup = async () => ({ state: "live" as const, startIdentity: "original" })
  assert.deepEqual(await readSupervisionHealth(file), { state: "absent" })
  await writeFile(file, "{bad")
  assert.deepEqual(await readSupervisionHealth(file), { state: "unknown" })
  await writeFile(file, JSON.stringify(identity))
  assert.deepEqual(await readSupervisionHealth(file, { lookup: async () => ({ state: "unknown" }) }), { state: "unknown" })
  assert.deepEqual(await readSupervisionHealth(file, { lookup: async () => ({ state: "dead" }) }), { state: "absent" })
  assert.deepEqual(await readSupervisionHealth(file, { lookup, discover: async () => {
    await writeFile(file, JSON.stringify({ ...identity, id: "b" })); return { url: identity.url, auth: undefined }
  } }), { state: "unknown" })
  await writeFile(file, JSON.stringify(identity))
  let reads = 0
  assert.deepEqual(await readSupervisionHealth(file, { lookup: async () => ({ state: "live", startIdentity: String(++reads) }),
    discover: async () => ({ url: identity.url, auth: undefined }) }), { state: "unknown" })
})
