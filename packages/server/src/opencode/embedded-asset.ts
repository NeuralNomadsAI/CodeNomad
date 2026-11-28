// The canonical validator stays inside the standalone pruning package.
import { isEmbeddedAsset } from "./session-pruning/assets-contract"
export { ASSET_URI_LIMIT, isEmbeddedAsset } from "./session-pruning/assets-contract"

export function embeddedImage(file: { mime: string; uri: string }): { mime: string; bytes: Buffer } | undefined {
  if (!isEmbeddedAsset(file)) return undefined
  const bytes = Buffer.from(file.uri.slice(file.uri.indexOf(",") + 1), "base64")
  const has = (offset: number, signature: readonly number[]) => signature.every((byte, index) => bytes[offset + index] === byte)
  const text = (offset: number, value: string) => has(offset, [...value].map(char => char.charCodeAt(0)))
  let mime: string | undefined
  if (has(0, [137,80,78,71,13,10,26,10])) mime = "image/png"
  else if (has(0, [255,216,255])) mime = "image/jpeg"
  else if (text(0, "GIF87a") || text(0, "GIF89a")) mime = "image/gif"
  else if (bytes.length >= 12 && text(0, "RIFF") && text(8, "WEBP")) mime = "image/webp"
  else if (bytes.length >= 26 && text(0, "BM")) mime = "image/bmp"
  else if (bytes.length >= 22 && has(0, [0,0,1,0]) && (bytes[4] || bytes[5])) mime = "image/x-icon"
  else if (bytes.length >= 16 && text(4, "ftyp")) {
    const size = bytes.readUInt32BE(0)
    if (size >= 16 && size <= bytes.length && size % 4 === 0) {
      for (let offset = 8; offset < size; offset += offset === 8 ? 8 : 4) {
        if (text(offset, "avif") || text(offset, "avis")) { mime = "image/avif"; break }
      }
    }
  }
  return mime && mime === file.mime ? { mime, bytes } : undefined
}
