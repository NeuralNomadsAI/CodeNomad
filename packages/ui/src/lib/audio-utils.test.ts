import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import test from "node:test"
import { streamToMediaSource } from "./audio-utils"

test("audio streaming preserves append order and releases the stream and listeners on failure or cancellation", async () => {
  for (const scenario of ["complete", "append-error", "read-error", "cancel-append"] as const) {
    const events: string[] = []
    const failure = new Error(scenario)
    const lifetime = new AbortController()
    class SyntheticSourceBuffer extends EventTarget {
      updating = false

      appendBuffer(buffer: ArrayBuffer) {
        assert.equal(this.updating, false)
        events.push(`append:${[...new Uint8Array(buffer)]}`)
        this.updating = true
        queueMicrotask(() => {
          if (scenario === "cancel-append") { lifetime.abort(failure); return }
          this.updating = false
          if (scenario === "append-error") this.dispatchEvent(new Event("error"))
          events.push("updateend")
          this.dispatchEvent(new Event("updateend"))
        })
      }
    }
    const source = new SyntheticSourceBuffer()
    const media = {
      readyState: "open",
      addSourceBuffer(mime: string) { assert.equal(mime, "audio/mpeg"); return source },
      endOfStream() { assert.equal(source.updating, false); events.push("end") },
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (scenario === "read-error") { controller.error(failure); return }
        controller.enqueue(new Uint8Array())
        controller.enqueue(new Uint8Array([0, 1, 2, 0]).subarray(1, 3))
        controller.enqueue(new Uint8Array([3]))
        controller.close()
      },
    })
    const result = streamToMediaSource(media as unknown as MediaSource, stream, "audio/mpeg", lifetime.signal, () => {
      events.push("play")
    }, () => failure)
    if (scenario === "complete") await result
    else await assert.rejects(result, error => error === failure)
    assert.deepEqual(events, {
      complete: ["append:1,2", "updateend", "play", "append:3", "updateend", "end"],
      "append-error": ["append:1,2", "updateend"],
      "read-error": [],
      "cancel-append": ["append:1,2"],
    }[scenario])
    assert.equal(stream.locked, false)
    assert.equal(getEventListeners(source, "updateend").length, 0)
    assert.equal(getEventListeners(source, "error").length, 0)
  }
})
