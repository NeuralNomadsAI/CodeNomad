/** Closed image signatures; the response's declared MIME never grants document privileges. */
export function passiveImageType(bytes: Uint8Array): string | undefined {
  const has = (offset: number, signature: readonly number[]) => signature.every((byte, index) => bytes[offset + index] === byte)
  const text = (offset: number, value: string) => has(offset, [...value].map(char => char.charCodeAt(0)))
  if (has(0, [137, 80, 78, 71, 13, 10, 26, 10])) return "image/png"
  if (has(0, [255, 216, 255])) return "image/jpeg"
  if (text(0, "GIF87a") || text(0, "GIF89a")) return "image/gif"
  if (bytes.length >= 12 && text(0, "RIFF") && text(8, "WEBP")) return "image/webp"
  if (bytes.length >= 26 && text(0, "BM")) return "image/bmp"
  if (bytes.length >= 22 && has(0, [0, 0, 1, 0]) && (bytes[4] || bytes[5])) return "image/x-icon"
  if (bytes.length >= 16 && text(4, "ftyp")) {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
    if (size < 16 || size > bytes.length || size % 4) return undefined
    for (let offset = 8; offset < size; offset += offset === 8 ? 8 : 4) {
      if (text(offset, "avif") || text(offset, "avis")) return "image/avif"
    }
  }
  return undefined
}
