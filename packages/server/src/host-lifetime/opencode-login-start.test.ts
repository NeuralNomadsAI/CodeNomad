import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test, type TestContext } from "node:test"
import Fastify from "fastify"
import { LoginStartError, OpenCodeLoginStart, loginStartEnvironment, resolveLoginStartLaunch, type LoginStartLaunch, type LoginStartPlatform } from "./opencode-login-start"
import { WINDOWS_LOGIN_MARKER, WindowsLoginStart, windowsArgument, windowsLoginTaskXml } from "./opencode-login-start-windows"
import { LINUX_LOGIN_UNIT, LinuxLoginStart, MacosLoginStart, linuxLoginUnit, macosLoginAgentPlist } from "./opencode-login-start-posix"
import { registerOpenCodeLoginStartRoutes } from "../server/routes/opencode-login-start"

const sid = "S-1-5-21-1-2-3-1001"
const native: LoginStartLaunch = { command: "C:\\Program Files\\R&D\\opencode.exe", args: ["serve", "--service"] }

async function scratch(t: TestContext) {
  await mkdir(path.join(os.tmpdir(), "opencode"), { recursive: true })
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode", "login-start-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

/** The CommandLineToArgvW reading the launcher and Task Scheduler apply. */
function argv(line: string): string[] {
  const out: string[] = []
  let i = 0
  for (;;) {
    while (line[i] === " " || line[i] === "\t") i++
    if (i >= line.length) return out
    let word = "", quoted = false
    while (i < line.length && (quoted || (line[i] !== " " && line[i] !== "\t"))) {
      if (line[i] === "\\") {
        let slashes = 0
        while (line[i] === "\\") { slashes++; i++ }
        if (line[i] !== '"') word += "\\".repeat(slashes)
        else { word += "\\".repeat(slashes >> 1); if (slashes & 1) { word += '"'; i++ } }
      } else if (line[i] === '"') { quoted = !quoted; i++ }
      else word += line[i++]
    }
    out.push(word)
  }
}

test("Windows argument quoting round-trips through CommandLineToArgvW", () => {
  for (const value of ["serve", "--service", "C:\\Program Files\\OpenCode\\opencode.exe", 'a "quoted" word', "C:\\trailing space\\", "", "x\\\\\"y"])
    assert.deepEqual(argv(windowsArgument(value)), [value])
})

test("Windows task: one logon trigger for the current account, no password or elevation, a hidden launcher starting serve --service", () => {
  const task = windowsLoginTaskXml({ user: sid, launcher: "C:\\Users\\A\\AppData\\Local\\CodeNomadOpenCodeLogin\\opencode-login-launcher.exe",
    launch: native, workingDirectory: "C:\\Users\\A" })
  assert.equal(task.match(/<LogonTrigger>/g)?.length, 1)
  assert.match(task, /<LogonTrigger><Enabled>true<\/Enabled><UserId>S-1-5-21-1-2-3-1001<\/UserId><\/LogonTrigger>/)
  assert.match(task, /<LogonType>InteractiveToken<\/LogonType><RunLevel>LeastPrivilege<\/RunLevel>/)
  for (const absent of ["Password", "HighestAvailable", "TimeTrigger", "EventTrigger", "Repetition", "RestartOnFailure", "BootTrigger"])
    assert.equal(task.includes(absent), false, absent)
  assert.match(task, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/)
  assert.match(task, /<Description>CodeNomad: start OpenCode at login<\/Description>/)
  assert.match(task, /<Command>C:\\Users\\A\\AppData\\Local\\CodeNomadOpenCodeLogin\\opencode-login-launcher\.exe<\/Command>/)
  const args = task.match(/<Arguments>(.*)<\/Arguments>/)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&")
  assert.deepEqual(argv(args), ["--", native.command, "serve", "--service"])
  assert.match(task, /R&amp;D/)
  const isolated = windowsLoginTaskXml({ user: sid, launcher: "C:\\l.exe", launch: native, workingDirectory: "C:\\h",
    environment: { XDG_CONFIG_HOME: "C:\\iso lated\\config" }, marker: "fixture" })
  assert.deepEqual(argv(isolated.match(/<Arguments>(.*)<\/Arguments>/)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&")),
    ["--env", "XDG_CONFIG_HOME=C:\\iso lated\\config", "--", native.command, "serve", "--service"])
  assert.throws(() => windowsLoginTaskXml({ user: "Everyone", launcher: "C:\\l.exe", launch: native, workingDirectory: "C:\\h" }))
})

test("macOS LaunchAgent: RunAtLoad, crash-only KeepAlive and the exact argv", () => {
  const plist = macosLoginAgentPlist({ command: "/Users/a/bin/open<code>", args: ["serve", "--service"] })
  assert.match(plist, /<key>Label<\/key><string>org\.codenomad\.opencode-login<\/string>/)
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/)
  assert.match(plist, /<key>KeepAlive<\/key><dict><key>Crashed<\/key><true\/><\/dict>/)
  assert.match(plist, /<array><string>\/Users\/a\/bin\/open&lt;code&gt;<\/string><string>serve<\/string><string>--service<\/string><\/array>/)
  for (const absent of ["AbandonProcessGroup", "ThrottleInterval", "ProcessType", "EnvironmentVariables"]) assert.equal(plist.includes(absent), false, absent)
  const withPath = macosLoginAgentPlist({ command: "/opt/opencode", args: [], environment: { PATH: "/opt/home<brew>/bin:/a&b:/usr/bin" } })
  assert.match(withPath, /<key>EnvironmentVariables<\/key><dict><key>PATH<\/key><string>\/opt\/home&lt;brew&gt;\/bin:\/a&amp;b:\/usr\/bin<\/string><\/dict>/)
  assert.deepEqual(withPath.match(/<key>[^<]*<\/key>/g), ["<key>Label</key>", "<key>ProgramArguments</key>", "<key>EnvironmentVariables</key>",
    "<key>PATH</key>", "<key>RunAtLoad</key>", "<key>KeepAlive</key>", "<key>Crashed</key>"], "only the server's PATH")
})

test("systemd user unit: default.target, crash-only restart and quoted ExecStart", () => {
  const unit = linuxLoginUnit({ command: "/home/a/my bin/100%/$opencode", args: ["serve", "--service"] })
  assert.match(unit, /^Description=CodeNomad: start OpenCode at login$/m)
  assert.match(unit, /^ExecStart="\/home\/a\/my bin\/100%%\/\$\$opencode" "serve" "--service"$/m)
  // `opencode service stop` exits 130 (measured on Linux): exit codes are never relaunched.
  assert.match(unit, /^Restart=on-abnormal$/m)
  assert.match(unit, /^RestartPreventExitStatus=SIGKILL$/m)
  assert.match(unit, /^WantedBy=default\.target$/m)
  for (const absent of ["KillMode", "Restart=always", "Restart=on-failure", "linger", "StartLimit"]) assert.equal(unit.includes(absent), false, absent)
  assert.throws(() => linuxLoginUnit({ command: "/bin/x\nExecStartPre=/bin/rm", args: [] }))
  assert.equal(unit.includes("Environment="), false)
  const production = linuxLoginUnit({ command: "/bin/opencode", args: [], environment: { PATH: "/home/a/.local/bin:/usr/bin" } })
  assert.deepEqual(production.match(/^Environment=.*$/gm), ['Environment="PATH=/home/a/.local/bin:/usr/bin"'], "only the server's PATH")
  assert.throws(() => linuxLoginUnit({ command: "/bin/opencode", args: [], environment: { PATH: "/bin\nExecStartPre=/bin/rm" } }))
  const isolated = linuxLoginUnit({ command: "/bin/opencode", args: [] }, { XDG_CONFIG_HOME: '/a b/50%/$HOME/"q"\\' })
  assert.match(isolated, /^Environment="XDG_CONFIG_HOME=\/a b\/50%%\/\$HOME\/\\"q\\"\\\\"\nExecStart=/m)
  assert.throws(() => linuxLoginUnit({ command: "/bin/opencode", args: [] }, { "BAD KEY": "x" }))
  assert.throws(() => linuxLoginUnit({ command: "/bin/opencode", args: [] }, { KEY: "x\nExecStartPre=/bin/rm" }))
})

/** A Task Scheduler stand-in interpreting the adapter's fixed scripts. */
function fakeScheduler(name: string) {
  const tasks = new Map<string, { description: string; xml?: string }>()
  const scripts: string[] = []
  const run = async (script: string) => {
    scripts.push(script)
    if (script.includes("GetCurrent().User.Value")) return sid
    const state = () => { const task = tasks.get(name); return !task ? "absent" : task.description === WINDOWS_LOGIN_MARKER ? "owned" : "foreign" }
    if (script.includes("Register-ScheduledTask") && state() !== "foreign") {
      const xml = script.match(/-Xml '((?:[^']|'')*)'/)![1]!.replace(/''/g, "'")
      tasks.set(name, { description: xml.match(/<Description>(.*)<\/Description>/)![1]!, xml })
    }
    if (script.includes("Unregister-ScheduledTask") && state() === "owned") tasks.delete(name)
    return state()
  }
  return { tasks, scripts, run }
}

