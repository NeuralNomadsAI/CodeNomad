import assert from "node:assert/strict"
import { spawn as spawnChild, spawnSync, type SpawnSyncReturns } from "node:child_process"
import { once } from "node:events"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import {
  probePosixProcesses, probeWindowsProcesses, probeWslProcesses, sameProcess,
  signalOwnedPosixProcessGroup, signalPosixProcesses, signalWindowsProcesses,
  startedNoLaterThan, type ProcessIdentity,
} from "./process-identity"

type Spawn = typeof import("node:child_process").spawnSync
type Call = { command: string; args: readonly string[]; script: string }
const output = (stdout = "", status = 0, stderr = ""): SpawnSyncReturns<string> =>
  ({ pid: 1, output: [null, stdout, stderr], stdout, stderr, status, signal: null })
const spawn = (stdout: string, call?: Call, status = 0, stderr = "") => ((command: string, args: readonly string[]) => {
  if (call) Object.assign(call, { command, args, script: command === "powershell.exe" ? args.at(-1) ?? "" : args[args.indexOf("-c") + 1] ?? "" })
  return output(stdout, status, stderr)
}) as unknown as Spawn
const b64 = (value: string) => Buffer.from(value).toString("base64")
const identity = (startTime = "123456"): ProcessIdentity =>
  ({ pid: 42, parentPid: 1, groupId: 42, startTime, bootId: "boot-a", startOrder: startTime })

