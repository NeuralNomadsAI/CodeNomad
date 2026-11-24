import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createRecordingController } from "./recording-controller.ts"
import type { RecordingControllerDeps, RecordingControllerCallbacks, StreamHandle } from "./recording-controller.ts"

function createMockStream(): StreamHandle & { tracksStopped: boolean } {
  return {
    getTracks: () => [{ stop: () => {} }],
    tracksStopped: false,
  }
}

interface Harness {
  deps: RecordingControllerDeps
  callbacks: RecordingControllerCallbacks & {
    states: string[]
    transcripts: string[]
    errors: { key: string; detail?: string }[]
  }
  recorder: { startCalled: boolean; stopCalled: boolean }
}

function createHarness(options?: {
  getUserMedia?: RecordingControllerDeps["getUserMedia"]
  setupRecorder?: RecordingControllerDeps["setupRecorder"]
  transcribe?: RecordingControllerDeps["transcribe"]
}): Harness {
  const recorder = { startCalled: false, stopCalled: false }

  const cbState = {
    states: [] as string[],
    transcripts: [] as string[],
    errors: [] as { key: string; detail?: string }[],
  }

  const callbacks = {
    ...cbState,
    onStateChange: (s: string) => cbState.states.push(s),
    onTranscript: (text: string) => cbState.transcripts.push(text),
    onError: (key: string, detail?: string) => cbState.errors.push({ key, detail }),
  }

  const deps: RecordingControllerDeps = {
    isElectron: () => false,
    requestMicAccess: async () => undefined,
    getUserMedia: options?.getUserMedia ?? (async () => createMockStream()),
    setupRecorder:
      options?.setupRecorder ??
      ((_stream, handlers) => ({
        start: () => {
          recorder.startCalled = true
          handlers.onDataAvailable(new Blob(["audio"], { type: "audio/webm" }))
        },
        stop: () => {
          recorder.stopCalled = true
          queueMicrotask(() => handlers.onStop())
        },
        mimeType: "audio/webm;codecs=opus",
      })),
    stopTracks: (stream) => {
      if (stream && "tracksStopped" in stream) {
        ;(stream as unknown as { tracksStopped: boolean }).tracksStopped = true
      }
    },
    blobToBase64: async () => "base64data",
    transcribe: options?.transcribe ?? (async () => ({ text: "hello world" })),
  }

  return { deps, callbacks, recorder }
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe("recording controller", () => {
  it("starts recording after getUserMedia resolves", async () => {
    let resolveGum!: (s: StreamHandle) => void
    const h = createHarness({
      getUserMedia: () => new Promise((r) => { resolveGum = r }),
    })

    const c = createRecordingController(h.deps, h.callbacks)

    const p = c.startRecording()
    assert.equal(c.getState(), "starting")

    resolveGum(createMockStream())
    await p

    assert.equal(c.getState(), "recording")
    assert.equal(h.recorder.startCalled, true)
    assert.deepEqual(h.callbacks.states, ["starting", "recording"])
  })

  it("cancels pending acquisition before getUserMedia resolves", async () => {
    let resolveGum!: (s: StreamHandle) => void
    const h = createHarness({
      getUserMedia: () => new Promise((r) => { resolveGum = r }),
    })

    const c = createRecordingController(h.deps, h.callbacks)

    const p = c.startRecording()
    c.cancelRecording()
    resolveGum(createMockStream())
    await p
    await flushPromises()

    assert.equal(c.getState(), "idle")
    assert.equal(h.recorder.startCalled, false)
  })

  it("stops the returned stream when cancelled before resolution", async () => {
    let resolveGum!: (s: StreamHandle) => void
    const h = createHarness({
      getUserMedia: () => new Promise((r) => { resolveGum = r }),
    })

    const c = createRecordingController(h.deps, h.callbacks)
    const p = c.startRecording()
    c.cancelRecording()

    const stream = createMockStream()
    resolveGum(stream)
    await p
    await flushPromises()

    assert.equal(stream.tracksStopped, true)
  })

  it("transcribes and reports transcript on normal stop", async () => {
    const stream = createMockStream()
    let attempts = 0
    const h = createHarness({ getUserMedia: async () => stream, transcribe: async (input, signal) => {
      attempts++
      assert.equal(input.mimeType, "audio/webm;codecs=opus")
      assert.equal(signal.aborted, false)
      return { text: "hello world" }
    } })
    const c = createRecordingController(h.deps, h.callbacks)

    await c.startRecording()
    assert.equal(c.getState(), "recording")

    c.stopRecording()
    assert.equal(stream.tracksStopped, true)
    await flushPromises()

    assert.deepEqual(h.callbacks.transcripts, ["hello world"])
    assert.equal(attempts, 1)
    assert.equal(c.getState(), "idle")
  })

  it("does not transcribe when no audio chunks collected", async () => {
    const h = createHarness({
      setupRecorder: (_stream, handlers) => ({
        start: () => {},
        stop: () => { queueMicrotask(() => handlers.onStop()) },
        mimeType: "audio/webm",
      }),
    })
    const c = createRecordingController(h.deps, h.callbacks)

    await c.startRecording()
    c.stopRecording()
    await flushPromises()

    assert.deepEqual(h.callbacks.transcripts, [])
    assert.equal(c.getState(), "idle")
  })

  it("allows next recording after cancelled start", async () => {
    let resolveGum1!: (s: StreamHandle) => void
    let firstCall = true
    const h = createHarness({
      getUserMedia: () => {
        if (firstCall) {
          firstCall = false
          return new Promise((r) => { resolveGum1 = r })
        }
        return Promise.resolve(createMockStream())
      },
    })

    const c = createRecordingController(h.deps, h.callbacks)
    const p = c.startRecording()
    c.cancelRecording()

    resolveGum1(createMockStream())
    await p
    await flushPromises()

    assert.equal(c.getState(), "idle")
    assert.equal(h.recorder.startCalled, false)

    await c.startRecording()
    assert.equal(c.getState(), "recording")
    assert.equal(h.recorder.startCalled, true)
  })

  it("prevents start while transcribing", async () => {
    let resolveTranscribe!: () => void
    const h = createHarness({
      transcribe: () => new Promise((r) => { resolveTranscribe = () => r({ text: "hello" }) }),
    })

    const c = createRecordingController(h.deps, h.callbacks)

    await c.startRecording()
    c.stopRecording()
    await flushPromises()

    assert.equal(c.getState(), "transcribing")

    await c.startRecording()
    assert.equal(c.getState(), "transcribing")

    resolveTranscribe()
    await flushPromises()
    assert.equal(c.getState(), "idle")
  })

  it("reports error when transcribe fails", async () => {
    const h = createHarness({
      transcribe: async () => { throw new Error("server error") },
    })

    const c = createRecordingController(h.deps, h.callbacks)

    await c.startRecording()
    c.stopRecording()
    await flushPromises()

    assert.equal(h.callbacks.errors.length, 1)
    assert.equal(h.callbacks.errors[0].key, "promptInput.voiceInput.error.transcribe")
    assert.equal(h.callbacks.errors[0].detail, "server error")
    assert.equal(c.getState(), "idle")
  })

  it("does not open the mic if native permission resolves after cancellation", async () => {
    const h = createHarness({ getUserMedia: async () => { assert.fail("permission resolved too late") } })
    let resolvePermission!: (result: { granted: boolean }) => void
    h.deps.isElectron = () => true
    h.deps.requestMicAccess = () => new Promise(r => { resolvePermission = r })
    const c = createRecordingController(h.deps, h.callbacks)
    const p = c.startRecording()
    c.cancelRecording()
    resolvePermission({ granted: true })
    await p

    assert.equal(h.recorder.startCalled, false)
    assert.deepEqual(h.callbacks.errors, [])
    assert.equal(c.getState(), "idle")
  })

  it("aborts the request and ignores a late result during cancellation", async () => {
    let resolveTranscribe!: () => void
    let requestSignal: AbortSignal | undefined
    const h = createHarness({
      transcribe: (_, signal) => new Promise((r) => {
        requestSignal = signal
        resolveTranscribe = () => r({ text: "stale" })
      }),
    })

    const c = createRecordingController(h.deps, h.callbacks)

    await c.startRecording()
    c.stopRecording()
    await flushPromises()

    assert.equal(c.getState(), "transcribing")

    c.cancelRecording()
    assert.equal(requestSignal?.aborted, true)
    resolveTranscribe()
    await flushPromises()

    assert.deepEqual(h.callbacks.transcripts, [])
    assert.deepEqual(h.callbacks.errors, [])
    assert.equal(c.getState(), "idle")
  })

  it("cancels during encoding without making a request", async () => {
    const h = createHarness({ transcribe: async () => { assert.fail("cancelled audio was sent") } })
    let finishEncoding!: (base64: string) => void
    h.deps.blobToBase64 = () => new Promise(resolve => { finishEncoding = resolve })
    const c = createRecordingController(h.deps, h.callbacks)
    await c.startRecording()
    c.stopRecording()
    await flushPromises()
    c.cancelRecording()
    finishEncoding("base64data")
    await flushPromises()
    assert.deepEqual(h.callbacks.transcripts, [])
    assert.deepEqual(h.callbacks.errors, [])
  })

  it("releases the mic and discards the recorder's final chunk on cancellation", async () => {
    const stream = createMockStream()
    const h = createHarness({ getUserMedia: async () => stream, transcribe: async () => { assert.fail("cancelled audio was sent") } })
    const c = createRecordingController(h.deps, h.callbacks)
    await c.startRecording()
    c.cancelRecording()
    assert.equal(stream.tracksStopped, true)
    assert.equal(h.recorder.stopCalled, true)
    await flushPromises()
    assert.deepEqual(h.callbacks.transcripts, [])
    assert.deepEqual(h.callbacks.errors, [])
    assert.deepEqual(h.callbacks.states, ["starting", "recording", "idle"])
  })

  it("keeps the excerpt after device loss and releases the microphone without uploading until confirmed", async () => {
    const stream = createMockStream()
    let ended!: () => void
    let attempts = 0
    let releases = 0
    const h = createHarness({
      getUserMedia: async () => stream,
      setupRecorder: (_stream, handlers) => {
        ended = handlers.onStop
        return { start: () => handlers.onDataAvailable(new Blob(["audio"])), stop: ended, mimeType: "audio/webm" }
      },
      transcribe: async () => { attempts++; return { text: "kept transcript" } },
    })
    h.deps.claimMicrophone = async () => ({ id: "lease", release: async () => { releases++ } })
    h.deps.blobToBase64 = async blob => {
      assert.equal(await blob.text(), "audio")
      return "base64data"
    }
    const c = createRecordingController(h.deps, h.callbacks)
    await c.startRecording()
    ended()
    await flushPromises()
    assert.equal(stream.tracksStopped, true)
    assert.deepEqual(h.callbacks.states, ["starting", "recording", "limitReached"])
    assert.deepEqual(h.callbacks.transcripts, [])
    assert.equal(releases, 1)
    assert.equal(attempts, 0)
    c.confirmTranscription()
    await flushPromises()
    assert.deepEqual(h.callbacks.transcripts, ["kept transcript"])
    assert.equal(attempts, 1)
  })

  it("keeps the final chunk delivered after a recorder error without uploading until confirmed", async () => {
    let handlers!: Parameters<RecordingControllerDeps["setupRecorder"]>[1]
    let uploads = 0
    const h = createHarness({
      setupRecorder: (_stream, callbacks) => {
        handlers = callbacks
        return { start() {}, stop() {}, mimeType: "audio/webm" }
      },
      transcribe: async () => { uploads++; return { text: "kept transcript" } },
    })
    h.deps.blobToBase64 = async blob => {
      assert.equal(await blob.text(), "recorded final")
      return "base64data"
    }
    const c = createRecordingController(h.deps, h.callbacks)
    await c.startRecording()
    handlers.onDataAvailable(new Blob(["recorded "]))
    handlers.onError()
    handlers.onDataAvailable(new Blob(["final"]))
    handlers.onStop()
    assert.equal(c.getState(), "limitReached")
    assert.equal(uploads, 0)
    c.confirmTranscription()
    await flushPromises()
    assert.deepEqual(h.callbacks.transcripts, ["kept transcript"])
    assert.equal(uploads, 1)
  })

  it("keeps an early WAV limit distinct from a normal stop and accepts confirmation only once", async () => {
    let endedAtLimit!: () => void
    let attempts = 0
    const h = createHarness({ transcribe: async () => { attempts++; return { text: "confirmed" } } })
    h.deps.capturePcm = async (_signal, _ended, limit) => {
      endedAtLimit = limit
      limit()
      return { finish: async () => new Blob(["audio"], { type: "audio/wav" }), release() {} }
    }
    const c = createRecordingController(h.deps, h.callbacks)
    await c.startRecording()
    c.stopRecording()
    assert.equal(c.getState(), "limitReached")
    assert.equal(attempts, 0)
    c.confirmTranscription()
    c.confirmTranscription()
    endedAtLimit()
    await flushPromises()
    assert.equal(attempts, 1)
    assert.deepEqual(h.callbacks.states, ["starting", "limitReached", "transcribing", "idle"])
    assert.deepEqual(h.callbacks.transcripts, ["confirmed"])
  })
})
