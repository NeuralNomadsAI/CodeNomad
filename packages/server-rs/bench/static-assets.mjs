import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { brotliCompressSync, gzipSync } from "node:zlib"

const assets = {
  "index.html": { text: "<!doctype html><title>Static fixture</title>", mime: "text/html", br: true, gzip: true },
  "bundle.js": { text: "// Static fixture\n".repeat(100), mime: "application/javascript", br: true, gzip: true },
  "app_bg.wasm": { text: "\0asm\u0001\0\0\0" + "\0".repeat(1024), mime: "application/wasm", br: true, gzip: true },
  "theme.css": { text: "/* Static fixture */\n".repeat(100), mime: "text/css", gzip: true },
  "manifest.webmanifest": { text: '{"name":"Fixture"}', mime: "application/manifest+json" },
}
const compressors = { br: brotliCompressSync, gzip: gzipSync }

export async function ui(root) {
  const folder = path.join(root, "static-fixture")
  await mkdir(folder)
  for (const [file, asset] of Object.entries(assets)) {
    await writeFile(path.join(folder, file), asset.text)
    for (const [coding, suffix] of [["br", "br"], ["gzip", "gz"]]) {
      if (asset[coding]) await writeFile(path.join(folder, `${file}.${suffix}`), compressors[coding](asset.text))
    }
  }
  return folder
}

export async function run({ call, origin }) {
  const observed = []
  for (const [route, accept, coding] of [
    ["/", "br, gzip", "br"],
    ["/index.html", "gzip", "gzip"],
    ["/a-spa-route", "br, identity;q=0", "br"],
    ["/bundle.js", "br,gzip", "br"],
    ["/app_bg.wasm", "gzip, br", "br"],
    ["/app_bg.wasm", "br;q=0, gzip", "gzip"],
    ["/app_bg.wasm", "br;q=0.2, gzip;q=0.8", "gzip"],
    ["/app_bg.wasm", "gzip;q=0, *;q=1, identity;q=0", "br"],
    ["/app_bg.wasm", "identity", "identity"],
    ["/app_bg.wasm", "identity;q=1, br;q=0.1", "identity"],
    ["/app_bg.wasm", "*", "br"],
    ["/theme.css", "br, gzip", "gzip"],
    ["/manifest.webmanifest", "br, gzip", "identity"],
  ]) {
    const { mime, text } = assets[route.slice(1)] ?? assets["index.html"]
    const headers = { "accept-encoding": accept }
    const expectedLength = compressors[coding]?.(text).length ?? Buffer.byteLength(text)
    const get = await call(route, { headers })
    const head = await call(route, { method: "HEAD", headers })
    for (const response of [get, head]) {
      assert.equal(response.status, 200, `${route}: ${accept}`)
      assert.equal(response.headers.get("content-encoding") ?? "identity", coding, `${route}: ${accept}`)
      assert.match(response.headers.get("vary"), /(?:^|,\s*)accept-encoding(?:,|$)/i)
      const mediaType = response.headers.get("content-type").split(";")[0]
      assert.equal(mediaType, mime)
      assert.equal(Number(response.headers.get("content-length")), expectedLength)
      if (mime === "text/html") assert.equal(response.headers.get("cache-control"), "no-store")
    }
    assert.deepEqual(Buffer.from(await get.arrayBuffer()), Buffer.from(text))
    assert.equal((await head.arrayBuffer()).byteLength, 0)
    const etag = get.headers.get("etag")
    assert(etag)
    const unchanged = await call(route, { headers: { ...headers, "if-none-match": etag, "cache-control": "max-age=0" } })
    assert.equal(unchanged.status, 304, `${route}: ${accept}`)
    assert.match(unchanged.headers.get("vary"), /(?:^|,\s*)accept-encoding(?:,|$)/i)
    assert.equal((await unchanged.arrayBuffer()).byteLength, 0)
    observed.push({ route, accept, coding, bytes: expectedLength })
  }
  const headers = { "accept-encoding": "br, identity;q=0" }
  for (const method of ["GET", "HEAD"]) {
    const response = await call("/theme.css", { method, headers })
    assert.equal(response.status, 406)
    assert.match(response.headers.get("vary"), /(?:^|,\s*)accept-encoding(?:,|$)/i)
    assert.equal((await response.arrayBuffer()).byteLength, 0)
  }
  for (const [route, status] of [["/bundle.js", 200], ["/index.html.br", 302], ["/absent.js", 404]]) {
    const response = await fetch(origin + route, { redirect: "manual", headers: { "accept-encoding": "br" } })
    assert.equal(response.status, status, route)
    if (status === 302) assert.equal(response.headers.get("location"), "/login")
    await response.arrayBuffer()
  }
  return observed
}
