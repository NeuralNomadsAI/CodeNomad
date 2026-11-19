export type RecordingState = "idle" | "starting" | "recording" | "limitReached" | "transcribing"

export interface VoiceInputController {
  startRecording(): Promise<void>
  stopRecording(): void
  confirmTranscription?(): void
  cancelRecording(): void
}

export interface VoiceInputEngine {
  canStart(): boolean
  /** Creating a controller must not acquire the microphone. */
  createController(callbacks: RecordingControllerCallbacks): VoiceInputController
}

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
  claimMicrophone?: (signal: AbortSignal) => Promise<{ id: string; release(): Promise<void> }>
  authorize?: () => Promise<boolean>
  microphoneErrorKey?: (error: unknown) => string
  requestMicAccess: () => Promise<{ granted: boolean } | undefined>
  getUserMedia: (signal: AbortSignal, leaseId?: string) => Promise<StreamHandle>
  capturePcm?: (signal: AbortSignal, ended: () => void, limit: () => void, leaseId?: string) => Promise<{
    finish(): Promise<Blob>
    release(): void
  }>
  setupRecorder: (
    stream: StreamHandle,
    handlers: {
      onDataAvailable: (chunk: Blob) => void
      onStop: () => void
      onError: () => void
    },
  ) => RecorderHandle
  stopTracks: (stream: StreamHandle | null) => void
  blobToBase64: (blob: Blob) => Promise<string>
  transcribe: (input: { audioBase64: string; mimeType: string }, signal: AbortSignal) => Promise<{ text: string }>
}

export interface RecordingControllerCallbacks {
  onStateChange: (state: RecordingState) => void
  /** The terminal result or error comes before returning to idle. */
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
  let recordedChunks: Blob[] = []
  let capture: AbortController | undefined
  let closeMicrophone: (() => void) | undefined
  let pcm: Awaited<ReturnType<NonNullable<RecordingControllerDeps["capturePcm"]>>> | undefined

  function setState(next: RecordingState) {
    state = next
    callbacks.onStateChange(next)
  }

  function getState() {
    return state
  }

  function releaseMicrophone() {
    const close = closeMicrophone
    closeMicrophone = undefined
    close?.()
  }

  function stopRecording() {
    if (state !== "recording" || !capture) return
    if (pcm) {
      finishPcm(capture, pcm)
      return
    }
    if (!recorder) return
    setState("transcribing")
    const stream = mediaStream
    const rec = recorder
    mediaStream = null
    try {
      rec.stop()
    } catch (error) {
      reportError("promptInput.voiceInput.error.transcribe", error)
      cancelRecording()
    } finally {
      deps.stopTracks(stream)
      releaseMicrophone()
    }
  }

  function finishPcm(operation: AbortController, source: NonNullable<typeof pcm>) {
    setState("transcribing")
    const close = closeMicrophone
    closeMicrophone = undefined
    void transcribe(operation, async () => {
      try { return await source.finish() } finally { close?.() }
    })
  }

  function confirmTranscription() {
    if (state === "limitReached" && capture && pcm) finishPcm(capture, pcm)
  }

  async function startRecording() {
    if (capture) return

    const operation = capture = new AbortController()
    const { signal } = operation
    const cancelCurrent = () => { if (capture === operation) cancelRecording() }
    setState("starting")

    let lease: Awaited<ReturnType<NonNullable<RecordingControllerDeps["claimMicrophone"]>>> | undefined
    try {
      if (deps.claimMicrophone) lease = await deps.claimMicrophone(signal)
      if (signal.aborted) return
      if (deps.authorize && !await deps.authorize()) { cancelCurrent(); return }
      if (signal.aborted) return
      if (deps.isElectron()) {
        const granted = await deps.requestMicAccess()
        if (signal.aborted) return
        if (granted && !granted.granted) {
          callbacks.onError("promptInput.voiceInput.error.permissionDenied")
          cancelRecording()
          return
        }
      }

      if (deps.capturePcm) {
        let limited = false
        const source = await deps.capturePcm(signal, cancelCurrent, () => {
          if (signal.aborted) return
          limited = true
          if (state === "recording") {
            releaseMicrophone()
            setState("limitReached")
          }
        }, lease?.id)
        if (signal.aborted) { source.release(); return }
        pcm = source
        setState(limited ? "limitReached" : "recording")
        return
      }

      const stream = await deps.getUserMedia(signal, lease?.id)

      if (signal.aborted) {
        deps.stopTracks(stream)
        return
      }

      mediaStream = stream
      const rec = deps.setupRecorder(stream, {
        onDataAvailable: (chunk) => {
          if (signal.aborted) return
          if (chunk.size > 0) {
            recordedChunks.push(chunk)
          }
        },
        onStop: () => {
          if (signal.aborted || !recorder) return
          if (state === "transcribing") void finalizeRecording(operation)
          else cancelRecording()
        },
        onError: cancelCurrent,
      })
      recorder = rec

      rec.start()
      setState("recording")
    } catch (error) {
      if (signal.aborted) return
      const fallback = "promptInput.voiceInput.error.permission"
      const key = deps.microphoneErrorKey?.(error) ?? fallback
      if (key === fallback) reportError(key, error)
      else callbacks.onError(key)
      cancelRecording()
    } finally {
      const close = () => { void lease?.release().catch(() => {}) }
      if (capture === operation && state === "recording") closeMicrophone = close
      else close()
    }
  }

  async function finalizeRecording(operation: AbortController) {
    const rec = recorder
    const stream = mediaStream
    recorder = null
    mediaStream = null
    const chunks = recordedChunks
    recordedChunks = []
    deps.stopTracks(stream)
    await transcribe(operation, async () => chunks.length ? new Blob(chunks, {
      type: rec?.mimeType || chunks[0]?.type || "audio/webm",
    }) : undefined)
  }

  async function transcribe(operation: AbortController, getAudio: () => Promise<Blob | undefined>) {
    const { signal } = operation
    try {
      const audio = await getAudio()
      if (signal.aborted || !audio) return
      const audioBase64 = await deps.blobToBase64(audio)
      if (signal.aborted) return
      const transcription = await deps.transcribe({ audioBase64, mimeType: audio.type }, signal)
      const text = transcription.text.trim()
      if (!signal.aborted) {
        callbacks.onTranscript(text)
      }
    } catch (error) {
      if (!signal.aborted) {
        reportError("promptInput.voiceInput.error.transcribe", error)
      }
    } finally {
      if (capture === operation) {
        pcm?.release()
        pcm = undefined
        capture = undefined
        setState("idle")
      }
    }
  }

  function cancelRecording() {
    if (!capture) return
    const operation = capture
    capture = undefined
    operation.abort()
    pcm?.release()
    pcm = undefined
    const rec = recorder
    const stream = mediaStream
    recorder = null
    mediaStream = null
    recordedChunks = []
    try {
      rec?.stop()
    } catch {
      // Releasing the stream also stops a recorder that rejects stop().
    } finally {
      deps.stopTracks(stream)
      releaseMicrophone()
      setState("idle")
    }
  }

  function reportError(key: string, error: unknown) {
    callbacks.onError(key, error instanceof Error ? error.message : String(error))
  }

  return {
    getState,
    startRecording,
    stopRecording,
    confirmTranscription,
    cancelRecording,
  } satisfies VoiceInputController & { getState: () => RecordingState }
}
