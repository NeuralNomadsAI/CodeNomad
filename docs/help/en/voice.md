# Voice input and playback

## Configure the speech API {#configure}

1. Open **Settings → Voice**. The **Speech** card uses an OpenAI-compatible server-side adapter, independently of your conversation's model provider.
2. Enter **API key**, optionally **Base URL**, **Transcription model**, **Speech model** and **Default voice**.
3. If input and output need different services, enable **Separate providers for input and output**, then fill the input/output key, base URL and model fields.
4. Choose **Playback mode** and **Output format**, then **Save** (available while changes are unsaved). Check the status beside the test buttons, **Configured**, **Partially configured** or **Missing API key**, before testing; a failed save shows **Save failed**.

Speech settings and keys belong to the connected CodeNomad server configuration, not the selected project or OpenCode provider connection. Other clients sharing it use those settings. Saved keys are hidden: a blank key field keeps the saved value; **Clear saved key** schedules its removal when saved. A direction with neither its own endpoint nor key can use shared settings; a separate endpoint needs its own key, and a separate key needs its endpoint. When changing an endpoint, explicitly supply the intended key and verify the saved configuration; endpoint changes clear the saved key for that slot rather than sending it to a different host.

The backend can also use `OPENAI_API_KEY` and `OPENAI_BASE_URL` for shared defaults. Clearing a saved key does not remove an environment-provided credential; change that environment at the backend and restart it if you intend to remove the fallback.

| Setting | Meaning / default |
| --- | --- |
| Base URL | OpenAI-compatible API root, default `https://api.openai.com/v1`. Input uses `audio/transcriptions`; output uses `audio/speech`. |
| Transcription model / Input model | Model accepted by the STT endpoint; default `gpt-4o-mini-transcribe`. |
| Speech model / Output model | Model accepted by the TTS endpoint; default `gpt-4o-mini-tts`. |
| Default voice | Provider voice identifier; default `alloy`. It is not an OS voice picker. |
| Streaming | Default. Begins playback as audio arrives, when provider and browser support the selected format. |
| Buffered | Waits for the complete audio response before playing. |
| Output format | `mp3`, `wav`, `opus` or `aac`; default `mp3`. Compatibility varies by browser/provider. |

These are requests to the configured service, not a guarantee that every compatible endpoint implements every model, voice or format.

## Test input and output {#test}

1. Save endpoint, key, model and voice changes first.
2. Choose **Test input**, grant microphone permission, speak, then **Stop recording**. Check the returned transcription.
3. Choose **Test playback** to hear the sample; **Stop sample** ends it.

The playback test uses the selected playback mode/format immediately, but endpoint, key, model and voice come from saved settings. Test input does not send a conversation prompt. Tests still send audio/text to the configured speech provider and can incur its charges.

## Dictate a prompt {#dictate}

1. Keep **Prompt voice input** enabled in **Voice** (it is on by default).
2. In the composer's **More actions** menu, choose **Dictate** and allow microphone access. If you see **Dictate: open Voice settings**, choose or configure the engine there, then come back to the draft.
3. Choose **Stop recording and transcribe** to get text or **Cancel dictation** to discard the recording. Switching conversations or closing the composer also cancels dictation.
4. Review the text. It replaces the original selection only if the draft and selection are unchanged; otherwise choose **Insert transcript** or **Discard transcript**. Dictation never sends the prompt.

If the API uses WAV fallback on Linux Tauri, **Dictate** and **Test input** stop recording at 24 seconds. The clip stays on this device until you choose **Transcribe** to send it to the speech provider or **Cancel** to discard it.

### Choose a desktop engine {#desktop-dictation}

In local desktop **Preferences → Voice**, set **Dictation engine on this device**. This choice applies across projects on the device; the manual **Speech** card still configures the connected server's API. Browser and mobile clients use the configured API provider and need a secure context for microphone access.

- **On-device system recognition** works inside CodeNomad without opening the OS dictation panel. It requires an installed local recognizer for the app language on Windows or macOS. On Linux, or if the recognizer or language is missing, try Hex if offered.
- Voice lists what Hex still needs and the download size for each component and in total. One click on **Activate Hex** verifies and reuses compatible files, downloads what is missing, and selects Hex when ready. Follow the progress in Voice; use **Cancel Hex activation** to stop and **Resume Hex activation** when offered to continue with the remaining download. Failure or cancellation keeps your previous engine. Opening Preferences, selecting ready **Hex (local)** or dictating with it starts no download.
- Hex is offered on eligible Windows x64/arm64, Apple silicon with macOS 15+, and Linux x64/arm64 with glibc 2.36+ and the libraries required by Hex. Intel Macs and Linux systems with older glibc or musl are ineligible. The engine and models are separate from the CodeNomad installer; no terminal or API key is needed.

Ubuntu 24.04 meets the glibc requirement; Ubuntu 22.04 does not. Hex detects the spoken language from [Parakeet’s supported languages](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), which include English and French. This list is independent of the app language.

Local recognition uses this device's microphone and works offline, including with WSL projects opened in the local app. For a compatible remote-server window, **Dictate** opens a separate local **Dictate on this device** window. Check the destination shown there, choose **Start voice input**, then **Stop recording and transcribe** and **Insert transcript** to return only the text to the draft. A remote project still needs its server connection.

In a remote Tauri window on Linux, **Test input** checks the server’s speech API without changing the dictation engine. For each API recording, check the server address in the native microphone prompt before confirming. Capture uses PulseAudio or PipeWire’s PulseAudio service and always has the 24-second WAV limit described above.

Gemini Live and OpenAI Realtime are unavailable in remote Tauri windows on Linux: these windows use the native recorder for dictation and input tests, and WebKit blocks direct microphone access.

## Read messages aloud {#playback}

1. Use **Speak message** on a message, or the same action on a tool call, when TTS is available.
2. Use **Stop playback** on the same control to end it; starting another reading stops the current one.
3. Change the saved voice, model, mode or format on the **Speech** card in **Voice** for subsequent requests.

Playback uses CodeNomad's text projection, not a narrated screenshot: binary/image bytes and permission receipts are not speech content. It does not run a prompt or change the selected OpenCode model.

For automatic conversation speech, use **Enable conversation mode** in the composer's **More actions** menu; it applies to that project tab and is not kept after a reload. While it is on, CodeNomad asks the agent, with each prompt you send, to begin its reply with a short fenced `spoken` summary. Only that completed block is read, in the active main session; it is not an automatic reading of every reply or subagent. **Disable conversation mode** stops its queue and no longer asks for the summary. Starting microphone input also stops active conversation speech. Conversation mode requires configured playback in a supported format.

## Data flow and privacy {#privacy}

Local dictation keeps audio on this device and never falls back to the API. With **API provider**, microphone audio travels through the CodeNomad server to the configured transcription endpoint. Text selected for synthesis travels through that backend to the configured TTS endpoint; returned audio plays on the client. API keys stay server-side and are not returned as saved values to the settings form.

Use an endpoint you trust with the material being dictated or read. OpenCode credentials do not authorize speech automatically. Changing a key or endpoint affects future requests, not data already sent to a provider. See [Security](security.md) before exposing a server to other users.
