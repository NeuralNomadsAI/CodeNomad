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
    onElapsedChange: () => {},
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
    setInterval: () => 0,
    clearInterval: () => {},
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
    assert.equal(c.getState(), "idle")

    resolveGum(createMockStream())
    await p

    assert.equal(c.getState(), "recording")
    assert.equal(h.recorder.startCalled, true)
    assert.deepEqual(h.callbacks.states, ["recording"])
  })

  it("cancels pending acquisition when stopped before getUserMedia resolves", async () => {
    let resolveGum!: (s: StreamHandle) => void
    const h = createHarness({
      getUserMedia: () => new Promise((r) => { resolveGum = r }),
    })

    const c = createRecordingController(h.deps, h.callbacks)

    const p = c.startRecording()
    c.stopRecording()
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
    c.stopRecording()

    const stream = createMockStream()
    resolveGum(stream)
    await p
    await flushPromises()

    assert.equal(stream.tracksStopped, true)
  })

  it("transcribes and reports transcript on normal stop", async () => {
    const h = createHarness()
    const c = createRecordingController(h.deps, h.callbacks)

    await c.startRecording()
    assert.equal(c.getState(), "recording")

    c.stopRecording()
    await flushPromises()

    assert.deepEqual(h.callbacks.transcripts, ["hello world"])
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
    c.stopRecording()

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

  it("increments generation on cleanup, invalidating pending requests", async () => {
    let resolveGum!: (s: StreamHandle) => void
    const h = createHarness({
      getUserMedia: () => new Promise((r) => { resolveGum = r }),
    })

    const c = createRecordingController(h.deps, h.callbacks)

    const p = c.startRecording()
    c.cleanup(false)
    resolveGum(createMockStream())
    await p
    await flushPromises()

    assert.equal(h.recorder.startCalled, false)
    assert.equal(c.getState(), "idle")
  })

  it("skips transcript for stale generation after cleanup during transcription", async () => {
    let resolveTranscribe!: () => void
    const h = createHarness({
      transcribe: () => new Promise((r) => { resolveTranscribe = () => r({ text: "stale" }) }),
    })

    const c = createRecordingController(h.deps, h.callbacks)

    await c.startRecording()
    c.stopRecording()
    await flushPromises()

    assert.equal(c.getState(), "transcribing")

    c.cleanup(true)
    resolveTranscribe()
    await flushPromises()

    assert.deepEqual(h.callbacks.transcripts, [])
    assert.equal(c.getState(), "idle")
  })
})
