import assert from "node:assert/strict"
import { test } from "node:test"
import { passiveImageType } from "./passive-image"

const ascii = (value: string) => new TextEncoder().encode(value)
test("only the closed passive image signatures receive canonical MIME types", () => {
  const bmp = new Uint8Array(26); bmp.set(ascii("BM"))
  const ico = new Uint8Array(22); ico.set([0, 0, 1, 0, 1, 0])
  const avif = new Uint8Array(24); avif.set([0, 0, 0, 24]); avif.set(ascii("ftypmif1"), 4); avif.set(ascii("avif"), 16)
  for (const [bytes, type] of [
    [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), "image/png"],
    [new Uint8Array([255, 216, 255]), "image/jpeg"],
    [ascii("GIF87a"), "image/gif"], [ascii("GIF89a"), "image/gif"],
    [ascii("RIFFxxxxWEBP"), "image/webp"], [bmp, "image/bmp"], [ico, "image/x-icon"], [avif, "image/avif"],
  ] as const) assert.equal(passiveImageType(bytes), type)
  assert.equal(passiveImageType(avif.subarray(0, 20)), undefined, "ftyp must fit the body")
  avif.set(ascii("heic"), 16)
  assert.equal(passiveImageType(avif), undefined, "unlisted ISO image brands stay closed")
  ico[4] = 0
  assert.equal(passiveImageType(ico), undefined)
  for (const value of ["", "<html><script>alert(1)</script>", '<svg xmlns="http://www.w3.org/2000/svg"/>',
    "<?xml version='1.0'?><svg/>", "%PDF-1.7", "PNG", "GIF89", "RIFFxxxxHTML", "BM"]) {
    assert.equal(passiveImageType(ascii(value)), undefined, value)
  }
})