test("Windows install and remove are idempotent, own only their task and never touch a foreign one", async t => {
  const root = await scratch(t), source = path.join(root, "launcher.exe"), directory = path.join(root, "local", "CodeNomadOpenCodeLogin")
  await writeFile(source, "launcher-bytes")
  const scheduler = fakeScheduler("CodeNomad-OpenCode-Login")
  const windows = new WindowsLoginStart({ run: scheduler.run, launcherSource: source, launcherDirectory: directory })
  assert.equal(await windows.installed(), false)
  await windows.remove()
  await windows.install(native)
  await windows.install(native)
  assert.equal(await windows.installed(), true)
  assert.equal(scheduler.tasks.size, 1)
  const xml = scheduler.tasks.get("CodeNomad-OpenCode-Login")!.xml!
  // The same path functions as the adapter: host separators for the copied launcher, the account's home directory.
  const pattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  assert.match(xml, new RegExp(`<Command>${pattern(path.join(directory, "opencode-login-launcher.exe"))}</Command>`))
  assert.match(xml, new RegExp(`<WorkingDirectory>${pattern(os.homedir())}</WorkingDirectory>`))
  assert.equal(await readFile(path.join(directory, "opencode-login-launcher.exe"), "utf8"), "launcher-bytes")
  await windows.remove()
  await windows.remove()
  assert.equal(await windows.installed(), false)
  assert.equal(scheduler.tasks.size, 0)
  await assert.rejects(readdir(directory), { code: "ENOENT" })
  assert.equal(scheduler.scripts.some(script => /Stop-ScheduledTask|Stop-Process|taskkill/.test(script)), false)

  scheduler.tasks.set("CodeNomad-OpenCode-Login", { description: "someone else's task" })
  assert.equal(await windows.installed(), false)
  await assert.rejects(windows.install(native))
  await windows.remove()
  assert.equal(scheduler.tasks.get("CodeNomad-OpenCode-Login")!.description, "someone else's task")

  // Only Task Scheduler's ObjectNotFound reads as absent; any other failure is an error, never "off".
  for (const script of scheduler.scripts.filter(script => script.includes("function State")))
    assert.ok(script.includes("-ErrorAction Stop") && script.includes("'ObjectNotFound'") && !script.includes("-ErrorAction SilentlyContinue"))
  const broken = new WindowsLoginStart({ run: async () => { throw new Error("login-start-powershell") }, launcherSource: source, launcherDirectory: directory })
  await assert.rejects(broken.installed())
  await assert.rejects(new OpenCodeLoginStart({ platform: broken, launch: async () => native }).read(), { code: "failed" })
})

