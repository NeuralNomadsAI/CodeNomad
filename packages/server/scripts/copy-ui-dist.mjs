#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from "fs"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { brotliCompress, constants, gzip } from "node:zlib"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const cliRoot = path.resolve(__dirname, "..")
const uiDistDir = path.resolve(cliRoot, "../ui/src/renderer/dist")
const targetDir = path.resolve(cliRoot, "public")

if (!existsSync(uiDistDir)) {
  console.error(`[copy-ui-dist] Expected UI build artifacts at ${uiDistDir}. Run the UI build before bundling the CLI.`)
  process.exit(1)
}

rmSync(targetDir, { recursive: true, force: true })
mkdirSync(targetDir, { recursive: true })
cpSync(uiDistDir, targetDir, { recursive: true })

const codecs = [
  [".br", promisify(brotliCompress), { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }],
  [".gz", promisify(gzip), { level: 9 }],
]
for (const entry of await readdir(targetDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || /\.(?:br|gz|deflate)$/i.test(entry.name)) continue
  const file = path.join(entry.parentPath, entry.name)
  const raw = await readFile(file)
  if (raw.length < 1024) continue
  await Promise.all(codecs.map(async ([suffix, compress, options]) => {
    if (existsSync(file + suffix)) return
    const compressed = await compress(raw, options)
    if (compressed.length < raw.length) await writeFile(file + suffix, compressed, { flag: "wx" })
  }))
}

console.log(`[copy-ui-dist] Copied UI bundle from ${uiDistDir} -> ${targetDir}`)
