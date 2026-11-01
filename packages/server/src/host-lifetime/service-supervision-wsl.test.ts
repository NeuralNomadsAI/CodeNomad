import assert from "node:assert/strict"
import { readFile, mkdtemp, rm, lstat, writeFile } from "node:fs/promises"
import { spawn, type ChildProcess } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { initialSupervisionManifest, supervisionKey } from "./service-supervision-contract"
import { wslRuntimeSchema, wslSupervisionLaunch, wslSupervisionPaths, wslSupervisionLookup } from "./service-supervision-wsl"
import { ServiceSupervisionStore } from "./service-supervision-store"
import { mutateWindowsSupervisionFile } from "./service-supervision-windows-gate"
import { mutateWslSupervisionFile } from "./service-supervision-wsl-lock"

const runtime = wslRuntimeSchema.parse({ executable: "C:\\Windows\\System32\\wsl.exe", distro: "Ubuntu", user: "1000", account: "u",
  owner: "S-1-5-21-1-2-3-1000", manifest: "/mnt/c/private/service/manifest.json",
  environment: { HOME: "/home/u", XDG_CONFIG_HOME: "/home/u/.config", XDG_STATE_HOME: "/home/u/.local/state",
    XDG_DATA_HOME: "/home/u/.local/share", XDG_CACHE_HOME: "/home/u/.cache" } })
const namespace = { platform: "wsl" as const, host: "windows-host", user: "1000", distro: "Ubuntu",
  configDirectory: "/home/u/.config/opencode", stateDirectory: "/home/u/.local/state/opencode", registrationName: "service.json" }

test("WSL foreground bridge pins distro/UID and quotes all paths as argv; OFF releases without signaling managed child", () => {
  const binary = '/home/u/bin with spaces/open"code'
  const args = wslSupervisionLaunch(runtime, binary, 1)
  assert.deepEqual(args.slice(0, 7), ["--distribution", "Ubuntu", "--user", "u", "--exec", "/bin/sh", "-c"])
  assert.match(args[7]!, /trap "" HUP/)
  assert.match(args[7]!, /while kill -0/)
  assert.match(args[7]!, /on \|\| exit 0/)
  assert.doesNotMatch(args[7]!, /setsid|nohup|kill -[A-Z]|service stop/)
  assert.match(args[7]!, /\$\(\/usr\/bin\/id -u\)/)
  assert.equal(args[9], runtime.manifest)
  assert.deepEqual(args.slice(-3), [binary, "serve", "--service"])
  assert.ok(args.includes("HOME=/home/u"))
  assert.match(args[7]!, /\/usr\/bin\/flock -x 9/)
  assert.match(args[7]!, /9>&-/)
  assert.throws(() => wslSupervisionLaunch(runtime, "relative", 1))
  assert.throws(() => wslSupervisionLaunch(runtime, "/a/../b", 1))
  assert.throws(() => wslSupervisionLaunch(runtime, binary, -1))
})

test("WSL runtime accepts only minimal native paths and keeps user/distro/roots separate from Windows identity", async () => {
  assert.throws(() => wslRuntimeSchema.parse({ ...runtime, environment: { ...runtime.environment, OPENAI_API_KEY: "secret" } }))
  assert.throws(() => wslRuntimeSchema.parse({ ...runtime, environment: { ...runtime.environment, HOME: "C:\\home" } }))
  assert.throws(() => wslRuntimeSchema.parse({ ...runtime, distro: "Ubuntu/other" }))
  assert.throws(() => wslRuntimeSchema.parse({ ...runtime, user: "pascal" }))
  for (const changed of [{ distro: "Other" }, { user: "1001" }, { stateDirectory: "/other/state/opencode" },
    { host: "windows-host:S-1-5-21-1-2-3-1001" }])
    assert.notEqual(supervisionKey(namespace), supervisionKey({ ...namespace, ...changed }))
  const manifest = initialSupervisionManifest(namespace, { binary: "/bin/opencode", provenance: "custom" })
  for (const changed of [{ distro: "Other" }, { user: "1001" },
    { environment: { ...runtime.environment, XDG_STATE_HOME: "/other/state" } }])
    await assert.rejects(wslSupervisionPaths(manifest, { ...runtime, ...changed }), /namespace/)
  assert.deepEqual(await wslSupervisionLookup(runtime)(-1), { state: "unknown" })
})

