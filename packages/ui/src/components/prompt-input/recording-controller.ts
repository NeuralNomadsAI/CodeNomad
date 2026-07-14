export type RecordingState = "idle" | "recording" | "transcribing"

export interface StreamHandle {
  getTracks(): { stop(): void }[]
}

export interface RecorderHandle {
  start(): void
  stop(): void
  readonly mimeType: string
}

export interface RecordingControllerDeps {
  isElectron: () => boolean
  requestMicAccess: () => Promise<{ granted: boolean } | undefined>
  getUserMedia: () => Promise<StreamHandle>
  setupRecorder: (
    stream: StreamHandle,
    handlers: {
      onDataAvailable: (chunk: Blob) => void
      onStop: () => void
    },
  ) => RecorderHandle
  stopTracks: (stream: StreamHandle | null) => void
  blobToBase64: (blob: Blob) => Promise<string>
  transcribe: (input: { audioBase64: string; mimeType: string }) => Promise<{ text: string }>
  setInterval: (fn: () => void, ms: number) => number
  clearInterval: (id: number | undefined) => void
}

export interface RecordingControllerCallbacks {
  onStateChange: (state: RecordingState) => void
  onElapsedChange: (ms: number) => void
  onTranscript: (text: string) => void
  onError: (errorKey: string, detail?: string) => void
}

export function createRecordingController(
  deps: RecordingControllerDeps,
  callbacks: RecordingControllerCallbacks,
) {
  let state: RecordingState = "idle"
  let recorder: RecorderHandle | null = null
  let mediaStream: StreamHandle | null = null
  let timerId: number | undefined
  let recordedChunks: Blob[] = []
  let recordingStartedAt = 0
  let requestGeneration = 0

  function setState(next: RecordingState) {
    state = next
    callbacks.onStateChange(next)
  }

  function setElapsed(next: number) {
    callbacks.onElapsedChange(next)
  }

  function getState() {
    return state
  }

  function stopRecording() {
    if (state === "idle") {
      requestGeneration += 1
      return
    }
    if (state !== "recording" || !recorder) return
    recorder.stop()
    setState("transcribing")
    stopTimer()
  }

  async function startRecording() {
    if (state === "transcribing" || state === "recording") return

    const generation = ++requestGeneration

    try {
      recordedChunks = []

      if (deps.isElectron()) {
        const granted = await deps.requestMicAccess()
        if (generation !== requestGeneration) return
        if (granted && !granted.granted) {
          callbacks.onError("promptInput.voiceInput.error.permissionDenied")
          return
        }
      }

      const stream = await deps.getUserMedia()

      if (generation !== requestGeneration) {
        deps.stopTracks(stream)
        return
      }

      mediaStream = stream
      const rec = deps.setupRecorder(stream, {
        onDataAvailable: (chunk) => {
          if (generation !== requestGeneration) return
          if (chunk.size > 0) {
            recordedChunks.push(chunk)
          }
        },
        onStop: () => {
          if (generation === requestGeneration) {
            void finalizeRecording(generation)
          }
        },
      })
      recorder = rec

      recordingStartedAt = Date.now()
      setElapsed(0)
      setState("recording")
      startTimer()
      rec.start()
    } catch (error) {
      if (generation !== requestGeneration) return
      cleanupMedia(false)
      callbacks.onError(
        "promptInput.voiceInput.error.permission",
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  async function finalizeRecording(generation: number) {
    const rec = recorder
    const stream = mediaStream
    recorder = null
    mediaStream = null

    if (recordedChunks.length === 0) {
      recordedChunks = []
      deps.stopTracks(stream)
      setState("idle")
      setElapsed(0)
      return
    }

    const mimeType = rec?.mimeType || recordedChunks[0]?.type || "audio/webm"

    const audioBlob = new Blob(recordedChunks, { type: mimeType })
    recordedChunks = []
    deps.stopTracks(stream)

    try {
      const transcription = await deps.transcribe({
        audioBase64: await deps.blobToBase64(audioBlob),
        mimeType,
      })
      const text = transcription.text.trim()
      if (generation === requestGeneration && text) {
        callbacks.onTranscript(text)
      }
    } catch (error) {
      if (generation === requestGeneration) {
        callbacks.onError(
          "promptInput.voiceInput.error.transcribe",
          error instanceof Error ? error.message : String(error),
        )
      }
    } finally {
      if (generation === requestGeneration) {
        setState("idle")
        setElapsed(0)
      }
    }
  }

  function cleanupMedia(resetState = true) {
    requestGeneration += 1
    stopTimer()
    if (recorder) {
      recorder.stop()
    }
    recorder = null
    deps.stopTracks(mediaStream)
    mediaStream = null
    recordedChunks = []
    if (resetState) {
      setState("idle")
      setElapsed(0)
    }
  }

  function startTimer() {
    stopTimer()
    timerId = deps.setInterval(() => {
      setElapsed(Date.now() - recordingStartedAt)
    }, 250)
  }

  function stopTimer() {
    if (timerId !== undefined) {
      deps.clearInterval(timerId)
      timerId = undefined
    }
  }

  return {
    getState,
    startRecording,
    stopRecording,
    cleanup: cleanupMedia,
  }
}
