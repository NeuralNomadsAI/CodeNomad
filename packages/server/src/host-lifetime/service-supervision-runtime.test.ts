import assert from "node:assert/strict"
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { prepareSupervisionRoot, provisionSupervisionRuntime } from "./service-supervision-runtime"
import { windowsStorageScript, verifyWindowsStorageEvidence } from "./windows-storage"

test("durable runtime copies are immutable, shared and usable after package removal; altered artifacts fail closed", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervision-runtime-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, "package"), owned = path.join(root, "owned")
  await mkdir(source); await mkdir(owned)
  const sources = { node: path.join(source, "node.exe"), script: path.join(source, "guard.ps1"), probe: path.join(source, "probe.cjs") }
  for (const [key, file] of Object.entries(sources)) await writeFile(file, `owned-${key}`)
  const policy = { async verify(file: string, directory: boolean) {
    const stat = await lstat(file)
    assert.equal(stat.isSymbolicLink(), false)
    assert.ok(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1)
  } }
  const first = await provisionSupervisionRuntime(owned, policy, sources)
  const second = await provisionSupervisionRuntime(owned, policy, sources)
  assert.deepEqual(first, second)
  await writeFile(first.probe, "tampered")
  await assert.rejects(provisionSupervisionRuntime(owned, policy, sources), /conflict/)
  await writeFile(first.probe, "owned-probe")
  await rm(source, { recursive: true })
  for (const [key, file] of Object.entries(first)) assert.equal(await readFile(file, "utf8"), `owned-${key}`)
})

test("new Windows roots receive a private DACL; existing ACLs are verified rather than rewritten", { skip: process.platform !== "win32" }, async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "supervision-private-root-")), root = path.join(parent, "private")
  t.after(() => rm(parent, { recursive: true, force: true }))
  const powershell = path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe")
  const exec = promisify(execFile)
  let evidence = ""
  const policy = { async verify(file: string, directory: boolean) {
    const { script } = windowsStorageScript(file)
    const { stdout } = await exec(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 5000, maxBuffer: 65536,
        env: { ...process.env, PSModulePath: path.join(path.dirname(powershell), "Modules") } })
    const parsed = JSON.parse(stdout)
    parsed.entries = parsed.entries.slice(0, 1)
    verifyWindowsStorageEvidence(JSON.stringify(parsed), directory, 0)
    evidence = JSON.stringify(parsed)
  } }
  await prepareSupervisionRoot(root, powershell, policy)
  const before = evidence
  await prepareSupervisionRoot(root, powershell, policy)
  assert.equal(evidence, before)
  const leaf = JSON.parse(evidence)
  assert.ok(leaf.entries[0].aces.every((ace: { sid: string }) => [leaf.currentSid, "S-1-5-18"].includes(ace.sid)))
})
