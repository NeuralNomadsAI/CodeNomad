# Desktop dictation

`packages/desktop-speech/contract.ts` defines the renderer wire contract for both hosts; the Rust adapter runs the same request validation vectors. The renderer uses `packages/ui/src/lib/native/device-speech.ts`. API remains the default when the local choice is absent; the existing server speech settings, capture and provider path own API mode. Requests carry no project IDs, credentials, URLs or file paths. Only the owning renderer can finish a Hex operation with its bounded in-memory PCM WAV.

## Authority and persistence

- Electron validates the registered main frame and configured local origin. Tauri uses a command ACL on primary app webviews plus native registry, window and exact origin checks. Preferences can select an installed engine or confirm Hex preparation; local composer and trusted dictation windows can start native dictation. A project displayed by a local renderer uses the same device contract whether its project runs on the host or in WSL.
- `device-speech/choice.json` in the shared CodeNomad application data base holds the versioned choice and revision, independently of profile, server config and window restoration. Writes replace the file atomically under the existing cross-host selection lock in that directory. A preparation commits the choice only against the revision captured at admission. An unsupported saved engine reads as `null` and blocks dictation until the user selects API or Hex in local Preferences → Voice → Dictation. Malformed files fail read and write without defaulting to API or replacing the file.
- The host tracks one preparation and one dictation slot per process. Status, finish and cancel require the initiating renderer plus the host-issued operation ID. Document navigation or window loss revokes the owner, and application exit revokes active work. The client renews a 30-second lease by reading current status; the host also imposes absolute limits (150 seconds for dictation, two hours for preparation). Terminal results expire after 30 seconds or can be discarded sooner with cancel. A cancelled slot stays busy until the driver confirms release.
- One microphone lease spans the host's registered app windows, including remote windows and Preferences. `claimMicrophone(purpose, signal)` in `packages/ui/src/lib/microphone-lease.ts` reserves before asynchronous authorization; its `id` binds matching native starts and its `release()` runs after capture cleanup. An unused remote host reservation expires after ten seconds. A native microphone request retains the lease through the capture; Linux Tauri's recorder uses its own bounded confirmation window. Navigation and window closure release reservations. The remote Electron preload advertises native lease support explicitly; without it the renderer uses a Web Lock. Trusted local hand-off windows reserve only when the person clicks capture. Classic playback uses no microphone.
- Web and mobile use an exclusive Web Lock within the secure same-origin browser storage partition. A localStorage value describes the current purpose when available; the browser owns exclusion and document teardown. Without Web Locks, capture is refused rather than admitted concurrently.

## Remote-server windows

- A registered remote desktop document can read the engine choice and, when Hex is selected, request or cancel a single local dictation window through the narrow relay. The relay accepts only a request ID and language for that hand-off. It opens from the focused remote window and displays the registered remote server origin. The dedicated local window owns microphone permission, audio and inference. Starting capture and releasing the transcript each require a click or keyboard activation in that window. Only the accepted text goes back to the initiating document.
- Focus transfers to Insert transcript when its preview replaces the focused capture control. Held Enter repeats are ignored; releasing the preview needs a separate activation. Focus on other controls stays there.
- The composer captures the draft owner and selection before opening the local window. A changed or retired conversation cancels its relay; closing or navigating the originating document or the local window revokes the hand-off and its capture. Text that survives that ownership check follows the same draft revision and recovery rules as in a local project.
- The local hand-off and the Linux Tauri remote API recorder need support in both the desktop host and the remote server's UI. Browser/mobile clients keep the manual API path. A local attempt never switches to the API. Dictation can run with no network for recognition; access to a remote project still requires the connection to that project.

`composer-dictation.test.ts` and `remote-dictation-window.test.ts` exercise the renderer, draft and network boundaries with simulated native replies. The Electron and Tauri relay tests exercise host authorization and cancellation without requesting microphone access.

## Live voice conversation

