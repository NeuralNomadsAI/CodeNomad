import assert from "node:assert/strict"
import { test } from "node:test"
import { assertThumbnailBounds } from "./image-bounds"

function png(width: number, height: number) {
  const bytes = new Uint8Array(33), data = new DataView(bytes.buffer)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); data.setUint32(8, 13)
  bytes.set([73, 72, 68, 82], 12); data.setUint32(16, width); data.setUint32(20, height)
  return bytes
}
function jpeg(width: number, height: number, marker = 192) {
  return Uint8Array.from([255, 216, 255, marker, 0, 8, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 255, 218])
}
function gif(width: number, height: number) {
  return Uint8Array.from([71, 73, 70, 56, 57, 97, width & 255, width >> 8, height & 255, height >> 8, 0, 0, 0,
    44, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, 0, 2, 1, 0, 0, 59])
}
function webp(kind: string, payload: number[]) {
  const bytes = new Uint8Array(20 + payload.length + (payload.length & 1)), data = new DataView(bytes.buffer)
  bytes.set([..."RIFF"].map(char => char.charCodeAt(0))); data.setUint32(4, bytes.length - 8, true)
  bytes.set([..."WEBP" + kind].map(char => char.charCodeAt(0)), 8); data.setUint32(16, payload.length, true); bytes.set(payload, 20)
  return bytes
}

test("thumbnail admission bounds encoded pixels before browser decoding; ambiguous formats fail closed", () => {
  for (const bytes of [png(8, 800), png(800, 8), png(2048, 2048)]) assertThumbnailBounds(bytes, "image/png")
  for (const bytes of [png(0, 1), png(8193, 1), png(4096, 4096), png(8, 800).slice(0, 25)]) assert.throws(() => assertThumbnailBounds(bytes, "image/png"))
  const wrong = png(8, 800); wrong[0] = 0; assert.throws(() => assertThumbnailBounds(wrong, "image/png"))
  for (const marker of [192, 193, 194]) assertThumbnailBounds(jpeg(800, 600, marker), "image/jpeg")
  for (const bytes of [jpeg(0, 1), jpeg(8193, 1), jpeg(4096, 4096), jpeg(800, 600, 195), jpeg(800, 600).slice(0, 6)]) assert.throws(() => assertThumbnailBounds(bytes, "image/jpeg"))
  assertThumbnailBounds(gif(100, 100), "image/gif")
  const outside = gif(100, 100); outside[14] = 1; assert.throws(() => assertThumbnailBounds(outside, "image/gif"))
  const many = gif(2048, 2048), second = new Uint8Array(many.length * 2 - 14)
  second.set(many.slice(0, -1)); second.set(many.slice(13), many.length - 1)
  assert.throws(() => assertThumbnailBounds(second, "image/gif"))
  assert.throws(() => assertThumbnailBounds(gif(100, 100).slice(0, -2), "image/gif"))
  assertThumbnailBounds(webp("VP8 ", [0, 0, 0, 157, 1, 42, 100, 0, 100, 0]), "image/webp")
  assertThumbnailBounds(webp("VP8L", [47, 0, 0, 0, 0]), "image/webp")
  assert.throws(() => assertThumbnailBounds(webp("VP8L", [47, 0, 0, 0, 224]), "image/webp"))
  assert.throws(() => assertThumbnailBounds(webp("VP8 ", [0, 0, 0, 157, 1, 42, 255, 63, 255, 63]), "image/webp"))
  assert.throws(() => assertThumbnailBounds(webp("ANMF", []), "image/webp"))
  assert.throws(() => assertThumbnailBounds(png(100, 100), "image/avif"))
  assert.throws(() => assertThumbnailBounds(png(100, 100), "image/jpeg"))
})
