import assert from "node:assert/strict"
import type { SpawnSyncReturns } from "node:child_process"
import { describe, it } from "node:test"

import {
  probePosixProcesses,
  probeWindowsProcesses,
  probeWslProcesses,
  sameProcess,
  signalOwnedPosixProcessGroup,
  signalPosixProcesses,
  signalWindowsProcesses,
  startedNoLaterThan,
  type ProcessIdentity,
} from "./process-identity"

type SpawnCommand = typeof import("node:child_process").spawnSync

function result(stdout = "", status = 0, stderr = ""): SpawnSyncReturns<string> {
  return { pid: 1, output: [null, stdout, stderr], stdout, stderr, status, signal: null }
}

function b64(value: string): string {
  return Buffer.from(value).toString("base64")
}

describe("process identity probes", () => {
  it("parses Linux PID, PGID, and kernel process start ticks", () => {
    let invocation: { command: string; args: readonly string[] } | undefined
    const probe = probePosixProcesses(((command: string, args: readonly string[]) => {
      invocation = { command, args }
      return result("42|1|42|123456|boot-a|123456\n")
    }) as unknown as SpawnCommand, 25, "linux")

    assert.equal(invocation?.command, "sh")
    assert.ok(invocation?.args.includes("codenomad-posix-identity"))
    assert.equal(probe.ok, true)
    if (probe.ok) {
      assert.deepEqual(probe.processes.get(42), {
        pid: 42,
        parentPid: 1,
        groupId: 42,
        startTime: "123456",
        bootId: "boot-a",
        startOrder: "123456",
      })
    }
  })

  it("uses process start time from ps on non-Linux POSIX platforms", () => {
    let invocation: { command: string; args: readonly string[] } | undefined
    const probe = probePosixProcesses(((command: string, args: readonly string[]) => {
      invocation = { command, args }
      return result(`CODENOMAD_B64|42|1|42|${b64("Fri Jul 10 12:34:56 2026")}|${b64("/usr/bin/opencode serve")}\n`)
    }) as unknown as SpawnCommand, 25, "darwin")

    assert.equal(invocation?.command, "sh")
    assert.ok(invocation?.args.includes("codenomad-posix-identity"))
    assert.equal(probe.ok && probe.processes.get(42)?.startTime, "Fri Jul 10 12:34:56 2026\t/usr/bin/opencode serve")
  })

  it("round trips delimiter-heavy non-Linux POSIX command identities", () => {
    const command = "/opt/opencode 'pipe|value'\nnext\t\"quoted\" café"
    const start = "Fri Jul 10 12:34:56 2026"
    const probe = probePosixProcesses((() => result(
      `CODENOMAD_B64|42|1|42|${b64(start)}|${b64(command)}\n`,
    )) as unknown as SpawnCommand, 25, "darwin")

    assert.equal(probe.ok && probe.processes.get(42)?.startTime, `${start}\t${command}`)
  })

  it("uses delimiter-safe identities during non-Linux POSIX escalation", () => {
    const command = "/opt/opencode pipe|value\nnext\t'quoted'"
    const startTime = `Fri Jul 10 12:34:56 2026\t${command}`
    const identity: ProcessIdentity = { pid: 42, parentPid: 1, groupId: 42, startTime }
    const guarded = signalPosixProcesses((() => result(
      `CODENOMAD_TARGET_B64|42|1|42|${b64("Fri Jul 10 12:34:56 2026")}|${b64(command)}\nCODENOMAD_RESULT|1||1\n`,
    )) as unknown as SpawnCommand, { leader: identity, groupId: 42, members: [identity], signal: "SIGKILL" }, 25, "darwin")

    assert.equal(guarded.ok, true)
    assert.equal(guarded.ok && guarded.signaled[0]?.startTime, startTime)
  })

  it("signals and rescans a still-owned portable POSIX process group", () => {
    const command = "/opt/opencode pipe|value\nchild"
    let script = ""
    const cleanup = signalOwnedPosixProcessGroup(((_command: string, args: readonly string[]) => {
      script = args[1] ?? ""
      return result(
        `CODENOMAD_TARGET_B64|42|1|42|${b64("Fri Jul 10 12:34:56 2026")}|${b64(command)}\n` +
        "CODENOMAD_RESULT|1||1\n",
      )
    }) as unknown as SpawnCommand, 42, "SIGTERM", 25)

    assert.equal(cleanup.ok && cleanup.matched, true)
    assert.equal(cleanup.ok && cleanup.signaled[0]?.startTime, `Fri Jul 10 12:34:56 2026\t${command}`)
    assert.ok(script.indexOf('kill "-$requested_signal"') < script.lastIndexOf("for current_pid"))
  })

  it("rejects malformed base64 records instead of truncating an identity", () => {
    const probe = probePosixProcesses((() => result(
      `CODENOMAD_B64|42|1|42|${b64("Fri Jul 10 12:34:56 2026")}|not|base64\n`,
    )) as unknown as SpawnCommand, 25, "darwin")

    assert.deepEqual(probe, { ok: false, error: "process identity query returned no parseable processes" })
  })

  it("queries WSL identities inside the selected distro", () => {
    let invocation: { command: string; args: readonly string[] } | undefined
    const probe = probeWslProcesses(((command: string, args: readonly string[]) => {
      invocation = { command, args }
      return result("99|1|99|123456|boot-a|123456\n101|99|99|123460|boot-a|123460\n")
    }) as unknown as SpawnCommand, "Ubuntu Test", 25)

    assert.equal(invocation?.command, "wsl.exe")
    assert.deepEqual(invocation?.args.slice(0, 4), ["--distribution", "Ubuntu Test", "--exec", "sh"])
    assert.ok(invocation?.args.includes("codenomad-wsl-identity"))
    assert.equal(probe.ok && probe.processes.get(101)?.startTime, "123460")
  })

  it("parses Windows CIM CreationDate as the immutable identity", () => {
    let script = ""
    const probe = probeWindowsProcesses(((_command: string, args: readonly string[]) => {
      script = args.at(-1) ?? ""
      return result("4242|100|0|20260710123456.123456+000||20260710123456\n")
    }) as unknown as SpawnCommand, 25)

    assert.match(script, /Get-CimInstance Win32_Process/)
    assert.equal(probe.ok && probe.processes.get(4242)?.startTime, "20260710123456.123456+000")
  })

  it("matches only the same numeric PID and start identity", () => {
    const original: ProcessIdentity = { pid: 42, parentPid: 1, groupId: 42, startTime: "start-a" }
    assert.equal(sameProcess(original, { ...original }), true)
    assert.equal(sameProcess(original, { ...original, startTime: "start-b" }), false)
    assert.equal(sameProcess(original, { ...original, pid: 43 }), false)
  })

  it("compares Linux start ticks numerically and rejects non-numeric fallbacks", () => {
    const identity: ProcessIdentity = { pid: 42, parentPid: 1, groupId: 42, startTime: "9", startOrder: "9" }
    assert.equal(startedNoLaterThan(identity, "10"), true)
    assert.equal(startedNoLaterThan({ ...identity, startOrder: "11" }, "10"), false)
    assert.equal(startedNoLaterThan({ ...identity, startOrder: "Fri Jul 10" }, "10"), false)
  })

  it("returns mismatch without scheduling a second POSIX signal command", () => {
    const invocations: Array<{ command: string; args: readonly string[] }> = []
    const identity: ProcessIdentity = {
      pid: 42,
      parentPid: 1,
      groupId: 42,
      startTime: "123456",
      bootId: "boot-a",
      startOrder: "123456",
    }
    const guarded = signalPosixProcesses(((command: string, args: readonly string[]) => {
      invocations.push({ command, args })
      return result("CODENOMAD_RESULT|0||0\n")
    }) as unknown as SpawnCommand, { leader: identity, groupId: 42, members: [identity], signal: "SIGTERM" }, 25, "linux")

    assert.deepEqual(guarded, { ok: true, matched: false, signalSent: false, signaled: [] })
    assert.equal(invocations.length, 1)
    assert.equal(invocations[0]?.command, "sh")
    assert.match(invocations[0]?.args[2] ?? "", /codenomad-guarded-signal/)
    assert.ok(invocations[0]?.args.includes("123456"))
    const script = invocations[0]?.args[1] ?? ""
    assert.ok(script.indexOf('kill "-$requested_signal"') < script.indexOf("uptime=$(cut"))
  })

  it("uses one guarded Windows CIM selection and termination invocation", () => {
    const invocations: Array<{ command: string; args: readonly string[] }> = []
    const identity: ProcessIdentity = { pid: 4242, parentPid: 1, groupId: 4242, startTime: "created" }
    const guarded = signalWindowsProcesses(((command: string, args: readonly string[]) => {
      invocations.push({ command, args })
      return result("CODENOMAD_TARGET|4242|1|0|created||99\nCODENOMAD_RESULT|1||1\n")
    }) as unknown as SpawnCommand, { leader: identity, groupId: 4242, members: [identity], signal: "SIGKILL" }, 25)

    assert.equal(guarded.ok && guarded.matched, true)
    assert.equal(invocations.length, 1)
    assert.equal(invocations[0]?.command, "powershell.exe")
    const script = invocations[0]?.args.at(-1) ?? ""
    assert.match(script, /CreationDate/)
    assert.match(script, /Invoke-CimMethod -InputObject/)
    assert.equal(script.match(/foreach \(\$process in \$selected\)/g)?.length, 2)
    assert.ok(script.indexOf("CODENOMAD_TARGET|") < script.indexOf("Invoke-CimMethod"))
    assert.doesNotMatch(script, /taskkill/i)
  })

  it("preserves observed Windows targets when guarded termination fails partway", () => {
    const identity: ProcessIdentity = { pid: 4242, parentPid: 1, groupId: 4242, startTime: "created" }
    const guarded = signalWindowsProcesses((() => result(
      [
        "CODENOMAD_TARGET|4242|1|0|created||99",
        "CODENOMAD_TARGET|4243|4242|0|descendant||100",
      ].join("\n"),
      1,
      "termination failed",
    )) as unknown as SpawnCommand, {
      leader: identity,
      groupId: 4242,
      members: [identity],
      signal: "SIGTERM",
    }, 25)

    assert.equal(guarded.ok, false)
    assert.deepEqual(!guarded.ok && guarded.observed?.map((target) => target.pid), [4242, 4243])
  })

  it("reports command failures without fabricating identities", () => {
    const probe = probeWindowsProcesses((() => result("", 1, "CIM unavailable")) as unknown as SpawnCommand, 25)
    assert.deepEqual(probe, { ok: false, error: "CIM unavailable" })
  })

  it("rejects successful commands with unparseable or empty output", () => {
    const probe = probeWslProcesses((() => result("not an identity")) as unknown as SpawnCommand, "Ubuntu", 25)
    assert.deepEqual(probe, { ok: false, error: "process identity query returned no parseable processes" })
  })
})
