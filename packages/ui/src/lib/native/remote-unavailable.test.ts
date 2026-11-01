import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { remoteUnavailableToken, REMOTE_UNAVAILABLE_HASH } from "./remote-unavailable"

describe("remote unavailable page", () => {
  it("reads the recovery token of the loading page only", () => {
    assert.equal(remoteUnavailableToken(`file:///C:/app/dist/renderer/loading.html#${REMOTE_UNAVAILABLE_HASH}=abc`), "abc")
    assert.equal(remoteUnavailableToken(`http://localhost:5173/loading.html#${REMOTE_UNAVAILABLE_HASH}=abc`), "abc")
    assert.equal(remoteUnavailableToken(`file:///C:/app/dist/renderer/loading.html#${REMOTE_UNAVAILABLE_HASH}`), null)
    assert.equal(remoteUnavailableToken(`file:///C:/app/dist/renderer/loading.html#${REMOTE_UNAVAILABLE_HASH}=`), null)
    assert.equal(remoteUnavailableToken("file:///C:/app/dist/renderer/loading.html"), null)
    assert.equal(remoteUnavailableToken(`https://remote.example/#${REMOTE_UNAVAILABLE_HASH}=abc`), null)
    assert.equal(remoteUnavailableToken("not a url"), null)
  })
})
