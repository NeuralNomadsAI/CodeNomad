import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test, type TestContext } from "node:test"
import { OpenCodeLoginStart, type LoginStartLaunch, type LoginStartPlatform } from "./opencode-login-start"
import { legacySupervision } from "./opencode-login-start-legacy"

const key = "a".repeat(64), other = "b".repeat(64)
const launch: LoginStartLaunch = { command: "/opt/opencode", args: ["serve", "--service"] }

async function scratch(t: TestContext) {
  await mkdir(path.join(os.tmpdir(), "opencode"), { recursive: true })
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode", "login-start-legacy-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
async function legacyEntry(root: string, id: string, desired: "on" | "off" | "unset") {
  await mkdir(path.join(root, id), { recursive: true })
  await writeFile(path.join(root, id, "manifest.json"), JSON.stringify({ v: 1, key: id, desired, revision: 3, receipt: { control: {} } }))
  await writeFile(path.join(root, id, "windows.json"), "{}")
}
const manifest = async (root: string, id: string) => JSON.parse(await readFile(path.join(root, id, "manifest.json"), "utf8"))
const exists = (file: string) => readFile(file).then(() => true, () => false)

function fakePlatform(fail = false) {
  let installed = false
  const calls: string[] = []
  const platform: LoginStartPlatform = {
    installed: async () => installed,
    install: async () => { calls.push("install"); if (fail) throw new Error("refused"); installed = true },
    remove: async () => { calls.push("remove"); installed = false },
  }
  return { platform, calls }
}

test("Windows: a former ON installs the login task first, releases each guard, then unregisters its exact tasks", async t => {
  const root = path.join(await scratch(t), "CodeNomadServiceSupervision")
  await legacyEntry(root, key, "on")
  await legacyEntry(root, other, "off")
  const scripts: string[] = [], seen: string[] = [], fake = fakePlatform()
  let result = "pending"
  const powershell = async (script: string) => {
    scripts.push(script)
    const id = script.includes(key) ? key : other
    seen.push(`${id.slice(0, 1)}:${(await manifest(root, id)).desired}:${fake.calls.join(",")}`)
    return result
  }
  const loginStart = new OpenCodeLoginStart({ platform: fake.platform, launch: async () => launch,
    legacy: legacySupervision({ platform: "win32", root, powershell }) })
  assert.deepEqual(await loginStart.read(), { state: "on" })
  // The new task exists before any guard is released; every guard sees OFF first.
  assert.deepEqual(seen, ["a:off:install", "b:off:install"])
  assert.deepEqual((await manifest(root, key)).revision, 4)
  // A Main guard still releasing keeps its tasks and directory for the next pass.
  assert.deepEqual((await readdir(root)).sort(), [key, other])
  for (const script of scripts) {
    assert.ok(script.indexOf("Disable-ScheduledTask") < script.indexOf("Unregister-ScheduledTask"))
    assert.equal(/Stop-ScheduledTask -InputObject \$a|Stop-Process|taskkill/.test(script), false, "Main is never stopped")
    assert.match(script, /CodeNomad-OpenCode-[ab]{64}-Main/)
    assert.match(script, /CodeNomad OpenCode supervision v1 key=[ab]{64} root=/)
    assert.ok(script.includes("'ObjectNotFound'") && !script.includes("SilentlyContinue"), "a failed lookup never reads as a removed task")
  }
  // Turning the preference off meanwhile is not undone by the remaining migration.
  assert.deepEqual(await loginStart.set(false), { state: "off" })
  result = "removed"
  assert.deepEqual(await loginStart.read(), { state: "off" })
  assert.deepEqual(fake.calls, ["install", "remove"])
  assert.equal(await exists(root), false)
  scripts.length = 0
  assert.deepEqual(await loginStart.read(), { state: "off" })
  assert.deepEqual(scripts, [], "nothing left to migrate")
})

test("Windows: a refused new installation keeps the former ON in place and visible; turning it off retires it without installing", async t => {
  const root = path.join(await scratch(t), "CodeNomadServiceSupervision")
  await legacyEntry(root, key, "on")
  const scripts: string[] = [], fake = fakePlatform(true)
  const loginStart = new OpenCodeLoginStart({ platform: fake.platform, launch: async () => launch,
    legacy: legacySupervision({ platform: "win32", root, powershell: async script => { scripts.push(script); return "removed" } }) })
  assert.deepEqual(await loginStart.read(), { state: "on" }, "the former supervision still starts OpenCode at login")
  assert.equal((await manifest(root, key)).desired, "on")
  assert.equal(scripts.length, 0)
  await assert.rejects(loginStart.set(true), { code: "failed" })
  assert.equal((await manifest(root, key)).desired, "on")
  assert.deepEqual(await loginStart.set(false), { state: "off" })
  assert.equal(scripts.length, 1)
  assert.ok(scripts[0]!.includes(`root=${path.join(root, key)}'`), "the exact former marker, root included")
  assert.equal(await exists(root), false)
  assert.deepEqual(fake.calls, ["install", "install", "install", "remove"])
})

test("an explicit OFF fails while a former ON cannot be released, so no later read turns it back on", async () => {
  let on = true, releasable = false
  const fake = fakePlatform()
  const loginStart = new OpenCodeLoginStart({ platform: fake.platform, launch: async () => launch, legacy: {
    scan: async () => ({ present: true, on }),
    retire: async () => { if (!releasable) throw new Error("manifest busy"); on = false },
  } })
  await assert.rejects(loginStart.set(false), { code: "failed" })
  assert.deepEqual(fake.calls, [], "OFF installs nothing")
  releasable = true
  assert.deepEqual(await loginStart.set(false), { state: "off" })
  assert.deepEqual(await loginStart.read(), { state: "off" })
  assert.deepEqual(fake.calls, ["remove"])
})

test("Windows: a former OFF or never-chosen preference is cleaned up without a login start", async t => {
  const root = path.join(await scratch(t), "CodeNomadServiceSupervision")
  await legacyEntry(root, key, "unset")
  const fake = fakePlatform()
  const loginStart = new OpenCodeLoginStart({ platform: fake.platform, launch: async () => launch,
    legacy: legacySupervision({ platform: "win32", root, powershell: async () => "removed" }) })
  assert.deepEqual(await loginStart.read(), { state: "off" })
  assert.deepEqual(fake.calls, [])
  assert.equal(await exists(root), false)
})

function posixCommand(responses: Record<string, string | Error>) {
  const calls: string[] = []
  const run = async (file: string, args: string[]) => {
    const call = [path.posix.basename(file), ...args].join(" ")
    calls.push(call)
    const match = Object.entries(responses).find(([prefix]) => call.startsWith(prefix))
    if (match?.[1] instanceof Error) throw match[1]
    return match?.[1] ?? ""
  }
  return { calls, run }
}

const loadedUnit = (file: string, extra = "") => `LoadState=loaded\nFragmentPath=${file}\nKillMode=process\nDropInPaths=${extra}\n`

async function linuxFixture(t: TestContext, phase: string, fingerprint: string) {
  const home = await scratch(t), root = path.join(home, ".codenomad-service-supervision")
  await legacyEntry(root, key, "on")
  const unit = path.join(home, ".config", "systemd", "user", `codenomad-opencode-${key}.service`)
  await mkdir(path.dirname(unit), { recursive: true })
  await writeFile(unit, `[Unit]\nDescription=CodeNomad OpenCode ${key}\n\n[Service]\nKillMode=process\n`)
  await writeFile(path.join(root, "linux-linger.json"), JSON.stringify({ v: 1, user: "1000", host: "h", phase, fingerprint, requests: [key], released: [], deferred: false }))
  return { home, root, unit }
}

test("Linux: stops only the old guard before disabling its unit, and restores owned linger while a session is open", async t => {
  const { home, root, unit } = await linuxFixture(t, "owned", "1:2:3:4")
  const command = posixCommand({ "loginctl show-user 1000 --property=Linger": "yes", "loginctl show-user 1000 --property=Sessions": "c1 c2",
    "loginctl show-session c1": "closing", "loginctl show-session c2": "active", "systemctl --user show": loadedUnit(unit) })
  const fake = fakePlatform()
  const loginStart = new OpenCodeLoginStart({ platform: fake.platform, launch: async () => launch,
    legacy: legacySupervision({ platform: "linux", root, home, uid: "1000", username: "me", command: command.run, lingerFingerprint: async () => "1:2:3:4" }) })
  assert.deepEqual(await loginStart.read(), { state: "on" })
  const unitName = `codenomad-opencode-${key}.service`
  assert.deepEqual(command.calls.filter(call => call.startsWith("systemctl")),
    [`systemctl --user show ${unitName} --property=LoadState,FragmentPath,KillMode,DropInPaths`, `systemctl --user stop ${unitName}`,
      `systemctl --user disable ${unitName}`, "systemctl --user daemon-reload"])
  assert.ok(command.calls.includes("loginctl --no-ask-password disable-linger 1000"))
  assert.equal(await exists(unit), false)
  assert.equal(await exists(root), false)
})

test("Linux: owned linger waits for an open session; personal or altered linger is never touched", async t => {
  const waiting = await linuxFixture(t, "owned", "1:2:3:4")
  const closed = posixCommand({ "loginctl show-user 1000 --property=Linger": "yes", "loginctl show-user 1000 --property=Sessions": "c1",
    "loginctl show-session c1": "closing" })
  const legacy = (fixture: typeof waiting, run: typeof closed.run, fingerprint = "1:2:3:4") =>
    legacySupervision({ platform: "linux", root: fixture.root, home: fixture.home, uid: "1000", username: "me", command: run, lingerFingerprint: async () => fingerprint })
  await new OpenCodeLoginStart({ platform: fakePlatform().platform, launch: async () => launch, legacy: legacy(waiting, closed.run) }).read()
  assert.equal(closed.calls.some(call => call.includes("disable-linger")), false)
  assert.equal(await exists(path.join(waiting.root, "linux-linger.json")), true, "rollback stays pending")

  for (const [phase, fingerprint] of [["external", "1:2:3:4"], ["owned", "changed"], ["uncertain", "1:2:3:4"]] as const) {
    const fixture = await linuxFixture(t, phase, "1:2:3:4")
    const open = posixCommand({ "loginctl show-user 1000 --property=Linger": "yes", "loginctl show-user 1000 --property=Sessions": "c1",
      "loginctl show-session c1": "active" })
    await new OpenCodeLoginStart({ platform: fakePlatform().platform, launch: async () => launch, legacy: legacy(fixture, open.run, fingerprint) }).read()
    assert.equal(open.calls.some(call => call.includes("disable-linger") || call.includes("enable-linger")), false, `${phase} ${fingerprint}`)
    assert.equal(await exists(fixture.root), false)
  }
})

test("Linux: a drop-in or another loaded file never lets the former unit be stopped", async t => {
  for (const [label, shown] of [["drop-in", (unit: string) => loadedUnit(unit, "/home/me/.config/systemd/user/x.service.d/kill.conf")],
    ["other file", () => loadedUnit("/etc/systemd/user/other.service")]] as const) {
    const { home, root, unit } = await linuxFixture(t, "external", "x")
    const command = posixCommand({ "systemctl --user show": shown(unit) })
    await new OpenCodeLoginStart({ platform: fakePlatform().platform, launch: async () => launch,
      legacy: legacySupervision({ platform: "linux", root, home, uid: "1000", username: "me", command: command.run }) }).read()
    assert.equal(command.calls.some(call => / (stop|disable) /.test(call)), false, label)
    assert.equal(await exists(unit), true, label)
  }
})

test("Linux: an unreachable user manager keeps the former unit for the next pass", async t => {
  const { home, root, unit } = await linuxFixture(t, "external", "x")
  const command = posixCommand({ "systemctl --user": new Error("no bus") })
  await new OpenCodeLoginStart({ platform: fakePlatform().platform, launch: async () => launch,
    legacy: legacySupervision({ platform: "linux", root, home, uid: "1000", username: "me", command: command.run }) }).read()
  assert.equal(await exists(unit), true)
  assert.equal(command.calls.some(call => call.includes("disable ")), false)
  assert.equal((await manifest(root, key)).desired, "off")
})

test("macOS: boots out the old guard (AbandonProcessGroup keeps OpenCode) and removes its plist once unloaded", async t => {
  const home = await scratch(t), root = path.join(home, ".codenomad-service-supervision")
  await legacyEntry(root, key, "on")
  const label = `org.codenomad.opencode.${key}`, plist = path.join(home, "Library", "LaunchAgents", `${label}.plist`)
  await mkdir(path.dirname(plist), { recursive: true })
  await writeFile(plist, `<plist><dict><key>Label</key><string>${label}</string></dict></plist>`)
  let loaded = true
  const command = posixCommand({})
  const run = async (file: string, args: string[]) => {
    await command.run(file, args)
    if (args[0] === "print" && loaded) return "loaded"
    if (args[0] === "print") throw new Error("not found")
    return ""
  }
  const fake = fakePlatform()
  const loginStart = new OpenCodeLoginStart({ platform: fake.platform, launch: async () => launch,
    legacy: legacySupervision({ platform: "darwin", root, home, uid: "501", command: run }) })
  assert.deepEqual(await loginStart.read(), { state: "on" })
  assert.deepEqual(command.calls, [`launchctl bootout gui/501/${label}`, `launchctl print gui/501/${label}`])
  assert.equal(await exists(plist), true, "a job still loaded keeps its plist")
  loaded = false
  await loginStart.read()
  assert.equal(await exists(plist), false)
  assert.equal(await exists(root), false)
  assert.deepEqual(fake.calls, ["install"])
})
