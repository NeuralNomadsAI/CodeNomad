#!/usr/bin/env node
// Renders every CodeNomad icon size straight from images/CodeNomad-Icon.svg: each size is
// drawn for its own pixel grid, never shrunk from a larger bitmap. Needs Playwright's
// Chromium (`npx playwright install chromium`). Usage: node scripts/generate-icons.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const at = (path) => join(root, path)

// Windows picks the entry nearest each display scale: 100 % to 200 % taskbars, lists and tiles.
const ICO_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256]
// The slots iconutil writes for a standard iconset; the @2x slots reuse the larger renders.
const ICNS_SLOTS = [["icp4", 16], ["icp5", 32], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024], ["ic11", 32], ["ic12", 64], ["ic13", 256], ["ic14", 512]]
const LINUX_SIZES = [32, 48, 64, 128, 256, 512]

async function render(svg, sizes) {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
    const images = new Map()
    for (const size of sizes) {
      const { png, rgba } = await page.evaluate(async ({ source, size }) => {
        const image = new Image()
        image.src = source
        await image.decode()
        const canvas = document.createElement("canvas")
        canvas.width = canvas.height = size
        const context = canvas.getContext("2d")
        context.drawImage(image, 0, 0, size, size)
        return { png: canvas.toDataURL("image/png"), rgba: Array.from(context.getImageData(0, 0, size, size).data) }
      }, { source, size })
      images.set(size, { png: Buffer.from(png.split(",")[1], "base64"), rgba })
    }
    return images
  } finally {
    await browser.close()
  }
}

// 32-bit bottom-up DIB with its AND mask, the entry format every Windows icon reader takes.
function dib(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4
  const pixels = size * size * 4
  const out = Buffer.alloc(40 + pixels + maskRow * size)
  out.writeUInt32LE(40, 0)
  out.writeInt32LE(size, 4)
  out.writeInt32LE(size * 2, 8)
  out.writeUInt16LE(1, 12)
  out.writeUInt16LE(32, 14)
  out.writeUInt32LE(pixels + maskRow * size, 20)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = ((size - 1 - y) * size + x) * 4
      const to = 40 + (y * size + x) * 4
      out[to] = rgba[from + 2]
      out[to + 1] = rgba[from + 1]
      out[to + 2] = rgba[from]
      out[to + 3] = rgba[from + 3]
      if (rgba[from + 3] === 0) out[40 + pixels + y * maskRow + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return out
}

// DIB entries below 256 px and a PNG entry at 256 px, as Windows' own icons do.
function ico(images) {
  const entries = ICO_SIZES.map((size) => ({ size, data: size === 256 ? images.get(size).png : dib(size, images.get(size).rgba) }))
  const header = Buffer.alloc(6 + 16 * entries.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = header.length
  entries.forEach(({ size, data }, index) => {
    const entry = 6 + 16 * index
    header.writeUInt8(size % 256, entry)
    header.writeUInt8(size % 256, entry + 1)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(data.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += data.length
  })
  return Buffer.concat([header, ...entries.map(({ data }) => data)])
}

function icns(images) {
  const body = Buffer.concat(ICNS_SLOTS.map(([type, size]) => {
    const data = images.get(size).png
    const header = Buffer.alloc(8)
    header.write(type, 0, "ascii")
    header.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([header, data])
  }))
  const header = Buffer.alloc(8)
  header.write("icns", 0, "ascii")
  header.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([header, body])
}

function write(path, data) {
  mkdirSync(dirname(at(path)), { recursive: true })
  writeFileSync(at(path), data)
  console.log(`wrote ${path}`)
}

const svg = readFileSync(at("images/CodeNomad-Icon.svg"), "utf8")
const sizes = new Set([...ICO_SIZES, ...ICNS_SLOTS.map(([, size]) => size), ...LINUX_SIZES, 1024])
const images = await render(svg, [...sizes].sort((a, b) => a - b))
const master = images.get(1024).png
const icoFile = ico(images)
const icnsFile = icns(images)

write("images/CodeNomad-Icon.png", master)
write("packages/ui/src/images/CodeNomad-Icon.png", master)
for (const directory of ["packages/electron-app/electron/resources", "packages/tauri-app/src-tauri"]) {
  write(`${directory}/icon.png`, master)
  write(`${directory}/icon.ico`, icoFile)
  write(`${directory}/icon.icns`, icnsFile)
}
for (const size of LINUX_SIZES) write(`packages/tauri-app/src-tauri/icons/linux/${size}x${size}.png`, images.get(size).png)