`packages/server/src/speech/live-voice-contract.ts` is the shared wire contract.
The user selects an engine; the server fixes the provider destination, model, voice and
tool declarations. Local, tunneled and TLS-exception window connections use
the dedicated [voice upgrade](REMOTE_CONTROL.md#live-voice-upgrades). Provider
keys stay on the target backend: Gemini uses `x-goog-api-key` and OpenAI uses
the bearer `Authorization` header on their provider WebSockets.

- The gateway translates event envelopes; PCM samples remain unchanged.
  [Gemini Live](https://ai.google.dev/api/live) uses `BidiGenerateContent`,
  16 kHz PCM input and 24 kHz PCM output. [OpenAI Realtime](https://developers.openai.com/api/docs/guides/realtime-conversations/)
  uses `/v1/realtime` and 24 kHz in both directions. Muting ends the current
  Gemini input stream to flush buffered audio; unmuting resumes PCM frames.
  The renderer stops queued playback at interruption and reports OpenAI's
  played duration for truncation.
- Start audio from the user's activation and send its 20 ms PCM frames only after
  the gateway confirms the expected rates. The audio processor resamples mono
  capture off the UI thread, and resamples and plays 24 kHz PCM from a bounded
  12-second ring. Overflow interrupts the current reply and leaves earlier
  queued replies playing. Playback counts PCM frames rendered per item,
  excluding queued audio and silent gaps. Socket backpressure is the session
  controller's responsibility. A Gemini speech-start flushes any remaining audio
  of a completed reply while preserving the next reply.
- The audio graph requires a secure top-level application document. Local Linux
  Tauri uses the short-lived WebKit frame for its browser microphone. Remote
  Linux Tauri supports API dictation and input testing through the native WAV
  recorder; the live engines require browser microphone access and are unavailable
  in that window.
- `use-live-voice-conversation.ts` checks the provider notice before opening
  capture or the socket. Acceptance is scoped to the server, provider and notice
  version in the browser profile or the local backend's desktop profile.
  Remote macOS Tauri windows keep acceptance in the document, since their
  WebKit store is keyed by remote registration across desktop profiles.
  The first frame contains bounded project, branch/worktree, session title and
  status; the gateway validates it before opening the provider socket.
- The renderer fixes the active project's proxy, session and native location
  for the conversation. These four tools are the full provider interface:
  `get_session_status`, `get_last_reply`, `get_recent_errors`, `send_to_agent`.
  Reads return bounded text from the open session: up to 2,000 characters of the
  latest visible reply and up to three recent errors of 500 characters each.
  `send_to_agent` submits a user message directly, without a confirmation dialog,
  through native `sendMessage` with the composer's delivery rules and no
  attachments. A send from history loads the latest message window and then
  rechecks its target. Follow-up delivery uses the session state at serialized
  admission. An acknowledged steering prompt counts as busy for both voice and
  typed follow-ups in that native session for up to 15 seconds, until native
  execution, settlement or a fresh idle observation. While browsing history,
  `get_last_reply` and `get_recent_errors` read a bounded recent page without
  moving the transcript.
  The conversation's permission mode and normal question handling apply. A call ID is
  admitted once per voice session. Cancellation and target changes fence queued
  admission and late results; an unconfirmed send stays unconfirmed.
- The two voices are transcribed in memory until the window is dismissed.
  Gemini assigns fragments with a start offset to the latest speech start at
  or before that offset. Without offsets, line breaks are best effort: speech
  start opens a new line, and a late fragment may appear on that line. Model
  turn completion applies to the assistant only.
  A stop, target change, closed document, provider failure or disconnect
  releases capture and sockets, with no reconnect or engine fallback.
- Each backend admits one live conversation per identity and four in total.
  Setup has 10 seconds, inactivity two minutes, and the conversation eight
  minutes. Only provider-detected user speech or Gemini input transcription
  renews the client and server inactivity timers. Client
  messages are capped at 32 KiB, provider messages at 256 KiB; rate, fragment
  and queue limits apply before forwarding. Closing either side closes its peer.

## Driver contract

- Read-only capabilities return actual availability and the current Hex plan. A plan token binds the named components, remaining download sizes and candidate file identities. `prepare` rechecks the token at admission. Verified Hex can be selected without invoking preparation. A zero-byte preparation may still need verification; the driver maintains byte limits, integrity, retained partials and readiness. Only verified success persists Hex.
- `start` requires a persisted, ready Hex selection. The authorized renderer owns a media stream and releases it on stop, cancellation, track loss or renderer teardown. `finish` sends a canonical mono 16 kHz signed PCM WAV (limited to 120 seconds) only to its native owner. `cancel` discards late outcomes. Text replies are bounded to 64 KiB. Hex uses no API fallback.
- On Linux Tauri, API capture in local windows and Preferences uses a short-lived WebKit frame; Hex uses its active native operation, including in the trusted dictation sheet. Remote webviews disable WebKit media capture. Remote API capture requires a focused, registered application document served over HTTPS or loopback HTTP and a fresh GTK confirmation naming the registered server origin. The distinct input-test request leaves the device engine unchanged; the host stores the capture's purpose, uses its own translated question, and checks the device choice for composer API dictation. Each acceptance within 30 seconds starts one native recording through GStreamer's PulseAudio source (including PipeWire's PulseAudio service). Only the same document and request may retrieve its one bounded WAV. Cancel, navigation, renderer loss and shutdown discard it and stop capture; the host keeps the slot busy until the source is released. Preview frames forbid microphone and camera access.
- Remote Linux Tauri API capture always uses mono 16 kHz PCM WAV; local API capture uses it when WebKitGTK exposes no supported `MediaRecorder` audio type. At 24 seconds the microphone is released and the excerpt stays on the device. The composer and manual input test offer Transcribe or Cancel. Only Transcribe uploads the excerpt to the configured provider; an explicit earlier stop transcribes as usual. The native remote recorder expires any unclaimed excerpt no later than 150 seconds after approval.

## Hex

- `packages/desktop-speech/hex-manifest.mjs` pins the [Hex 3.4.0 release](https://github.com/anomalyco/hex/releases/tag/v3.4.0) (MIT), [Parakeet v3 Q8_0](https://huggingface.co/handy-computer/parakeet-tdt-0.6b-v3-gguf) (CC BY 4.0, quantized from NVIDIA Parakeet TDT v3), and [Silero 6.2](https://huggingface.co/handy-computer/silero-vad-v6.2-gguf) (MIT). The manifest pins upstream release bytes, model revisions, lengths and SHA-256. Packages include only CodeNomad’s integration code. The Voice section displays per-component remaining bytes and their sum in decimal units, rounded up. A cold Windows x64 plan, for example, totals 827,991,280 bytes (828 MB displayed).
- The two progress amounts are bidirectionally isolated. On successful activation, focus moves from the disappearing activation control to the now-enabled engine selector only if the activation control still owned it.
- Discovery checks the versioned cache, fixed Hex installation paths and pinned Hugging Face cache locations. On Linux it checks `<data-home>/hex/versions/<pinned-version>/hex` directly, using an absolute `$XDG_DATA_HOME` or `~/.local/share`. It reads bounded metadata. Before any download or Hex execution, preparation checks the candidate list held by the plan, in order through the first valid SHA-256 per component. It copies verified files without changing their sources and uses bounded Range requests for retained partials. When a planned local component has no valid candidate, or a Range is refused, a fresh plan and click are required. Verification receipts pin file identity and native readiness; only a verified executable whose embedded service acknowledges the model is eligible for selection. A cross-process loopback lock serializes preparation; a port conflict reports busy. macOS validates the Developer ID signature and exact release version of reused bundles.
- At capture start, the host starts one verified `service --embedded` child and loads `parakeet_v3` with an in-memory silent sample. It reuses the child across dictations and stops it after three idle minutes, engine deselection, or application exit. Tauri checks the installation with its preparation worker at admission; the Rust host owns the service and sends the WAV directly. Both hosts use authenticated IPv4 loopback, a private support directory, and a rejecting local proxy. A missing component fails closed; no model installation endpoint is called. Cancelling after WAV upload stops the service before releasing the slot; cancelling before upload leaves its synthetic warmup intact so Hex can finish GPU initialization. Shutdown removes the lease log. The next recording starts a new service if needed.
- The Hex artifact matrix covers Windows x64/arm64, Apple Silicon on macOS 15+, and Linux x64/arm64 with glibc 2.36+ and the upstream executable’s runtime libraries. This matrix is separate from [the published CodeNomad download targets](../docs/help/downloads.json). Use the Linux system’s ABI and runtime capabilities rather than a distribution allowlist: [Ubuntu 24.04](https://packages.ubuntu.com/noble/libc6) meets the glibc requirement, while [22.04](https://packages.ubuntu.com/jammy/libc6) falls below it. A launch preflight checks dependencies before selection; AudioWorklet and device capture support gate the renderer UI. Intel macOS, older macOS, musl and older glibc have no eligible Hex release.

## Qualification

Record the OS release/distribution and architecture, Electron or Tauri (source or packaged), engine, input language, and whether the check used simulated replies, a local audio clip or a live microphone. Run EN and FR separately. For an eligible Linux distribution, verify the upstream executable starts and the packaged webview can grant and release the microphone. For a prepared local engine, verify offline inference and cancellation; for a remote window, verify only the accepted text returns and leave the connection to the remote project up.

The simulated Hex service and capture checks cover the integration contract; qualify real Parakeet FR/EN inference, live microphone and packaged desktop flows separately.

Run `node --test packages/desktop-speech/hex.test.mjs` for simulated downloads, integrity, local protocol and child termination. The Electron suite includes the device lifecycle and preload checks (`npm run test:native --workspace @neuralnomads/codenomad-electron-app`). Run `cargo test device_speech` in `packages/tauri-app/src-tauri` for the equivalent state and authorization tests.

`packages/tauri-app/tests/webkit-microphone.c` checks local WebKitGTK capture with a simulated device. `cargo test device_speech` also exercises native remote consent ownership and audio capture, using GStreamer's simulated source. The browser suites `composer-dictation.test.ts` and `hex-capture.test.ts` cover the renderer callers, including the remote API clip, manual API input test and PCM fallback. Linux source builds require the GStreamer base development headers; remote capture at runtime requires the base and PulseAudio (Good) plugins.

`live-voice-worklet.test.ts` checks sample-rate conversion, bounds and interruption;
`live-voice-audio.test.ts` exercises the renderer lifecycle with a synthetic stream.
`live-voice-session.test.ts` combines synthetic capture, both simulated providers
and the native prompt and interruption paths. `live-voice-gateway.test.ts`
checks the provider wire envelopes using loopback WebSocket peers. End-to-end
qualification with real provider keys, a physical microphone and packaged
desktop apps is a separate check.
`packages/tauri-app/tests/webkit-live-audio.c` loads the same processors in WebKitGTK
with a simulated capture device.
