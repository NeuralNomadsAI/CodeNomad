/** Maximum complete data URI length, independently of transcript deferral. */
export const ASSET_URI_LIMIT = 8 * 1024 * 1024

const passiveImages = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"])
export const isPassiveImageMime = (mime: string): boolean => passiveImages.has(mime.toLowerCase())

/** Validate before decoding; reject noncanonical padding and unused base64 bits. */
export function isEmbeddedAsset(file: { mime: string; uri: string }): boolean {
  if (file.uri.length > ASSET_URI_LIMIT || file.mime.length > 128 || !/^[\w.+-]+\/[\w.+-]+$/.test(file.mime)) return false
  const prefix = `data:${file.mime.toLowerCase()};base64,`
  if (file.uri.slice(0, prefix.length).toLowerCase() !== prefix) return false
  const body = file.uri.slice(prefix.length)
  if (!body.length || body.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body)) return false
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  if (padding && (alphabet.indexOf(body[body.length - padding - 1]) & (padding === 2 ? 15 : 3))) return false
  return body.length / 4 * 3 - padding > 0
}