test("macOS install and remove are idempotent, keep a foreign plist and never call launchctl", async t => {
  const home = await scratch(t), macos = new MacosLoginStart(home)
  const launch = { command: "/opt/opencode", args: ["serve", "--service"] }
  assert.equal(await macos.installed(), false)
  await macos.remove()
  await macos.install(launch)
  await macos.install(launch)
  assert.equal(await readFile(macos.file, "utf8"), macosLoginAgentPlist(launch))
  assert.equal(await macos.installed(), true)
  await macos.install({ ...launch, command: "/opt/other" })
  assert.match(await readFile(macos.file, "utf8"), /\/opt\/other/)
  await macos.remove()
  await macos.remove()
  assert.equal(await macos.installed(), false)
  assert.deepEqual(await readdir(path.dirname(macos.file)), [])
  await writeFile(macos.file, "<plist><dict><key>Label</key><string>com.example</string></dict></plist>")
  await assert.rejects(macos.install(launch))
  await macos.remove()
  assert.match(await readFile(macos.file, "utf8"), /com\.example/)
})

test("Linux install enables without starting; remove disables without stopping, even without a user manager", async t => {
  const directory = path.join(await scratch(t), "systemd", "user"), calls: string[][] = []
  const wanted = path.join(directory, "default.target.wants", LINUX_LOGIN_UNIT)
  let manager = true
  const command = async (args: string[]) => {
    calls.push(args)
    if (!manager) throw new Error("no user bus")
    if (args[0] === "enable") {
      await mkdir(path.dirname(wanted), { recursive: true })
      await symlink(path.join(directory, LINUX_LOGIN_UNIT), wanted).catch(error => { if (error.code !== "EEXIST") throw error })
    }
    if (args[0] === "disable") await unlink(wanted).catch(() => {})
    return ""
  }
  const linux = new LinuxLoginStart({ unitDirectory: directory, command }), launch = { command: "/usr/bin/opencode", args: ["serve", "--service"] }
  try { await mkdir(directory, { recursive: true }); await symlink(directory, path.join(directory, "probe")); await unlink(path.join(directory, "probe")) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symbolic links unavailable"); throw error }
  assert.equal(await linux.installed(), false)
  await linux.remove()
  await linux.install(launch)
  await linux.install(launch)
  assert.equal(await linux.installed(), true)
  assert.equal(await readFile(linux.file, "utf8"), linuxLoginUnit(launch))
  assert.deepEqual(calls, [["daemon-reload"], ["enable", LINUX_LOGIN_UNIT], ["daemon-reload"], ["enable", LINUX_LOGIN_UNIT]])
  calls.length = 0
  await linux.remove()
  await linux.remove()
  assert.deepEqual(calls, [["disable", LINUX_LOGIN_UNIT], ["daemon-reload"]])
  assert.equal(await linux.installed(), false)
  assert.equal(calls.some(args => ["start", "stop", "restart", "kill"].includes(args[0]!) || args.includes("--now")), false)

  await linux.install(launch)
  manager = false
  await linux.remove()
  assert.equal(await linux.installed(), false)
  await assert.rejects(readFile(linux.file), { code: "ENOENT" })
  await assert.rejects(linux.install(launch))
  manager = true
  await writeFile(linux.file, "[Unit]\nDescription=Personal OpenCode\n")
  await assert.rejects(linux.install(launch))
  await linux.remove()
  assert.match(await readFile(linux.file, "utf8"), /Personal/)
})

function fakePlatform() {
  let installed: LoginStartLaunch | undefined, fail = false
  const calls: string[] = []
  const platform: LoginStartPlatform = {
    installed: async () => Boolean(installed),
    install: async launch => { calls.push(`install ${launch.command}`); if (fail) throw new Error("os refused"); installed = launch },
    remove: async () => { calls.push("remove"); if (fail) throw new Error("os refused"); installed = undefined },
  }
  return { platform, calls, current: () => installed, fail: (value: boolean) => { fail = value } }
}

test("the preference is off by default, follows explicit changes and reports fixed causes", async () => {
  const fake = fakePlatform()
  let selected = "C:\\a\\opencode.exe", unsupported = false
  const loginStart = new OpenCodeLoginStart({ platform: fake.platform,
    launch: async () => { if (unsupported) throw new LoginStartError("unsupported-binary"); return { command: selected, args: ["serve", "--service"] } } })
  assert.deepEqual(await loginStart.read(), { state: "off" })
  assert.deepEqual(fake.calls, [], "reading never installs")
  assert.deepEqual(await loginStart.set(true), { state: "on" })
  assert.deepEqual(await loginStart.set(true), { state: "on" })
  selected = "C:\\b\\opencode.exe"
  await loginStart.refresh()
  assert.equal(fake.current()?.command, "C:\\b\\opencode.exe")
  assert.deepEqual(await loginStart.set(false), { state: "off" })
  await loginStart.refresh()
  assert.deepEqual(fake.calls, ["install C:\\a\\opencode.exe", "install C:\\a\\opencode.exe", "install C:\\b\\opencode.exe", "remove"])
  unsupported = true
  await assert.rejects(loginStart.set(true), { code: "unsupported-binary" })
  unsupported = false
  fake.fail(true)
  await assert.rejects(loginStart.set(true), { code: "failed" })
  await assert.rejects(loginStart.set(false), { code: "failed" })
  assert.deepEqual(await loginStart.read(), { state: "off" })
  const none = new OpenCodeLoginStart({ launch: async () => native })
  assert.deepEqual(await none.read(), { state: "unavailable" })
  await assert.rejects(none.set(true), { code: "unavailable" })
})

test("changes run one at a time", async () => {
  const fake = fakePlatform(), order: string[] = []
  let release = () => {}
  const slow: LoginStartPlatform = { ...fake.platform, install: async launch => {
    order.push("install-start"); await new Promise<void>(resolve => { release = resolve }); await fake.platform.install(launch); order.push("install-end") },
  remove: async () => { order.push("remove"); await fake.platform.remove() } }
  const loginStart = new OpenCodeLoginStart({ platform: slow, launch: async () => native })
  const on = loginStart.set(true), off = loginStart.set(false)
  await new Promise(resolve => setImmediate(resolve))
  release()
  assert.deepEqual([await on, await off], [{ state: "on" }, { state: "off" }])
  assert.deepEqual(order, ["install-start", "install-end", "remove"])
})

test("Windows launch resolution keeps the native image or wsl.exe, never a command wrapper", { skip: process.platform !== "win32" }, async t => {
  const root = await scratch(t), exe = path.join(root, "with space", "opencode.exe"), cmd = path.join(root, "wrapper.cmd")
  await mkdir(path.dirname(exe), { recursive: true })
  await writeFile(exe, "")
  await writeFile(cmd, "@echo off\r\n")
  assert.deepEqual(await resolveLoginStartLaunch(exe), { command: exe, args: ["serve", "--service"] })
  assert.deepEqual(await resolveLoginStartLaunch("\\\\wsl.localhost\\Ubuntu\\home\\me\\.opencode\\bin\\opencode"), {
    command: path.win32.join(process.env.SystemRoot!, "System32", "wsl.exe"),
    args: ["--distribution", "Ubuntu", "--exec", "/home/me/.opencode/bin/opencode", "serve", "--service"] })
  for (const selected of [cmd, path.join(root, "missing.exe"), "codenomad-missing-opencode",
    "\\\\wsl.localhost\\Ubuntu", "\\\\wsl.localhost\\Ubuntu\\", "\\\\wsl$\\Ubuntu\\\\"])
    await assert.rejects(resolveLoginStartLaunch(selected), { code: "unsupported-binary" }, selected)
})

test("only the server's PATH is kept for launchd and systemd", () => {
  assert.deepEqual(loginStartEnvironment({ PATH: "/opt/bin:/usr/bin", HOME: "/home/me", SECRET: "x", OPENCODE_CONFIG_CONTENT: "{}" }), { PATH: "/opt/bin:/usr/bin" })
  assert.equal(loginStartEnvironment({ HOME: "/home/me" }), undefined)
  assert.equal(loginStartEnvironment({ PATH: "" }), undefined)
  assert.throws(() => macosLoginAgentPlist({ command: "/opt/opencode", args: [], environment: { PATH: "/bin\u0001" } }), /login-start-agent/)
  assert.throws(() => macosLoginAgentPlist({ command: "/opt/open\rcode", args: [] }), /login-start-agent/)
})

test("POSIX launches carry the server's PATH only", { skip: process.platform === "win32" }, async () => {
  assert.deepEqual(await resolveLoginStartLaunch(process.execPath, "linux", { PATH: "/opt/bin:/usr/bin", HOME: "/home/me", SECRET: "x" }),
    { command: process.execPath, args: ["serve", "--service"], environment: { PATH: "/opt/bin:/usr/bin" } })
  assert.equal((await resolveLoginStartLaunch(process.execPath, "darwin", {})).environment, undefined)
})

test("refresh rewrites the current server PATH into an installed artifact", async () => {
  const fake = fakePlatform()
  let PATH = "/usr/bin"
  const loginStart = new OpenCodeLoginStart({ platform: fake.platform,
    launch: async () => ({ command: "/opt/opencode", args: ["serve", "--service"], environment: { PATH } }) })
  await loginStart.set(true)
  PATH = "/home/me/.local/bin:/usr/bin"
  await loginStart.refresh()
  assert.deepEqual(fake.current()?.environment, { PATH: "/home/me/.local/bin:/usr/bin" })
})

test("the artifact keeps a linked executable's selected path, not its versioned target", async t => {
  const root = await scratch(t), target = path.join(root, "Cellar", "2.2.5", process.platform === "win32" ? "opencode.exe" : "opencode")
  const link = path.join(root, "bin", path.basename(target))
  await mkdir(path.dirname(target), { recursive: true })
  await mkdir(path.dirname(link), { recursive: true })
  await writeFile(target, "", { mode: 0o755 })
  try { await symlink(target, link) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symbolic links unavailable")
    throw error
  }
  assert.equal((await resolveLoginStartLaunch(link)).command, link)
  await rm(target)
  await assert.rejects(resolveLoginStartLaunch(link), { code: "unsupported-binary" }, "a dangling link is refused")
})

test("POSIX launch resolution requires an absolute executable", async () => {
  await assert.rejects(resolveLoginStartLaunch("opencode", "linux"), { code: "unsupported-binary" })
  await assert.rejects(resolveLoginStartLaunch("/definitely/missing/opencode", "darwin"), { code: "unsupported-binary" })
})

test("the route reads freely and changes only for a live human, with fixed error codes", async t => {
  const app = Fastify({ logger: false })
  t.after(() => app.close())
  let human = true, failure: LoginStartError | undefined
  const changes: boolean[] = []
  registerOpenCodeLoginStartRoutes(app, {
    auth: { isAuthEnabled: () => true, getSessionFromRequest: () => human ? { username: "human", sessionId: "cookie" } : null } as never,
    loginStart: { read: async () => ({ state: "off" }), set: async enabled => {
      if (failure) throw failure
      changes.push(enabled); return { state: enabled ? "on" : "off" } } },
  })
  const post = (payload: unknown) => app.inject({ method: "POST", url: "/api/opencode/login-start", payload: payload as object })
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/opencode/login-start" })).json(), { state: "off" })
  assert.deepEqual((await post({ enabled: true })).json(), { state: "on" })
  assert.equal((await post({ enabled: "yes" })).statusCode, 400)
  assert.equal((await post({ enabled: true, command: "calc.exe" })).statusCode, 400)
  human = false
  assert.equal((await post({ enabled: false })).statusCode, 401)
  human = true
  for (const [code, status] of [["unsupported-binary", 422], ["failed", 500], ["unavailable", 503]] as const) {
    failure = new LoginStartError(code)
    const response = await post({ enabled: true })
    assert.deepEqual([response.statusCode, response.json()], [status, { error: `login-start-${code}` }])
  }
  assert.deepEqual(changes, [true])
})
