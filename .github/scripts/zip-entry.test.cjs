const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const script = path.join(__dirname, "zip-entry.ps1")
const pwsh = (command) => spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" })
const quote = (value) => `'${value.replaceAll("'", "''")}'`

// Stored (uncompressed) archives, so a test can rewrite entry data in place
// while every header, size and CRC field keeps its original value.
function makeZip(file, entries) {
  const adds = entries.map(([name, text]) => `
    $e = $z.CreateEntry(${quote(name)}, [IO.Compression.CompressionLevel]::NoCompression)
    $w = [IO.StreamWriter]::new($e.Open()); $w.Write(${quote(text)}); $w.Dispose()`).join("")
  const result = pwsh(`Add-Type -AssemblyName System.IO.Compression
    $f = [IO.File]::Create(${quote(file)})
    $z = [IO.Compression.ZipArchive]::new($f, [IO.Compression.ZipArchiveMode]::Create)
    ${adds}
    $z.Dispose(); $f.Dispose()`)
  assert.equal(result.status, 0, result.stderr)
}

function run(zip, original) {
  const destination = path.join(path.dirname(zip), "out", "CodeNomad.exe")
  const args = `-Zip ${quote(zip)} -Entry CodeNomad.exe -Destination ${quote(destination)}` + (original ? ` -Original ${quote(original)}` : "")
  const result = pwsh(`& ${quote(script)} ${args}`)
  return { ...result, destination }
}

test("only the signed entry may differ, compared by decompressed contents", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zip-entry-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const original = path.join(dir, "original.zip")
  const signed = path.join(dir, "signed.zip")
  const tampered = path.join(dir, "tampered.zip")
  makeZip(original, [["CodeNomad.exe", "unsigned-exe"], ["ffmpeg.dll", "library-AAAA"]])
  makeZip(signed, [["CodeNomad.exe", "signed-exe-bytes"], ["ffmpeg.dll", "library-AAAA"]])

  const accepted = run(signed, original)
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout)
  assert.equal(fs.readFileSync(accepted.destination, "utf8"), "signed-exe-bytes")

  // Same length, untouched headers and CRC fields: only the data changes.
  const bytes = fs.readFileSync(signed)
  const at = bytes.indexOf("library-AAAA")
  assert.ok(at > 0)
  bytes.write("library-BBBB", at)
  fs.writeFileSync(tampered, bytes)
  const rejected = run(tampered, original)
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr + rejected.stdout, /ffmpeg\.dll/)
})

test("archives with duplicate entry names or a missing entry are refused", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zip-entry-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const original = path.join(dir, "original.zip")
  const duplicate = path.join(dir, "duplicate.zip")
  const missing = path.join(dir, "missing.zip")
  makeZip(original, [["CodeNomad.exe", "a"], ["ffmpeg.dll", "lib"]])
  makeZip(duplicate, [["CodeNomad.exe", "b"], ["ffmpeg.dll", "evil"], ["ffmpeg.dll", "lib"]])
  makeZip(missing, [["ffmpeg.dll", "lib"]])

  const dup = run(duplicate, original)
  assert.notEqual(dup.status, 0)
  assert.match(dup.stderr + dup.stdout, /Duplicate entry ffmpeg\.dll/)
  const gone = run(missing)
  assert.notEqual(gone.status, 0)
  assert.match(gone.stderr + gone.stdout, /CodeNomad\.exe is missing/)
})
