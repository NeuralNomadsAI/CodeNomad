// Browser bitmap resizing happens after source decode. Admit bounded source pixels first.
const MAX_AXIS = 8192, MAX_PIXELS = 4 * 1024 * 1024

export function assertThumbnailBounds(bytes: Uint8Array, mime: string): void {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const bad = (): never => { throw new Error("Unsupported preview") }
  const fits = (width: number, height: number) => {
    if (!width || !height || width > MAX_AXIS || height > MAX_AXIS || width * height > MAX_PIXELS) bad()
    return [width, height] as const
  }
  const tag = (offset: number, value: string) => value.split("").every((char, index) => bytes[offset + index] === char.charCodeAt(0))
  if (mime.toLowerCase() === "image/png") {
    if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
      || data.getUint32(8) !== 13 || !tag(12, "IHDR")) bad()
    fits(data.getUint32(16), data.getUint32(20))
    return
  }
  if (mime.toLowerCase() === "image/jpeg") {
    if (bytes[0] !== 255 || bytes[1] !== 216) bad()
    let offset = 2, sized = false
    while (offset < bytes.length) {
      if (bytes[offset++] !== 255) bad()
      while (bytes[offset] === 255) offset++
      const marker = bytes[offset++]
      if (marker === 218) { if (!sized) bad(); return }
      if (marker === 217 || marker === 0 || marker === 216 || marker === undefined || offset + 2 > bytes.length) bad()
      const length = data.getUint16(offset)
      if (length < 2 || offset + length > bytes.length) bad()
      if ([192, 193, 194].includes(marker)) {
        if (sized || length < 8) bad()
        fits(data.getUint16(offset + 5), data.getUint16(offset + 3)); sized = true
      } else if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) bad()
      offset += length
    }
    bad()
  }
  if (mime.toLowerCase() === "image/gif") {
    if (bytes.length < 13 || (!tag(0, "GIF87a") && !tag(0, "GIF89a"))) bad()
    const [width, height] = fits(data.getUint16(6, true), data.getUint16(8, true))
    let offset = 13 + (bytes[10] & 128 ? 3 * (2 << (bytes[10] & 7)) : 0), frames = 0
    const blocks = () => {
      while (offset < bytes.length) {
        const size = bytes[offset++]; if (!size) return
        offset += size; if (offset > bytes.length) bad()
      }
      bad()
    }
    while (offset < bytes.length) {
      const marker = bytes[offset++]
      if (marker === 59) { if (!frames) bad(); return }
      if (marker === 33) { offset++; blocks(); continue }
      if (marker !== 44 || offset + 9 > bytes.length) bad()
      const [frameWidth, frameHeight] = fits(data.getUint16(offset + 4, true), data.getUint16(offset + 6, true))
      if (data.getUint16(offset, true) + frameWidth > width || data.getUint16(offset + 2, true) + frameHeight > height
        || ++frames * width * height > MAX_PIXELS) bad()
      const packed = bytes[offset + 8]
      offset += 9 + (packed & 128 ? 3 * (2 << (packed & 7)) : 0)
      if (bytes[offset] < 2 || bytes[offset] > 8 || offset >= bytes.length) bad()
      offset++; blocks()
    }
    bad()
  }
  if (mime.toLowerCase() === "image/webp") {
    if (bytes.length < 20 || !tag(0, "RIFF") || !tag(8, "WEBP") || data.getUint32(4, true) + 8 !== bytes.length) bad()
    let offset = 12, canvas: readonly [number, number] | undefined, image: readonly [number, number] | undefined
    const uint24 = (at: number) => bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) bad()
      const size = data.getUint32(offset + 4, true), start = offset + 8
      if (start + size > bytes.length) bad()
      if (tag(offset, "VP8X")) {
        if (canvas || size !== 10 || bytes[start] & 2) bad() // Animated WebP needs frame-level admission.
        canvas = fits(uint24(start + 4) + 1, uint24(start + 7) + 1)
      } else if (tag(offset, "VP8 ")) {
        if (image || size < 10 || bytes[start] & 1 || !tag(start + 3, "\x9d\x01\x2a")) bad()
        image = fits(data.getUint16(start + 6, true) & 16383, data.getUint16(start + 8, true) & 16383)
      } else if (tag(offset, "VP8L")) {
        if (image || size < 5 || bytes[start] !== 47) bad()
        const bits = data.getUint32(start + 1, true)
        if (bits >>> 29) bad()
        image = fits((bits & 16383) + 1, ((bits >>> 14) & 16383) + 1)
      } else if (tag(offset, "ANIM") || tag(offset, "ANMF")) bad()
      offset = start + size + (size & 1)
    }
    if (!image || offset !== bytes.length || canvas && (canvas[0] !== image[0] || canvas[1] !== image[1])) bad()
    return
  }
  // AVIF grids/subimages cannot be fenced by an arbitrary ispe box; keep metadata/full preview only.
  bad()
}
