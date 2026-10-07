import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import test from "node:test"
import { streamToMediaSource } from "./audio-utils"

test("audio streaming preserves append order, playback timing, completion and failures", async () => {
  for (const scenario of ["complete", "no-complete", "append-error", "play-error", "read-error"] as const) {
    const events: string[] = []
    const errors: unknown[] = []
    const failure = new Error(scenario)
    let errorMessageReads = 0

    class SyntheticSourceBuffer extends EventTarget {
      updating = false

      appendBuffer(buffer: ArrayBuffer) {
        assert.equal(this.updating, false, "appends must not overlap")
        events.push(`append:${[...new Uint8Array(buffer)]}`)
        this.updating = true
        queueMicrotask(() => {
          this.updating = false
          if (scenario === "append-error") {
            this.dispatchEvent(new Event("error"))
          }
          events.push("updateend")
          this.dispatchEvent(new Event("updateend"))
        })
      }
    }

    const sourceBuffer = new SyntheticSourceBuffer()
    const mediaSource = {
      readyState: "open",
      addSourceBuffer(mimeType: string) {
        assert.equal(mimeType, "audio/mpeg")
        return sourceBuffer
      },
      endOfStream() {
        assert.equal(sourceBuffer.updating, false)
        events.push("end")
      },
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (scenario === "read-error") {
          controller.error(failure)
          return
        }
        controller.enqueue(new Uint8Array())
        controller.enqueue(new Uint8Array([0, 1, 2, 0]).subarray(1, 3))
        controller.enqueue(new Uint8Array([3]))
        controller.close()
      },
    })

    await streamToMediaSource({
      mediaSource: mediaSource as unknown as MediaSource,
      stream,
      mimeType: "audio/mpeg",
      onPlayable: async () => {
        events.push("play")
        if (scenario === "play-error") throw failure
      },
      onComplete: scenario === "no-complete" ? undefined : () => {
        events.push("complete")
      },
      onError: (error) => {
        errors.push(error)
      },
      appendErrorMessage: () => {
        errorMessageReads += 1
        return "Échec de la génération audio"
      },
    })

    if (scenario === "complete" || scenario === "no-complete") {
      assert.deepEqual(events, [
        "append:1,2",
        "updateend",
        "play",
        "append:3",
        "updateend",
        "end",
        ...(scenario === "complete" ? ["complete"] : []),
      ])
      assert.deepEqual(errors, [])
    } else {
      assert.equal(errors.length, 1)
      if (scenario === "append-error") {
        assert.equal((errors[0] as Error).message, "Échec de la génération audio")
        assert.deepEqual(events, ["append:1,2", "updateend"])
      } else {
        assert.equal(errors[0], failure)
        assert.deepEqual(events, scenario === "play-error" ? ["append:1,2", "updateend", "play"] : [])
      }
    }
    assert.equal(errorMessageReads, scenario === "append-error" ? 1 : 0)
    assert.equal(getEventListeners(sourceBuffer, "updateend").length, 0)
    assert.equal(getEventListeners(sourceBuffer, "error").length, 0)
  }
})