test("WSL shares the Windows OS backstop and release contract", async () => {
  const script = await readFile(new URL("./service-supervision-windows.ps1", import.meta.url), "utf8")
  assert.match(script, /New-TimeSpan -Seconds 10\) -MultipleInstances Queue/)
  assert.match(script, /RepetitionInterval \(New-TimeSpan -Minutes 1\)/)
  assert.match(script, /\$d\.wsl\.owner/)
  assert.match(script, /\$again\.launch/)
  assert.match(script, /\$value -notmatch '\[\\s"\]'/)
  assert.match(script, /WaitForSingleObject\(\$child\.process,8000\)/)
  assert.doesNotMatch(script, /TerminateProcess|DETACHED_PROCESS[^\n]*true/)
})

test("every WSL manifest mutation uses the namespace publisher; an absent publisher refuses writes", { skip: process.platform !== "win32" }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wsl-store-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const policy = { async verify(file: string, directory: boolean) {
    const stat = await lstat(file)
    assert.ok(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1))
  } }
  let locks = 0, held = false
  const target = { binary: "/bin/opencode", provenance: "custom" as const }
  const store = new ServiceSupervisionStore(root, namespace, target, policy, undefined, async update => {
    locks++; held = true
    try { await mutateWindowsSupervisionFile(path.join(store.directory, "manifest.json"), update) } finally { held = false }
  })
  await store.control({ requestID: randomUUID(), action: "on", expectedRevision: 0 }, () => assert.equal(held, true))
  assert.equal(locks, 1)
  await store.acknowledge(1)
  await store.recordAttempt(1, null)
  assert.equal(locks, 3)
  const unfenced = new ServiceSupervisionStore(root, namespace, target, policy)
  await assert.rejects(unfenced.control({ requestID: randomUUID(), action: "off", expectedRevision: 1 }), /invalid/)
  assert.equal((await store.read()).desired, "on")
  await store.control({ requestID: randomUUID(), action: "off", expectedRevision: 1 })
  assert.equal(locks, 4)
  assert.equal((await store.read()).desired, "off")
})

test("WSL publisher death before an asynchronous update returns cannot publish a late write", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wsl-publication-")), file = path.join(root, "manifest.json")
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(file, "original")
  let holder: ChildProcess | undefined, release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const updating = new Promise<void>(resolve => { entered = resolve })
  const launch: typeof spawn = ((_executable: string, args: string[]) => {
    const script = args[7]!
    assert.ok(script.indexOf("/usr/bin/flock -xn 9") < script.indexOf("READY:"))
    assert.ok(script.indexOf("/usr/bin/flock -xn 9") < script.indexOf("/bin/mv -fT"))
    assert.match(script, /exec 9>>/)
    assert.deepEqual(args.slice(-3), [runtime.manifest, "/mnt/c/private/service/linux-admission.lock", runtime.user])
    holder = spawn(process.execPath, ["-e", `const fs = require('node:fs'); process.stdout.write('READY:-\\n');
      process.stdin.once('data', bytes => { fs.writeFileSync(${JSON.stringify(file)}, Buffer.from(String(bytes).trim(), 'base64'));
        process.stdout.write('COMMITTED\\n'); process.stdin.destroy(); });`], { stdio: ["pipe", "pipe", "pipe"] })
    return holder
  }) as typeof spawn
  await mutateWslSupervisionFile(runtime, async () => "committed by holder", launch)
  assert.equal(await readFile(file, "utf8"), "committed by holder")
  await writeFile(file, "original")
  const result = mutateWslSupervisionFile(runtime, async () => { entered(); await blocked; return "late" }, launch)
  const rejected = assert.rejects(result, /busy/)
  await updating
  holder!.kill()
  await rejected
  release()
  await blocked
  assert.equal(await readFile(file, "utf8"), "original")
})

test("WSL native qualification never terminates a general-purpose distro", async () => {
  const script = await readFile(new URL("../../../../scripts/test-service-supervision-wsl-native.mjs", import.meta.url), "utf8")
  assert.doesNotMatch(script, /--terminate|--shutdown/)
})

test("Linux publication owns flock through flush/rename and excludes a second writer", { skip: process.platform !== "linux" }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wsl-native-publisher-")), file = path.join(root, "manifest.json")
  t.after(() => rm(root, { recursive: true, force: true }))
  const native = { ...runtime, user: String(process.getuid!()), manifest: file }
  const launch: typeof spawn = ((_executable: string, args: string[]) => spawn("/bin/sh", args.slice(6),
    { stdio: ["pipe", "pipe", "pipe"] })) as typeof spawn
  await writeFile(file, "original")
  await mutateWslSupervisionFile(native, async before => {
    assert.equal(before, "original")
    await assert.rejects(mutateWslSupervisionFile(native, async () => "competing", launch), /busy/)
    assert.equal(await readFile(file, "utf8"), "original")
    return "published"
  }, launch)
  assert.equal(await readFile(file, "utf8"), "published")
})
