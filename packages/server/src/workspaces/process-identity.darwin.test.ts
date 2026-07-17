import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import { it } from "node:test"

import {
  LAUNCH_CLEANUP_TOKEN_ENV,
  probePosixProcesses,
  signalOwnedPosixProcessGroup,
  signalPosixProcesses,
} from "./process-identity"

const darwinOnly = { skip: process.platform !== "darwin", timeout: 10_000 }

async function spawnDetachedGroup(cleanupToken?: string) {
  const leader = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process")
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    process.stdout.write("ready\\n")
    setInterval(() => {}, 1000)
  `], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, ...(cleanupToken ? { [LAUNCH_CLEANUP_TOKEN_ENV]: cleanupToken } : {}) },
  })
  assert.ok(leader.pid)
  await once(leader.stdout!, "data")
  return leader as typeof leader & { pid: number }
}

async function assertGroupGone(groupId: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const remaining = probePosixProcesses(spawnSync, 1_000, "darwin", { groupId })
    if (remaining.ok && remaining.processes.size === 0) return
    await delay(50)
  }
  assert.fail("owned Darwin process group remained alive after signaling")
}

it("uses real Darwin ps identities to stop an owned detached process group", darwinOnly, async () => {
  const leader = await spawnDetachedGroup()

  try {
    const snapshot = probePosixProcesses(spawnSync, 1_000, "darwin", {
      pids: [leader.pid],
      groupId: leader.pid,
    })
    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.ok && snapshot.processes.get(leader.pid)?.groupId, leader.pid)
    assert.equal(snapshot.ok && snapshot.processes.size >= 2, true)

    const signaled = signalOwnedPosixProcessGroup(spawnSync, leader.pid, "SIGTERM", 1_000)
    assert.equal(signaled.ok && signaled.matched, true)
    assert.equal(signaled.ok && signaled.signalSent, true)
    await assertGroupGone(leader.pid)
  } finally {
    try {
      process.kill(-leader.pid, "SIGKILL")
    } catch {
      // The successful path has already removed the process group.
    }
  }
})

it("uses a retained real Darwin identity anchor after the group leader exits", darwinOnly, async () => {
  const cleanupToken = "darwin-integration-cleanup-token"
  const leader = await spawnDetachedGroup(cleanupToken)

  try {
    const snapshot = probePosixProcesses(spawnSync, 1_000, "darwin", { groupId: leader.pid })
    assert.equal(snapshot.ok, true)
    const leaderIdentity = snapshot.ok ? snapshot.processes.get(leader.pid) : undefined
    assert.ok(leaderIdentity)
    assert.equal(snapshot.ok && snapshot.processes.size >= 2, true)

    leader.kill("SIGTERM")
    if (leader.exitCode === null) await once(leader, "exit")
    const signaled = signalPosixProcesses(spawnSync, {
      leader: leaderIdentity,
      groupId: leader.pid,
      members: [],
      signal: "SIGTERM",
      allowLeaderlessGroup: true,
      cleanupToken,
    }, 1_000, "darwin")
    assert.equal(signaled.ok && signaled.matched, true)
    assert.equal(signaled.ok && signaled.signalSent, true)
    await assertGroupGone(leader.pid)
  } finally {
    try {
      process.kill(-leader.pid, "SIGKILL")
    } catch {
      // The successful path has already removed the process group.
    }
  }
})
