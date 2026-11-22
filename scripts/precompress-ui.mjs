import { readFile, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { brotliCompress, constants, gzip } from "node:zlib"

const codecs = [
  [".br", promisify(brotliCompress), { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }],
  [".gz", promisify(gzip), { level: 9 }],
]

export async function precompressUi(directory) {
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || /\.(?:br|gz|deflate)$/i.test(entry.name)) continue
    const file = path.join(entry.parentPath, entry.name)
    if ((await stat(file)).size < 1024) continue
    const raw = await readFile(file)
    await Promise.all(codecs.map(async ([suffix, compress, options]) => {
      const compressed = await compress(raw, options)
      if (compressed.length < raw.length) await writeFile(file + suffix, compressed)
    }))
  }
}
