import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"

const source = fileURLToPath(new URL("./loader.ts", import.meta.url))

// Compiles the production loader and registers it the way bin.ts does.
async function fixture(t: { after(fn: () => void): void }, files: Record<string, string | Buffer>) {
  const root = mkdtempSync(path.join(tmpdir(), "codenomad-loader-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await build({ entryPoints: [source], outfile: path.join(root, "loader.js"), format: "esm", platform: "node", logLevel: "silent" })
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }))
  for (const [name, contents] of Object.entries(files)) writeFileSync(path.join(root, name), contents)
  const loader = pathToFileURL(path.join(root, "loader.js")).href
  const register = `import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("${encodeURI(loader)}", pathToFileURL("./"));`
  return () => spawnSync(process.execPath, ["--import", `data:text/javascript,${register}`, path.join(root, "entry.js")],
    { cwd: root, encoding: "utf8" })
}

// Mach-O 64-bit magic followed by bytes that are not JavaScript.
const nativeHelper = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01]), Buffer.alloc(64, 0x9c)])

test("an extensionless import loads the compiled module beside a same-named native helper", async (t) => {
  const run = await fixture(t, {
    "entry.js": 'import { value } from "./helper"; console.log(value)',
    "helper.js": 'export const value = "compiled module"',
    helper: nativeHelper,
  })
  const result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), "compiled module")
})

test("a malformed compiled module and a missing module still fail to import", async (t) => {
  const malformed = await fixture(t, {
    "entry.js": 'import { value } from "./helper"; console.log(value)',
    "helper.js": "export const = ;",
    helper: nativeHelper,
  })
  const broken = malformed()
  assert.notEqual(broken.status, 0)
  assert.match(broken.stderr, /SyntaxError/)
  assert.match(broken.stderr, /helper\.js/)

  const missing = await fixture(t, { "entry.js": 'import "./absent"' })
  const absent = missing()
  assert.notEqual(absent.status, 0)
  assert.match(absent.stderr, /ERR_MODULE_NOT_FOUND/)
})
