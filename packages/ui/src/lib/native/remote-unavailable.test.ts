import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { isRemoteUnavailablePage, REMOTE_UNAVAILABLE_HASH } from "./remote-unavailable"

describe("remote unavailable page", () => {
  it("is only the loading page carrying the remote-unavailable fragment", () => {
    assert.equal(isRemoteUnavailablePage(`file:///C:/app/dist/renderer/loading.html#${REMOTE_UNAVAILABLE_HASH}`), true)
    assert.equal(isRemoteUnavailablePage(`http://localhost:5173/loading.html#${REMOTE_UNAVAILABLE_HASH}`), true)
    // The ordinary loading screen and the server's own pages never get the recovery actions.
    assert.equal(isRemoteUnavailablePage("file:///C:/app/dist/renderer/loading.html"), false)
    assert.equal(isRemoteUnavailablePage(`https://remote.example/#${REMOTE_UNAVAILABLE_HASH}`), false)
    assert.equal(isRemoteUnavailablePage(`https://remote.example/loading.html?x=1#other`), false)
    assert.equal(isRemoteUnavailablePage("not a url"), false)
  })
})
