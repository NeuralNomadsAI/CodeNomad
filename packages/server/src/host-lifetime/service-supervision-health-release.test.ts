import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readSupervisionSample, supervisionReleasePreserved, type SupervisionSample } from "./service-supervision-health"

test("OFF continuity survives HTTP failure only with exact registration and native process proof", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervision-release-")), file = path.join(root, "service.json")
  t.after(() => rm(root, { recursive: true, force: true }))
  const record = { pid: 123, id: "instance", url: "http://127.0.0.1:12345", version: "test" }
  const reset = () => writeFile(file, JSON.stringify({ ...record, password: "synthetic-private" }))
  const live = { state: "live" as const, startIdentity: "linux:boot:1234" }
  const deps = { lookup: async () => live, discover: async () => undefined }
  await reset()
  const unhealthy = await readSupervisionSample(file, deps)
  assert.deepEqual(unhealthy, { health: { state: "unhealthy" }, identity: { ...record, startIdentity: live.startIdentity } })
  assert.equal(JSON.stringify(unhealthy).includes("synthetic-private"), false)
  const healthy = await readSupervisionSample(file, { ...deps, discover: async () => ({ url: record.url, auth: undefined }) })
  const unknownHealth = await readSupervisionSample(file, { ...deps, discover: async () => { throw new Error("private") } })
  for (const before of [healthy, unhealthy, unknownHealth]) {
    for (const after of [healthy, unhealthy, unknownHealth]) assert.equal(supervisionReleasePreserved(before, after), true)
  }
  for (const changed of [{ pid: 124 }, { id: "replacement" }, { url: "http://127.0.0.1:12346" }, { version: "other" }]) {
    await writeFile(file, JSON.stringify({ ...record, ...changed }))
    const after = await readSupervisionSample(file, deps)
    assert.equal(supervisionReleasePreserved(unhealthy, after), false)
  }
  for (const bytes of ["{bad", JSON.stringify({ ...record, id: undefined }), "x".repeat(32769)]) {
    await writeFile(file, bytes)
    const after = await readSupervisionSample(file, deps)
    assert.deepEqual(after, { health: { state: "unknown" } })
    assert.equal(supervisionReleasePreserved(unhealthy, after), false)
  }
  await rm(file)
  const absent = await readSupervisionSample(file, deps)
  assert.equal(supervisionReleasePreserved(unhealthy, absent), false, "lost registration never proves release")
  assert.equal(supervisionReleasePreserved(absent, absent), true)
  assert.equal(supervisionReleasePreserved(absent, unhealthy), false, "a replacement cannot appear during removal")
  await reset()
  for (const process of [{ state: "dead" as const }, { state: "unknown" as const }, { ...live, startIdentity: "linux:boot:reused" }]) {
    const after = await readSupervisionSample(file, { ...deps, lookup: async () => process })
    assert.equal(supervisionReleasePreserved(unhealthy, after), false)
  }
  for (const state of ["healthy", "unknown", "unhealthy", "starting"] as const) {
    const unproved = { health: { state } } as SupervisionSample
    assert.equal(supervisionReleasePreserved(unproved, unproved), false, "generic health has no release authority")
  }
})

test("discovery races and incomplete native identity invalidate OFF proof", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervision-race-")), file = path.join(root, "service.json")
  t.after(() => rm(root, { recursive: true, force: true }))
  const record = { pid: 123, id: "original", url: "http://127.0.0.1:12345" }
  for (const change of ["id", "url", "pid", "start", "dead", "unknown", "remove", "malformed"] as const) {
    await writeFile(file, JSON.stringify(record))
    let reads = 0
    const sample = await readSupervisionSample(file, {
      lookup: async () => {
        reads++
        if (reads === 2 && (change === "dead" || change === "unknown")) return { state: change }
        return { state: "live", startIdentity: reads === 2 && change === "start" ? "reused" : "original" }
      },
      discover: async () => {
        if (change === "remove") await rm(file)
        if (change === "malformed") await writeFile(file, "{}")
        if (change === "id") await writeFile(file, JSON.stringify({ ...record, id: "other" }))
        if (change === "url") await writeFile(file, JSON.stringify({ ...record, url: "http://127.0.0.1:12346" }))
        if (change === "pid") await writeFile(file, JSON.stringify({ ...record, pid: 124 }))
        return undefined
      },
    })
    assert.deepEqual(sample, { health: { state: "unknown" } }, change)
  }
})
