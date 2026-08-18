import assert from "node:assert/strict"
import { test } from "node:test"

import { probeProcessStartIdentity } from "./process-identity"

test("probes a service PID inside its WSL distro instead of the coincidental Windows PID", async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const probe = await probeProcessStartIdentity(4242, 100, { kind: "wsl", distro: "Ubuntu" }, async (command, args) => {
    calls.push({ command, args })
    return {
      code: 0,
      stdout: "4242 (opencode) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 98765 20\nlinux-boot-id\n",
    }
  })

  assert.equal(calls[0]?.command, "wsl.exe")
  assert.deepEqual(calls[0]?.args.slice(0, 2), ["--distribution", "Ubuntu"])
  assert.deepEqual(probe, {
    status: "found",
    identity: { namespace: { kind: "wsl", distro: "Ubuntu" }, pid: 4242, start: "linux-boot-id:98765" },
  })
})

test("distinguishes a missing WSL PID from an unverified probe", async () => {
  const missing = await probeProcessStartIdentity(7, 100, { kind: "wsl", distro: "Ubuntu" }, async () => ({
    code: 3,
    stdout: "",
  }))
  const unknown = await probeProcessStartIdentity(7, 100, { kind: "wsl", distro: "Ubuntu" }, async () => ({
    code: null,
    stdout: "",
  }))

  assert.deepEqual(missing, { status: "missing" })
  assert.deepEqual(unknown, { status: "unknown" })
})
