import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  REQUIRED_PLUGIN_FEATURES,
  assertStaticCrtPe,
  createDeterministicZip,
  inspectPeImports,
  listZipEntries,
  packageWindowsInstaller,
} from "./package-windows-installer.mjs"

const SCRIPT_PATH = fileURLToPath(new URL("./package-windows-installer.mjs", import.meta.url))

/**
 * Synthesizes a minimal valid PE32+ executable with one `.rdata` section containing
 * an IMAGE_IMPORT_DESCRIPTOR table for `dllNames`.
 */
function buildSyntheticPe(dllNames, { delayDllNames = [] } = {}) {
  const peOffset = 0x80
  const optSize = 0xf0 // standard PE32+ optional header (112 + 16*8)
  const secOffset = peOffset + 24 + optSize
  const rawPtr = 0x200
  const sectionRva = 0x1000

  const descSize = (dllNames.length + 1) * 20
  const delayDescOffset = descSize
  const delayDescSize = delayDllNames.length > 0 ? (delayDllNames.length + 1) * 32 : 0
  const names = dllNames.map((n) => Buffer.from(`${n}\0`, "ascii"))
  const delayNames = delayDllNames.map((n) => Buffer.from(`${n}\0`, "ascii"))
  const stringsStart = delayDescOffset + delayDescSize
  const namesTotal = [...names, ...delayNames].reduce((sum, b) => sum + b.length, 0)
  const totalRdata = Math.max(0x200, stringsStart + namesTotal)
  const buf = Buffer.alloc(rawPtr + totalRdata)

  // DOS header
  buf.writeUInt16LE(0x5a4d, 0) // MZ
  buf.writeUInt32LE(peOffset, 0x3c)

  // PE + COFF header
  buf.writeUInt32LE(0x00004550, peOffset) // PE\0\0
  buf.writeUInt16LE(0x8664, peOffset + 4) // AMD64
  buf.writeUInt16LE(1, peOffset + 6) // 1 section
  buf.writeUInt16LE(optSize, peOffset + 20)

  // Optional header (PE32+)
  const opt = peOffset + 24
  buf.writeUInt16LE(0x20b, opt)
  buf.writeUInt32LE(16, opt + 108) // NumberOfRvaAndSizes
  if (dllNames.length > 0) {
    buf.writeUInt32LE(sectionRva, opt + 112 + 8) // Import Table RVA
    buf.writeUInt32LE(descSize, opt + 112 + 12) // Import Table Size
  }
  if (delayDllNames.length > 0) {
    buf.writeUInt32LE(sectionRva + delayDescOffset, opt + 112 + 13 * 8) // Delay Import RVA
    buf.writeUInt32LE(delayDescSize, opt + 112 + 13 * 8 + 4) // Delay Import Size
  }

  // Section header `.rdata`
  buf.write(".rdata\0\0", secOffset, "ascii")
  buf.writeUInt32LE(totalRdata, secOffset + 8) // VirtualSize
  buf.writeUInt32LE(sectionRva, secOffset + 12) // VirtualAddress
  buf.writeUInt32LE(totalRdata, secOffset + 16) // SizeOfRawData
  buf.writeUInt32LE(rawPtr, secOffset + 20) // PointerToRawData

  // Standard + delay-load import descriptors + DLL name strings
  let strCursor = stringsStart
  for (let i = 0; i < dllNames.length; i++) {
    const desc = rawPtr + i * 20
    buf.writeUInt32LE(sectionRva + strCursor, desc + 12) // Name RVA
    buf.writeUInt32LE(sectionRva + 4, desc + 16) // non-zero FirstThunk
    names[i].copy(buf, rawPtr + strCursor)
    strCursor += names[i].length
  }
  for (let i = 0; i < delayDllNames.length; i++) {
    const desc = rawPtr + delayDescOffset + i * 32
    buf.writeUInt32LE(1, desc) // RVA-based delay descriptor
    buf.writeUInt32LE(sectionRva + strCursor, desc + 4) // szName RVA
    buf.writeUInt32LE(sectionRva + 8, desc + 12) // non-zero IAT RVA
    delayNames[i].copy(buf, rawPtr + strCursor)
    strCursor += delayNames[i].length
  }
  return buf
}

