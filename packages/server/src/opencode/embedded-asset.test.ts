import assert from "node:assert/strict"
import { test } from "node:test"
import { ASSET_URI_LIMIT, isEmbeddedAsset } from "./session-pruning/assets-contract"
import { embeddedImage } from "./embedded-asset"

test("embedded assets bound the complete URI and require canonical base64 including padding bits", () => {
  const asset = (body: string, mime = "text/plain") => ({ mime, uri: `data:${mime};base64,${body}` })
  for (const body of ["YQ==", "YWI=", "YWJj", "AA==", "AAA="]) assert(isEmbeddedAsset(asset(body)))
  for (const body of ["", "YQ", "YQ===", "YR==", "YWJ=", "YQ==\n", "YQ-_", "=AAA"]) assert.equal(isEmbeddedAsset(asset(body)), false, body)
  for (const value of [asset("YQ==", "text/plain;x=y"), { mime: "text/plain", uri: "data:text/html;base64,YQ==" }, asset("A".repeat(ASSET_URI_LIMIT))]) assert.equal(isEmbeddedAsset(value), false)
  const header = "data:text/plain;base64,"
  const body = "A".repeat(Math.floor((ASSET_URI_LIMIT - header.length) / 4) * 4)
  assert(isEmbeddedAsset({ mime: "text/plain", uri: header + body }))
  assert.equal(isEmbeddedAsset({ mime: "text/plain", uri: header + body + "AAAA" }), false)
})

test("seven passive raster signatures retain canonical image MIME; active and mismatched bytes fail", () => {
  const cases: Array<[string, Buffer]> = [
    ["image/png", Buffer.from([137,80,78,71,13,10,26,10])],
    ["image/jpeg", Buffer.from([255,216,255])], ["image/gif", Buffer.from("GIF89a")],
    ["image/webp", Buffer.from("RIFFxxxxWEBP")], ["image/bmp", Buffer.concat([Buffer.from("BM"), Buffer.alloc(24)])],
    ["image/x-icon", Buffer.from([0,0,1,0,1,0,...Array(16).fill(0)])],
    ["image/avif", Buffer.from([0,0,0,16,...Buffer.from("ftypavif"),0,0,0,0])],
  ]
  for (const [mime, bytes] of cases) assert.deepEqual(embeddedImage({ mime, uri: `data:${mime};base64,${bytes.toString("base64")}` }), { mime, bytes })
  for (const mime of ["image/png", "image/svg+xml", "text/html"]) assert.equal(embeddedImage({ mime, uri: `data:${mime};base64,${Buffer.from("<svg/>").toString("base64")}` }), undefined)
})
