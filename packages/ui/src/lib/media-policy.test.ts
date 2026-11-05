import assert from "node:assert/strict"
import { test } from "node:test"
import { ASSET_URI_LIMIT, isEmbeddedAsset } from "../../../server/src/opencode/embedded-asset"
import { parseSessionMediaPath } from "../../../server/src/opencode/session-media-contract"
import { authorizedMediaSource, authorizedImageUri, type MediaPolicy } from "./media-policy"

const image = { uri: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png" }
const path = `/api/workspaces/a/session-media/s/m/0/1/${"f".repeat(64)}`
const policy: MediaPolicy = { kind: "explicit", instanceId: "a", sessionId: "s", current: true, nativeMedia: [{ ...image, uri: path }] }

test("bounded embedded assets validate MIME, alphabet, padding and unused bits before decoding", () => {
  assert.equal(isEmbeddedAsset(image), true)
  for (const uri of ["data:image/png;base64,", "data:image/png;base64,broken", "data:image/png;base64,AA=A", "data:image/png;base64,AB==", "data:image/png;base64,AAB=", "data:image/png;base64,A===", "data:image/png;base64,AA-_", "data:image/png;base64,AA==\n", "data:image/jpeg;base64,AA=="]) {
    assert.equal(isEmbeddedAsset({ ...image, uri }), false, uri)
  }
  // Pick a syntactically valid MIME whose header makes the complete limit reachable.
  const mime = "image/a", exactPrefix = `data:${mime};base64,`
  assert.equal(exactPrefix.length % 4, ASSET_URI_LIMIT % 4)
  const exact = exactPrefix + "A".repeat(ASSET_URI_LIMIT - exactPrefix.length)
  assert.equal(isEmbeddedAsset({ mime, uri: exact }), true)
  assert.equal(isEmbeddedAsset({ mime, uri: exact + "A" }), false)
})

test("explicit content permits only held bytes and exact same-owner native references", () => {
  assert.equal(authorizedMediaSource(image, policy), image.uri)
  assert.equal(authorizedMediaSource({ ...image, uri: path }, policy, "https://host/prefix/"), `https://host/prefix${path}`)
  assert.equal(authorizedImageUri(`https://host/prefix${path}`, policy, "https://host/prefix"), `https://host/prefix${path}`)
  for (const uri of ["https://remote/image.png", "http://127.0.0.1/image.png", "//remote/image.png", "blob:owned-by-someone-else", "file:///tmp/a", "\\\\host\\share", "/tmp/a", path + "?secret=1", path + "#a", path.replace("/s/", "/other/"), path.replace("/a/", "/b/"), path.replace("/m/", "/%6D/"), path.replace("/0/1/", "/00/1/"), path.replace("/m/", "/%2e%2e/"), path.replace("/m/", "/%252F/"), path.replace("/m/", "/%5C/"), path.replace("/m/", "/%2F/"), path.replace("/m/", "/m%3F/"), path.replace("/api/", "/API/")]) {
    assert.equal(authorizedMediaSource({ ...image, uri }, policy), undefined, uri)
  }
  for (const changed of [{ ...policy, instanceId: "b" }, { ...policy, sessionId: "other" }, { ...policy, current: false }, { ...policy, nativeMedia: [] }]) assert.equal(authorizedMediaSource({ ...image, uri: path }, changed), undefined)
  assert.equal(authorizedMediaSource({ mime: "image/svg+xml", uri: "data:image/svg+xml;base64,PHN2Zz4=" }, policy), undefined)
  assert.equal(authorizedMediaSource({ mime: "text/html", uri: "data:text/html;base64,PHN2Zz4=" }, policy), undefined)
  assert.equal(authorizedMediaSource({ mime: "application/pdf", uri: "data:application/pdf;base64,AA==" }, policy, undefined, false), "data:application/pdf;base64,AA==")
  assert.equal(authorizedMediaSource(image, { kind: "unknown" }), image.uri)
  assert.equal(authorizedMediaSource({ ...image, uri: path }, { kind: "unknown" }), undefined)
  assert.equal(authorizedMediaSource({ ...image, uri: "https://example.test/image" }, { kind: "local" }), "https://example.test/image")
})

test("native references retain canonical Unicode and exact digest spelling", () => {
  const unicode = path.replace("/m/", `/${encodeURIComponent("été猫")}/`)
  assert.equal(parseSessionMediaPath(unicode)?.messageId, "été猫")
  assert.equal(parseSessionMediaPath(unicode.replace("%C3", "%c3")), undefined)
  assert.equal(parseSessionMediaPath(path.replace("f".repeat(64), "F".repeat(64))), undefined)
})
