// Deterministic, memory-only stored ZIPs for server and rendered browser regressions.
import { crc32 } from "node:zlib"
export function fixtureZip(files: { name: string; data: string | Buffer; mode?: number; size?: number }[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name), bytes = Buffer.from(file.data), size = file.size ?? bytes.length
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4)
    header.writeUInt32LE(crc32(bytes), 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(name.length, 26)
    local.push(header, name, bytes)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(0x314, 4); entry.writeUInt16LE(20, 6)
    entry.writeUInt32LE(crc32(bytes), 16); entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(size, 24); entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(((file.mode ?? 0o100644) << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42)
    central.push(entry, name); offset += header.length + name.length + bytes.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
export const fixtureManifest = { id: "example.session", name: "Session example", version: "1.0.0", apiVersion: 1,
  author: "Example", license: "MIT", repository: "https://github.com/example/session", permissions: ["session.context"] }
export const fixtureArchive = (html = "<p>Example</p>", changes = {}) => fixtureZip([
  { name: "manifest.json", data: JSON.stringify({ ...fixtureManifest, ...changes }) }, { name: "panel.html", data: html },
])
