# Voice input and playback

## Configure speech {#configure}

1. Open **Settings → Speech**. The **Speech** card uses an OpenAI-compatible server-side adapter, independently of your conversation's model provider.
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

These are requests to the configured service, not a guarantee that every compatible endpoint implements every model, voice or format. Failed saving leaves an error; inspect the configuration before making another change.

## Test input and output {#test}

1. Save endpoint, key, model and voice changes first.
2. Choose **Test input**, grant microphone permission, speak, then **Stop recording**. Check the returned transcription.
3. Choose **Test playback** to hear the sample; **Stop sample** ends it.

The playback test uses the selected playback mode/format immediately, but endpoint, key, model and voice come from saved settings. Test input does not send a conversation prompt. Tests still send audio/text to the configured speech provider and can incur its charges.

If streaming fails, select **Buffered**, try `mp3`, save and retest. “Configured” confirms settings, not successful provider authentication or codec playback. Check endpoint availability from the server host, provider model/voice names and quota before retrying.

## Dictate a prompt {#dictate}

1. Keep **Prompt voice input** enabled in **Speech** (it is on by default).
2. In the composer, open **More actions**, choose **Start voice input** and allow microphone access on this device.
3. When you finish speaking, choose **Stop recording and transcribe** in the same menu; **Transcribing audio** shows while it is processed.
4. Review and edit the inserted text before sending the prompt normally.

Transcription inserts text at the current selection; it does not automatically submit it to OpenCode. The menu entry appears only when STT is configured and the client supports recording. Recording uses the client device's microphone, even when CodeNomad runs on a remote server.

For a missing entry, check the toggle and STT configuration. For permission errors, allow the microphone in both browser/OS privacy settings. Remote browser recording needs a secure context, normally trusted HTTPS; see [Mobile access](mobile.md) and [Direct remote access](remote-access.md). Switching away or closing the composer ends its recording lifecycle; do not rely on unsent audio being recoverable. Your typed draft remains the place to review the result.

## Read messages aloud {#playback}

1. Use **Speak message** on a message, or the same action on a tool call, when TTS is available.
2. Use **Stop playback** on the same control to end it; starting another reading stops the current one.
3. Change the saved voice, model, mode or format in **Speech** for subsequent requests.

Playback uses CodeNomad's text projection, not a narrated screenshot: binary/image bytes and permission receipts are not speech content. It does not run a prompt or change the selected OpenCode model. Browser audio support and provider responses can still prevent playback even when a format is selectable.

For automatic conversation speech, use **Enable conversation mode** in the composer's **More actions** menu; it applies to that project tab and is not kept after a reload. While it is on, CodeNomad asks the agent, with each prompt you send, to begin its reply with a short fenced `spoken` summary. Only that completed block is read, in the active main session; it is not an automatic reading of every reply or subagent. **Disable conversation mode** stops its queue and no longer asks for the summary. Starting microphone input also stops active conversation speech. The toggle appears with voice input, or while conversation mode is already enabled, and requires working TTS to enable.

## Data flow and privacy {#privacy}

Microphone audio travels from your client to the CodeNomad backend, then to the configured STT endpoint. Text selected for synthesis travels through that backend to the configured TTS endpoint; returned audio plays on the client. API keys stay server-side and are not returned as saved values to the settings form.

Use an endpoint you trust with the material being dictated or read. This is not an offline transcription guarantee, and OpenCode credentials do not authorize speech automatically. Stop recording/playback when finished; changing a key or endpoint affects future requests, not data already sent to a provider. See [Security](security.md) before exposing a server to other users.