async function createFakeSource(root, { includePublic = true, includeProvider = false, dlls = ["KERNEL32.dll", "ucrtbase.dll"] } = {}) {
  const fromDir = path.join(root, "from")
  await mkdir(fromDir, { recursive: true })
  const pe = buildSyntheticPe(dlls)
  await writeFile(path.join(fromDir, "codenomad-rune.exe"), pe)
  await writeFile(path.join(fromDir, "codenomad-rs.exe"), pe)
  // Stray Cargo artifacts beside binaries in --from-dir must be ignored (only the two exes are copied).
  await writeFile(path.join(fromDir, "codenomad-rune.pdb"), "debug-symbols")

  const pluginsDir = path.join(fromDir, "plugins")
  for (const feature of REQUIRED_PLUGIN_FEATURES) {
    await mkdir(path.join(pluginsDir, feature), { recursive: true })
    await writeFile(path.join(pluginsDir, feature, "plugin.mjs"), `export const feature = "${feature}";\n`)
  }
  if (includeProvider) {
    await writeFile(path.join(pluginsDir, "missions", "provider.mjs"), "export const provider = true;\n")
  }

  if (includePublic) {
    const publicDir = path.join(fromDir, "public")
    await mkdir(path.join(publicDir, "snippets"), { recursive: true })
    await writeFile(path.join(publicDir, "index.html"), "<!doctype html><title>CodeNomad</title>\n")
    await writeFile(path.join(publicDir, "boot.js"), "console.log('boot')\n")
    await writeFile(path.join(publicDir, "app_bg.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))
    await writeFile(path.join(publicDir, "app.d.ts"), "export default function init(): Promise<void>;\n")
    await writeFile(path.join(publicDir, "bundle-manifest.json"), JSON.stringify({ testSupport: false }) + "\n")
    await writeFile(path.join(publicDir, "snippets", "glue.js"), "export {}\n")
  }
  return fromDir
}

test("PE import inspector accepts +crt-static binaries and rejects dynamic/debug MSVC CRT", async () => {
  const clean = buildSyntheticPe(["KERNEL32.dll", "ucrtbase.dll", "WS2_32.dll"])
  assert.deepEqual(inspectPeImports(clean), ["KERNEL32.dll", "WS2_32.dll", "ucrtbase.dll"])

  const root = await mkdtemp(path.join(os.tmpdir(), "cn-pe-test-"))
  try {
    const cleanPath = path.join(root, "clean.exe")
    await writeFile(cleanPath, clean)
    await assertStaticCrtPe(cleanPath)

    for (const badDll of ["VCRUNTIME140.dll", "VCRUNTIME140_1.dll", "MSVCP140.dll", "ucrtbased.dll"]) {
      const badPath = path.join(root, `${badDll}.exe`)
      await writeFile(badPath, buildSyntheticPe(["KERNEL32.dll", badDll]))
      await assert.rejects(
        () => assertStaticCrtPe(badPath),
        (err) => err instanceof Error && err.message.includes(badDll) && err.message.includes("+crt-static"),
      )
    }

    const delayBadPath = path.join(root, "delay-bad.exe")
    await writeFile(
      delayBadPath,
      buildSyntheticPe(["KERNEL32.dll"], { delayDllNames: ["VCRUNTIME140.dll"] }),
    )
    await assert.rejects(() => assertStaticCrtPe(delayBadPath), /VCRUNTIME140\.dll/)

    const notPe = path.join(root, "not-pe.exe")
    await writeFile(notPe, "not a pe binary")
    await assert.rejects(() => assertStaticCrtPe(notPe), /MZ header/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("stages deterministic payload.zip with root layout, POSIX paths and reproducible bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cn-pkg-test-"))
  try {
    const fromDir = await createFakeSource(root, { includePublic: true, includeProvider: true })
    const outA = path.join(root, "out-a", "payload.zip")
    const outB = path.join(root, "out-b", "payload.zip")

    const resA = await packageWindowsInstaller({ fromDir, out: outA, sourceDateEpoch: 1764000000 })
    const resB = await packageWindowsInstaller({ fromDir, out: outB, sourceDateEpoch: 1764000000 })
    const outC = path.join(root, "out-c", "payload.zip")
    await packageWindowsInstaller({ fromDir, out: outC, sourceDateEpoch: 1764086400 })
    const bytesA = await readFile(outA)
    const bytesB = await readFile(outB)
    const bytesC = await readFile(outC)
    assert.equal(bytesA.equals(bytesB), true, "identical inputs and epoch must produce reproducible payload.zip")
    assert.equal(bytesA.equals(bytesC), false, "different release epochs must update ZIP mtimes for ETag freshness")
    assert.equal(resA.payloadBytes, bytesA.length)
    assert.equal(resB.publicFilesCount, 5) // app.d.ts is omitted automatically

    const entries = listZipEntries(bytesA)
    assert.deepEqual(
      entries.map((e) => e.name),
      [
        "codenomad-rs.exe",
        "codenomad-rune.exe",
        "plugins/automation/plugin.mjs",
        "plugins/memory/plugin.mjs",
        "plugins/missions/plugin.mjs",
        "plugins/missions/provider.mjs",
        "plugins/session-pruning/plugin.mjs",
        "public/app_bg.wasm",
        "public/boot.js",
        "public/bundle-manifest.json",
        "public/index.html",
        "public/snippets/glue.js",
      ],
    )
    const missionsEntry = entries.find((e) => e.name === "plugins/missions/plugin.mjs")
    assert.equal(missionsEntry.data.toString("utf8"), 'export const feature = "missions";\n')

    // On Windows, verify real System32\tar.exe -xf - with a seekable file stdin
    // (the exact command codenomad-rune-setup/src/install.rs uses) extracts it cleanly.
    if (process.platform === "win32") {
      const tarExe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      const unpacked = path.join(root, "unpacked")
      await mkdir(unpacked, { recursive: true })
      const fd = openSync(outA, "r")
      let tarRes
      try {
        tarRes = spawnSync(tarExe, ["-xf", "-"], {
          cwd: unpacked,
          stdio: [fd, "pipe", "pipe"],
          windowsHide: true,
        })
      } finally {
        closeSync(fd)
      }
      assert.equal(tarRes.status, 0, `tar.exe -xf - failed: ${tarRes.stderr?.toString("utf8")}`)
      assert.equal(
        await readFile(path.join(unpacked, "plugins", "missions", "plugin.mjs"), "utf8"),
        'export const feature = "missions";\n',
      )
      assert.equal(
        await readFile(path.join(unpacked, "public", "index.html"), "utf8"),
        "<!doctype html><title>CodeNomad</title>\n",
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects missing required binaries, missing plugins, forbidden junk/PDB files and incomplete public bundles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cn-pkg-err-"))
  try {
    // Missing server binary
    const missingServer = await createFakeSource(path.join(root, "case-server"))
    await rm(path.join(missingServer, "codenomad-rs.exe"))
    await assert.rejects(
      () => packageWindowsInstaller({ fromDir: missingServer, out: path.join(root, "a.zip") }),
      /Missing required file: codenomad-rs\.exe/,
    )

    // Missing required plugin
    const missingPlugin = await createFakeSource(path.join(root, "case-plugin"))
    await rm(path.join(missingPlugin, "plugins", "memory", "plugin.mjs"))
    await assert.rejects(
      () => packageWindowsInstaller({ fromDir: missingPlugin, out: path.join(root, "b.zip") }),
      /Missing required plugin payload: plugins\/memory\/plugin\.mjs/,
    )

    // Forbidden .pdb inside public/
    const dirtyPublic = await createFakeSource(path.join(root, "case-pdb"))
    await writeFile(path.join(dirtyPublic, "public", "leftover.pdb"), "pdb")
    await assert.rejects(
      () => packageWindowsInstaller({ fromDir: dirtyPublic, out: path.join(root, "c.zip") }),
      /Forbidden debug\/cache file in public\/: public\/leftover\.pdb/,
    )

    // Unexpected stray file inside plugins/
    const dirtyPlugin = await createFakeSource(path.join(root, "case-stray-plugin"))
    await writeFile(path.join(dirtyPlugin, "plugins", "automation", "extra.map"), "{}")
    await assert.rejects(
      () => packageWindowsInstaller({ fromDir: dirtyPlugin, out: path.join(root, "d.zip") }),
      /Forbidden entry in plugins\/automation: extra\.map/,
    )

    // Incomplete Rune web bundle (boot.js without app_bg.wasm)
    const halfRune = await createFakeSource(path.join(root, "case-half-rune"))
    await rm(path.join(halfRune, "public", "app_bg.wasm"))
    await assert.rejects(
      () => packageWindowsInstaller({ fromDir: halfRune, out: path.join(root, "e.zip") }),
      /Incomplete Rune web bundle/,
    )

    // Test-support Rune web bundle rejected
    const testSupportWeb = await createFakeSource(path.join(root, "case-test-support"))
    await writeFile(
      path.join(testSupportWeb, "public", "bundle-manifest.json"),
      JSON.stringify({ testSupport: true }),
    )
    await assert.rejects(
      () => packageWindowsInstaller({ fromDir: testSupportWeb, out: path.join(root, "ts.zip") }),
      /test-support/,
    )

    // Dynamic CRT executable rejected by default
    const dynCrt = await createFakeSource(path.join(root, "case-crt"), {
      dlls: ["KERNEL32.dll", "vcruntime140.dll"],
    })
    await assert.rejects(
      () => packageWindowsInstaller({ fromDir: dynCrt, out: path.join(root, "f.zip") }),
      /vcruntime140\.dll/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("CLI supports --stage-only, --no-public, and refuses to clobber non-empty stage dir without --clean-stage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cn-pkg-cli-"))
  try {
    const fromDir = await createFakeSource(root, { includePublic: true })
    const stageDir = path.join(root, "stage")
    const stdout = execFileSync(
      process.execPath,
      [SCRIPT_PATH, "--from-dir", fromDir, "--no-public", "--stage-only", "--stage-dir", stageDir],
      { encoding: "utf8", windowsHide: true },
    )
    const summary = JSON.parse(stdout.trim())
    assert.equal(summary.payloadZip, null)
    assert.equal(summary.publicFiles, 0)
    assert.equal(summary.files, 6) // 2 exes + 4 plugin.mjs

    // Re-running on non-empty stageDir without --clean-stage fails closed.
    const failed = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--from-dir", fromDir, "--no-public", "--stage-only", "--stage-dir", stageDir],
      { encoding: "utf8", windowsHide: true },
    )
    assert.notEqual(failed.status, 0)
    assert.match(failed.stderr, /not empty/)

    // Zipping the staged directory directly produces valid entries without public/.
    const zipBytes = await createDeterministicZip(stageDir)
    const names = listZipEntries(zipBytes).map((e) => e.name)
    assert.equal(names.some((n) => n.startsWith("public/")), false)
    assert.ok(names.includes("codenomad-rune.exe"))
    assert.ok(names.includes("codenomad-rs.exe"))

    // Symlink check on Unix (and Windows if Developer Mode permits symlink creation).
    const linkCase = await createFakeSource(path.join(root, "case-link"))
    let symlinkCreated = false
    try {
      await symlink(path.join(linkCase, "public", "index.html"), path.join(linkCase, "public", "alias.html"))
      symlinkCreated = true
    } catch {
      symlinkCreated = false
    }
    if (symlinkCreated) {
      await assert.rejects(
        () => packageWindowsInstaller({ fromDir: linkCase, out: path.join(root, "link.zip") }),
        /Symlink not allowed/,
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
