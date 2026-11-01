import assert from "node:assert/strict"
import { test } from "node:test"
import { macosLoadedAgent, macosRuntimeSchema, macosSupervisionPlist, type MacosSupervisionRuntime } from "./service-supervision-macos"
import { lookupMacosProcess } from "./service-supervision-macos-native"

const runtime: MacosSupervisionRuntime = { node: "/Users/u/Code Nomad/node", guard: "/Users/u/runtime/guard.cjs",
  nativeHelper: "/Users/u/runtime/native", agentDirectory: "/Users/u/Library/LaunchAgents",
  environment: { HOME: "/Users/u", XDG_CONFIG_HOME: "/config", XDG_STATE_HOME: "/state", XDG_DATA_HOME: "/data", XDG_CACHE_HOME: "/cache" } }
const key = "a".repeat(64), file = `${runtime.agentDirectory}/org.codenomad.opencode.${key}.plist`
const argv = [runtime.node, runtime.guard, "/Users/u/private", key]
const loaded = `gui/501/org.codenomad.opencode.${key} = {
\tpath = ${file}
\ttype = LaunchAgent
\tstate = running
\tprogram = ${runtime.node}
\targuments = {
${argv.map(arg => `\t\t${arg}\n`).join("")}\t}
\tminimum runtime = 5
\tpid = 42
\tproperties = keepalive | runatload | abandon process group | inferred program
}`

test("LaunchAgent hosts a foreground guard and explicitly abandons its service group at OFF/crash", () => {
  const plist = macosSupervisionPlist(key, '/Users/u/A&B/"<data>"', runtime)
  for (const value of ["<key>RunAtLoad</key><true/>", "<key>KeepAlive</key><true/>",
    "<key>ThrottleInterval</key><integer>5</integer>", "<key>AbandonProcessGroup</key><true/>",
    "<key>StandardInPath</key><string>/dev/null</string>", "A&amp;B/&quot;&lt;data&gt;&quot;", runtime.node]) assert.ok(plist.includes(value))
  assert.doesNotMatch(plist, /password|token|OPENCODE_CONFIG_CONTENT|service start|service stop|StartCalendarInterval/i)
  assert.throws(() => macosSupervisionPlist("bad", "/private", runtime))
  assert.equal(macosRuntimeSchema.safeParse({ ...runtime, nativeHelper: "/bad\nhelper" }).success, false)
  assert.equal(macosRuntimeSchema.safeParse({ ...runtime, environment: { ...runtime.environment, TOKEN: "secret" } }).success, false)
})
test("loaded ownership requires complete fixed argv and the release/restart policy", () => {
  assert.deepEqual(macosLoadedAgent(loaded, file, argv), { state: "running", pid: 42 })
  for (const text of [loaded.replace(file, "/foreign.plist"), loaded.replace("abandon process group | ", ""),
    loaded.replace("keepalive | ", ""), loaded.replace("runatload | ", ""), loaded.replace("\tminimum runtime = 5", "\tminimum runtime = 1"),
    loaded.replace(`\t\t${key}`, "\t\tforeign"), loaded.replace("pid = 42", "pid = unknown")]) assert.throws(() => macosLoadedAgent(text, file, argv))
  assert.throws(() => macosLoadedAgent(loaded, file, [...argv, "extra"]))
})
test("a loaded agent waiting for launchd throttle is installed but has no active guard", () => {
  assert.deepEqual(macosLoadedAgent(loaded.replace("\tpid = 42\n", "").replace("state = running", "state = spawn scheduled"), file, argv),
    { state: "spawn scheduled" })
})
test("invalid PID and missing native identity helper stay unknown", async () => {
  assert.deepEqual(await lookupMacosProcess(-1, "/missing"), { state: "unknown" })
  assert.deepEqual(await lookupMacosProcess(42, "/missing/native/helper"), { state: "unknown" })
})
