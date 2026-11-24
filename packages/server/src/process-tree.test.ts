import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { test } from "node:test"
import { dotNetTicks, parseWindowsProcessRows, processTreeRows, stopWindowsProcessTree, windowsTreeStopTargets } from "./process-tree"

// 300 (cmd) and its child 301 (houdini) were started by a launcher that exited; the root's
// child 200 then received the launcher's ID. Both orphans still name 200 as their parent.
const recycled = [
  { pid: 100, parentPid: 1, startedAt: 1_000n },
  { pid: 300, parentPid: 200, startedAt: 500n },
  { pid: 301, parentPid: 300, startedAt: 510n },
  { pid: 200, parentPid: 100, startedAt: 2_000n },
  { pid: 201, parentPid: 200, startedAt: 2_000n },
  { pid: 999, parentPid: 1, startedAt: 10n },
]

test("a child that started before the process holding its parent ID is not in the tree", () => {
  assert.deepEqual(processTreeRows(100, recycled).map(row => row.pid), [100, 200, 201])
})

test("a recycled parent ID cannot pull the root's ancestors into a cycle", () => {
  const rows = [
    { pid: 10, parentPid: 30, startedAt: 100n },
    { pid: 20, parentPid: 10, startedAt: 200n },
    { pid: 30, parentPid: 20, startedAt: 300n },
  ]
  assert.deepEqual(processTreeRows(20, rows).map(row => row.pid), [20, 30])
})

test("unknown start times, duplicate rows and a missing root fail closed", () => {
  assert.deepEqual(processTreeRows(100, [
    { pid: 100, parentPid: 1, startedAt: 1n },
    { pid: 101, parentPid: 100 },
    { pid: 102, parentPid: 100, startedAt: 2n },
    { pid: 102, parentPid: 101, startedAt: 3n },
  ]).map(row => [row.pid, row.parentPid]), [[100, 1], [102, 100]])
  assert.deepEqual(processTreeRows(100, [{ pid: 100, parentPid: 1 }, { pid: 101, parentPid: 100, startedAt: 2n }]).map(row => row.pid), [100])
  assert.deepEqual(processTreeRows(7, recycled), [])
})

test("Windows stop targets follow creation times and refuse a root ID reused after the spawn", () => {
  const spawnedBy = new Date("2026-11-16T10:00:00.000Z")
  const rootTicks = dotNetTicks(spawnedBy.getTime()) - 5_000n
  const rows = parseWindowsProcessRows([
    `100|4|${rootTicks}`,
    `300|200|${rootTicks - 1n}`,
    `200|100|${rootTicks + 10n}`,
    "not a row",
    "",
  ].join("\r\n"))
  assert.deepEqual(windowsTreeStopTargets(100, rows, spawnedBy).map(row => row.pid), [100, 200])
  assert.deepEqual(windowsTreeStopTargets(100, rows, new Date(spawnedBy.getTime() - 10)), [])
  assert.equal(dotNetTicks(0), 621_355_968_000_000_000n)
})

test("Windows tree stop ends a spawned wrapper and its descendant", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
  const child = spawn(process.execPath, ["-e", `
    const nested = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    process.stdout.write(String(nested.pid)); setInterval(() => {}, 1000)
  `], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
  const spawnedBy = new Date()
  const exited = once(child, "exit")
  const nested = Number(String((await once(child.stdout!, "data"))[0]))
  try {
    // The wrapper, its descendant, and any console host Windows attached to them.
    assert.ok(await stopWindowsProcessTree(child.pid!, spawnedBy) >= 2)
    await exited
    const alive = () => { try { process.kill(nested, 0); return true } catch { return false } }
    for (const deadline = Date.now() + 5_000; alive() && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(alive(), false, "the wrapper's descendant is stopped")
  } finally {
    try { process.kill(nested) } catch {}
    child.kill()
  }
})