describe("process identity probes", () => {
  it("parses immutable Linux identities", () => {
    const call = {} as Call
    const probe = probePosixProcesses(spawn("42|1|42|123456|boot-a|123456\n", call), 25, "linux")
    assert.deepEqual([call.command, call.args.includes("codenomad-posix-identity"), call.script.trimEnd().endsWith("exit 0")], ["sh", true, true])
    assert.deepEqual(probe.ok && probe.processes.get(42), identity())
  })

  it("queries the requested Linux launch group without per-process subprocesses", () => {
    const call = {} as Call
    const probe = probePosixProcesses(spawn("42|1|42|123456|boot-a|123456\n", call), 25, "linux", { pids: [42], groupId: 42 })
    assert.deepEqual(call.args.slice(-1), ["42"])
    assert.match(call.script, /expected_group=\$stat_group/)
    assert.doesNotMatch(call.script, /\b(?:cat|cut|sed|basename|dirname)\b/)
    assert.deepEqual(probe.ok && probe.processes.get(42), identity())
  })

  it("captures real Linux start ticks and launch-group members within the deadline", { skip: process.platform !== "linux" }, async () => {
    const child = spawnChild("sh", ["-c", "sleep 5"], { stdio: "ignore" })
    await once(child, "spawn")
    try {
      const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8")
      const expectedStart = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19]
      const probe = probePosixProcesses(spawnSync, 1_000, "linux", { pids: [process.pid], groupId: process.pid })
      assert.equal(probe.ok && probe.processes.get(process.pid)?.startTime, expectedStart)
      assert.equal(probe.ok && probe.processes.has(child.pid!), true)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit")
        child.kill()
        await exited
      }
    }
  })

  it("uses one delimiter-safe process-table query on portable POSIX", () => {
    const call = {} as Call
    const command = "/opt/opencode 'pipe|value'\t\"quoted\" café"
    const start = "Fri Jul 10 12:34:56 2026"
    const probe = probePosixProcesses(spawn(`42 1 42 ${start} ${command}\n`, call), 25, "darwin")
    assert.deepEqual([call.command, call.args], ["ps", ["-axo", "pid=,ppid=,pgid=,lstart=,comm="]])
    assert.equal(probe.ok && probe.processes.get(42)?.startTime, `${start}\t${command}`)
  })

  it("ignores malformed unrelated portable rows but fails for a malformed requested identity", () => {
    const start = "Fri Jul 10 12:34:56 2026"
    const unrelated = `77 1 77 malformed identity\n42 1 42 ${start} opencode\n`
    const filtered = probePosixProcesses(spawn(unrelated), 25, "darwin", { pids: [42], groupId: 42 })
    assert.equal(filtered.ok && filtered.processes.get(42)?.startTime, `${start}\topencode`)
    assert.equal(probePosixProcesses(spawn(unrelated), 25, "darwin", { pids: [77] }).ok, false)
  })

  it("preserves delimiter-heavy identities through POSIX escalation and rescan", () => {
    const command = "/opt/opencode pipe|value\nnext\t'quoted'"
    const row = `CODENOMAD_TARGET_B64|42|1|42|${b64("Fri Jul 10 12:34:56 2026")}|${b64(command)}\nCODENOMAD_RESULT|1||1\n`
    const expected = `Fri Jul 10 12:34:56 2026\t${command}`
    const guardedCall = {} as Call
    const guarded = signalPosixProcesses(spawn(row, guardedCall), { leader: identity(expected), groupId: 42, members: [identity(expected)], signal: "SIGKILL" }, 25, "darwin")
    const call = {} as Call
    const owned = signalOwnedPosixProcessGroup(spawn(row, call), 42, "SIGTERM", 25)
    assert.deepEqual([guarded.ok, guarded.ok && guarded.signaled[0]?.startTime], [true, expected])
    assert.deepEqual([owned.ok && owned.matched, owned.ok && owned.signaled[0]?.startTime], [true, expected])
    assert.ok(call.script.indexOf('kill "-$requested_signal"') < call.script.lastIndexOf("for current_pid"))
    assert.match(call.script, /group_pids\(\).*pid=,pgid=/)
    assert.doesNotMatch(call.script, /ps -eo pid=/)
    assert.match(guardedCall.script, /test "\$current_group" = "\$expected_group"/)
  })

  it("marks a retained portable group request for leaderless guarded cleanup", () => {
    const call = {} as Call
    const guarded = signalPosixProcesses(spawn("CODENOMAD_RESULT|1||1\n", call), {
      leader: identity("gone"), groupId: 42, members: [identity("member")], signal: "SIGTERM",
      allowLeaderlessGroup: true, cleanupToken: "secret-token",
    }, 25, "darwin")
    assert.equal(guarded.ok, true)
    assert.equal(call.args[7], "1")
    assert.equal(call.args[8], "secret-token")
    assert.match(call.script, /anchor=0/)
    assert.match(call.script, /has_cleanup_token/)
  })

  it("queries WSL identities in the selected distro", () => {
    const call = {} as Call
    const probe = probeWslProcesses(spawn("99|1|99|123456|boot-a|123456\n101|99|99|123460|boot-a|123460\n", call), "Ubuntu Test", 25)
    assert.deepEqual([call.command, call.args.slice(0, 4), call.args.includes("codenomad-wsl-identity"), call.script.trimEnd().endsWith("exit 0")],
      ["wsl.exe", ["--distribution", "Ubuntu Test", "--exec", "sh"], true, true])
    assert.equal(probe.ok && probe.processes.get(101)?.startTime, "123460")
  })

  it("uses Windows CIM CreationDate as the immutable identity", () => {
    const call = {} as Call
    const probe = probeWindowsProcesses(spawn("4242|100|0|20260710123456.123456+000||20260710123456\n", call), 25)
    assert.match(call.script, /Get-CimInstance Win32_Process/)
    assert.match(call.script, /ProcessId -gt 0/)
    assert.equal(probe.ok && probe.processes.get(4242)?.startTime, "20260710123456.123456+000")
  })

  it("rejects PID reuse and invalid start ordering", () => {
    const original = identity("9")
    for (const [candidate, expected] of [[{ ...original }, true], [{ ...original, startTime: "10" }, false], [{ ...original, pid: 43 }, false]] as const)
      assert.equal(sameProcess(original, candidate), expected)
    assert.equal(startedNoLaterThan(original, "10"), true)
    assert.equal(startedNoLaterThan({ ...original, startOrder: "11" }, "10"), false)
    assert.equal(startedNoLaterThan({ ...original, startOrder: "Fri Jul 10" }, "10"), false)
  })

  it("returns a POSIX mismatch without a second signal command", () => {
    const call = {} as Call
    const guarded = signalPosixProcesses(spawn("CODENOMAD_RESULT|0||0\n", call), { leader: identity(), groupId: 42, members: [identity()], signal: "SIGTERM" }, 25, "linux")
    assert.deepEqual(guarded, { ok: true, matched: false, signalSent: false, signaled: [] })
    assert.deepEqual([call.command, call.args[2], call.args.includes("123456")], ["sh", "codenomad-guarded-signal", true])
    assert.ok(call.script.indexOf('kill "-$requested_signal"') < call.script.indexOf("uptime=$(cut"))
  })

  it("selects and terminates Windows identities in one guarded CIM invocation", () => {
    const call = {} as Call
    const guarded = signalWindowsProcesses(spawn("CODENOMAD_TARGET|4242|1|0|created||99\nCODENOMAD_RESULT|1||1\n", call), { leader: identity("created"), groupId: 42, members: [identity("created")], signal: "SIGKILL" }, 25)
    assert.equal(guarded.ok && guarded.matched, true)
    assert.equal(call.command, "powershell.exe")
    assert.match(call.script, /CreationDate.*Invoke-CimMethod -InputObject/s)
    assert.equal(call.script.match(/foreach \(\$process in \$selected\)/g)?.length, 2)
    assert.ok(call.script.indexOf("CODENOMAD_TARGET|") < call.script.indexOf("Invoke-CimMethod"))
    assert.doesNotMatch(call.script, /taskkill/i)
  })

  it("retains observed Windows identities after partial termination failure", () => {
    const rows = "CODENOMAD_TARGET|4242|1|0|created||99\nCODENOMAD_TARGET|4243|4242|0|descendant||100"
    const guarded = signalWindowsProcesses(spawn(rows, undefined, 1, "termination failed"), { leader: identity("created"), groupId: 42, members: [identity("created")], signal: "SIGTERM" }, 25)
    assert.equal(guarded.ok, false)
    assert.deepEqual(!guarded.ok && guarded.observed?.map(({ pid }) => pid), [4242, 4243])
  })

  it("fails conservatively for command, malformed, and empty probe output", () => {
    assert.deepEqual(probeWindowsProcesses(spawn("", undefined, 1, "CIM unavailable"), 25), { ok: false, error: "CIM unavailable" })
    assert.deepEqual(probePosixProcesses(spawn("", undefined, 20, "proc unavailable"), 25, "linux"), { ok: false, error: "proc unavailable" })
    for (const probe of [probePosixProcesses(spawn("42 malformed process row\n"), 25, "darwin"), probeWslProcesses(spawn("not an identity"), "Ubuntu", 25)]) assert.equal(probe.ok, false)
  })
})
