# Dictation, playback and voice conversation

## Set up Voice {#configure}

Open **Preferences → Voice** (**Settings → Voice** in a browser or remote window). The **Dictation**, **Playback** and **Conversation** cards each show their status.

1. In **Dictation**, choose the [device engine](#desktop-dictation) in local desktop Preferences. Browser and mobile clients use the API only.
2. For API dictation and playback, open **API credentials** from either card. Enter the **API key** and optionally set the **Base URL**, **Transcription model** and **Speech model**. If the two directions need different services, enable **Separate providers for input and output**, fill their fields, then **Save**.
3. **Playback** shows the **Provider**. Set **Default voice**, **Playback mode** and **Output format**, then **Save**.

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
2. Choose **Test API input**, grant microphone permission, speak, then **Stop recording**. Check the returned transcription.
3. Choose **Test playback** to hear the sample; **Stop sample** ends it.

The playback test uses the selected playback mode/format immediately, but endpoint, key, model and voice come from saved settings. **Test API input** sends audio to the configured API provider regardless of the dictation engine. It does not send a conversation prompt. The provider may charge for these tests.

## Dictate a prompt {#dictate}

1. Keep **Prompt voice input** enabled in **Voice** (it is on by default).
2. In **More actions**, check **Dictation mode**. Uncheck the active mode before choosing the other one.
3. Hold the microphone next to **More actions** (or hold Space with the button focused), speak, then release to transcribe. Allow microphone access when prompted. Switching conversations or closing the composer cancels dictation.
4. Review the text. It replaces the original selection only if the draft and selection are unchanged; otherwise choose **Insert transcript** in normal mode or **Discard transcript** before dictating again. Dictation never sends the prompt.

If the API uses WAV fallback on Linux Tauri, dictation and **Test API input** stop recording at 24 seconds. The clip stays on this device until you choose **Transcribe** to send it to the speech provider or **Cancel** to discard it.

Encoded API recordings also stop at a size limit and offer the same **Transcribe** and **Cancel** choices.

### Choose a desktop engine {#desktop-dictation}

In local desktop **Preferences → Voice → Dictation**, set **Dictation engine on this device**. This choice applies across projects on the device. **API provider** uses the connected server's API settings and requires a secure context for microphone access.

- If your saved engine is unavailable, choose **Hex (local)** if offered, or **API provider**. On Intel Macs and Macs running versions before macOS 15, use **API provider**.
- **Dictation** shows the remaining download size, per component and in total, before you choose **Activate Hex**. Activation verifies and reuses compatible files, downloads what is missing, and selects Hex when ready. Use **Cancel Hex activation** to stop or **Resume Hex activation** when offered. Failure or cancellation keeps your previous engine. Selecting ready **Hex (local)** starts no download.
- Hex is offered on eligible Windows x64/arm64, Apple silicon with macOS 15+, and Linux x64/arm64 with glibc 2.36+ and the libraries required by Hex. Intel Macs and Linux systems with older glibc or musl are ineligible. The engine and models are separate from the CodeNomad installer; no terminal or API key is needed.

Ubuntu 24.04 meets the glibc requirement; Ubuntu 22.04 does not. Hex detects the spoken language from [Parakeet’s supported languages](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), which include English and French. This list is independent of the app language.

Hex loads its model in the background when you start recording and keeps it ready for three minutes after the last dictation.

Local recognition works offline, including with WSL projects opened in the local app. In a compatible remote-server window, click the microphone to open the local **Dictate on this device** window. Check the destination, then use its recording and insertion controls. Only text returns to the draft; the remote project still needs its server connection.

In a remote Tauri window on Linux, **Test API input** checks the server’s speech API without changing the dictation engine. For each API recording, check the server address in the native microphone prompt before confirming. Capture uses PulseAudio or PipeWire’s PulseAudio service and always has the 24-second WAV limit described above.

Gemini Live and OpenAI Realtime are unavailable in remote Tauri windows on Linux: these windows use the native recorder for dictation and input tests, and WebKit blocks direct microphone access.

## Read messages aloud {#playback}

1. Use **Speak message** on a message, or the same action on a tool call, when TTS is available.
2. Use **Stop playback** on the same control to end it; starting another reading stops the current one.
3. Change the voice, mode or format in **Playback**, or the model in **API credentials**, and save for subsequent requests.

Playback uses CodeNomad's text projection, not a narrated screenshot: binary/image bytes and permission receipts are not speech content. It does not run a prompt or change the selected OpenCode model.

## Voice conversation {#conversation}

Gemini Live and OpenAI Realtime are available only for sessions on the server that opened this window.

In **Conversation**, choose a **Conversation engine**:

- **Classic** needs only configured playback in a supported format. In **More actions**, check **Conversation mode**. CodeNomad reads the completed `spoken` summary of each reply in the active main session. The mode applies to the project tab until you uncheck it or reload.
- **Gemini Live** and **OpenAI Realtime** each have their own **API key**, **Model** and optional **Voice**. Save the selected provider's settings. Open the target session, choose **Conversation mode** under **More actions**, and choose **Agree and start** when the provider consent dialog appears. Allow microphone access.

If the provider becomes unavailable while the consent dialog is open, choose **Voice settings** to open the **Conversation** card.

The live voice model can read the fixed session's status, latest visible reply and recent errors. It has no file access. When you ask it to send a request to the agent, it sends it directly as a user message, without on-screen confirmation. The [conversation's permission mode](permissions.md#conversation-mode) and normal question handling still apply.

The server allows one live conversation at a time per signed-in user, or per paired device with Remote Control. Use **Stop** to end audio and keep the transcript open. CodeNomad keeps the live transcript in memory until its window closes; requests sent to the agent remain ordinary session messages. Live voice also ends after two minutes without speech, after eight minutes total, when the target changes, when you close the window or if the connection drops. There is no automatic reconnection or provider fallback.

With OpenAI Realtime, **Interrupt reply** stops playback and requests cancellation of the current reply. With Gemini Live, **Stop playback** only silences the reply on this device; Gemini can continue generating it and send requests to the agent.

## Data flow and privacy {#privacy}

Local dictation keeps audio on this device and never falls back to the API. With **API provider**, microphone audio travels through the CodeNomad server to the configured transcription endpoint. Text selected for synthesis travels through that backend to the configured TTS endpoint; returned audio plays on the client. API keys stay server-side and are not returned as saved values to the settings form.

With **Gemini Live** or **OpenAI Realtime**, Google or OpenAI receives microphone audio and the project name, branch, worktree, session title and status. The provider can also receive the text of the latest visible agent reply and recent errors. The selected provider may bill your account for usage.

Use a provider you trust with what you dictate, read or share. OpenCode credentials do not authorize voice services automatically. See [Security](security.md) before exposing a server to other users.
