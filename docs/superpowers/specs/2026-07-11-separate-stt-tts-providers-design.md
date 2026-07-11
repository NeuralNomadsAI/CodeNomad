# Separate STT/TTS Providers Design

## Problem

Voice input (speech-to-text / STT) and voice output (text-to-speech / TTS) currently share a single API key, base URL, and provider configuration. Users cannot use different providers for each direction — for example, Groq for transcription (STT) and OpenAI for synthesis (TTS).

Only `sttModel` and `ttsModel` are separated today; `apiKey`, `baseUrl`, and `provider` are shared.

## Solution

Add a `separateProviders` toggle to the speech settings. When off (default), behavior is unchanged. When on, STT and TTS each get their own `apiKey`, `baseUrl`, and `model` fields, allowing independent OpenAI-compatible endpoints per direction.

## Scope

- Both directions remain OpenAI-compatible providers — no new provider types.
- Backward compatible: existing configs work unchanged (toggle defaults to off).
- Error handling in the provider class stays exactly as-is.

---

## 1. Server Schema & Settings Resolution

### Config Schema

New fields added to the existing `speech` object in the server config (`~/.config/codenomad/config.json`):

```yaml
speech:
  # --- existing shared fields (used when separateProviders is false) ---
  provider: "openai-compatible"
  apiKey: "sk-..."
  baseUrl: "https://api.openai.com/v1"
  sttModel: "gpt-4o-mini-transcribe"
  ttsModel: "gpt-4o-mini-tts"
  ttsVoice: "alloy"
  ttsFormat: "mp3"

  # --- new ---
  separateProviders: false
  stt:                               # only read when separateProviders is true
    apiKey: "sk-groq-..."
    baseUrl: "https://api.groq.com/openai/v1"
    model: "whisper-large-v3"        # overrides speech.sttModel
  tts:                               # only read when separateProviders is true
    apiKey: "sk-openai-..."
    baseUrl: "https://api.openai.com/v1"
    model: "gpt-4o-mini-tts"         # overrides speech.ttsModel
```

**Key rule:** When `separateProviders` is `false` (or absent), `stt`/`tts` sub-objects are completely ignored.

### Zod Schema (`ServerSpeechSettingsSchema`)

```typescript
const ServerSpeechSettingsSchema = z.object({
  speech: z.object({
    // existing
    provider: z.string().optional(),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    sttModel: z.string().optional(),
    ttsModel: z.string().optional(),
    ttsVoice: z.string().optional(),
    ttsFormat: z.enum(["mp3", "wav", "opus", "aac"]).optional(),
    // new
    separateProviders: z.boolean().optional(),
    stt: z.object({
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
      model: z.string().optional(),
    }).optional(),
    tts: z.object({
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
      model: z.string().optional(),
    }).optional(),
  }).optional(),
})
```

### Normalized Settings Types

`NormalizedSpeechSettings` stays as the existing flat provider-facing interface — **unchanged**. The provider sees no difference. Direction resolution happens entirely inside `SpeechService` before constructing each provider instance.

```typescript
// UNCHANGED — this is what OpenAICompatibleSpeechProvider receives
export interface NormalizedSpeechSettings {
  provider: string
  apiKey?: string
  baseUrl?: string
  sttModel: string
  ttsModel: string
  ttsVoice: string
  ttsFormat: "mp3" | "wav" | "opus" | "aac"
}
```

### `SpeechService` Changes

`createProvider()` is replaced by two methods, each calling a direction-specific resolver:

- `createSttProvider()` → calls `resolveSttSettings()` → returns flat `NormalizedSpeechSettings`
- `createTtsProvider()` → calls `resolveTtsSettings()` → returns flat `NormalizedSpeechSettings`

**`resolveSttSettings()` resolution:**
- When `separateProviders=false`: `apiKey` = shared `apiKey`, `baseUrl` = shared `baseUrl`, `sttModel` = shared `sttModel` (existing behavior)
- When `separateProviders=true`: `apiKey` = `stt.apiKey` (falls back to shared), `baseUrl` = `stt.baseUrl` (falls back to shared), `sttModel` = `stt.model` (falls back to shared `sttModel`)

**`resolveTtsSettings()` resolution:**
- When `separateProviders=false`: existing behavior
- When `separateProviders=true`: `apiKey` = `tts.apiKey` (falls back to shared), `baseUrl` = `tts.baseUrl` (falls back to shared), `ttsModel` = `tts.model` (falls back to shared `ttsModel`)

Both resolvers always produce a complete flat `NormalizedSpeechSettings` (with `ttsVoice`/`ttsFormat` always from shared config — these are TTS presentation options, not provider-specific).

Method routing:
- `transcribe()` → `createSttProvider().transcribe()`
- `synthesize()` → `createTtsProvider().synthesize()`
- `synthesizeStream()` → `createTtsProvider().synthesizeStream()`
- `getCapabilities()` → calls `resolveSttSettings()` and `resolveTtsSettings()` directly, inspects `separateProviders` flag, and builds the capabilities response with per-direction `configured` status

### `OpenAICompatibleSpeechProvider` — No Changes

The provider class is completely unchanged. It receives the same flat `NormalizedSpeechSettings` it always has. Error messages stay as-is.

---

## 2. Capabilities Response & API Types

### `SpeechCapabilitiesResponse` (`api-types.ts`)

New fields added, existing fields kept:

```typescript
export interface SpeechCapabilitiesResponse {
  // --- existing (unchanged) ---
  available: boolean
  configured: boolean               // stays as (sttConfigured || ttsConfigured)
  provider: string
  supportsStt: boolean
  supportsTts: boolean
  supportsStreamingTts: boolean
  baseUrl?: string                  // shared baseUrl (for display)
  sttModel: string
  ttsModel: string
  ttsVoice: string
  ttsFormats: string[]
  streamingTtsFormats: string[]

  // --- new ---
  separateProviders: boolean
  sttConfigured: boolean
  ttsConfigured: boolean
  sttBaseUrl?: string               // STT-specific baseUrl (only when separate)
  ttsBaseUrl?: string               // TTS-specific baseUrl (only when separate)
}
```

### `getCapabilities()` Logic

When `separateProviders=false`:
- `sttConfigured = ttsConfigured = configured = Boolean(sharedApiKey)`
- `sttBaseUrl` / `ttsBaseUrl` omitted

When `separateProviders=true`:
- `sttConfigured = Boolean(resolveSttSettings().apiKey)`
- `ttsConfigured = Boolean(resolveTtsSettings().apiKey)`
- `configured = sttConfigured || ttsConfigured`
- `sttBaseUrl` / `ttsBaseUrl` populated from each direction's resolved `baseUrl`
- `sttModel` / `ttsModel` reflect each direction's resolved model

---

## 3. UI Settings

### `SpeechSettings` Type (`preferences.tsx`)

```typescript
export interface SpeechSettings {
  // existing shared fields...
  provider: SpeechProviderPreference
  apiKey?: string
  hasApiKey: boolean
  baseUrl?: string
  sttModel: string
  ttsModel: string
  ttsVoice: string
  playbackMode: SpeechPlaybackMode
  ttsFormat: SpeechTtsFormat

  // new
  separateProviders: boolean
  stt: {
    apiKey?: string
    hasApiKey: boolean
    baseUrl?: string
    model: string
  }
  tts: {
    apiKey?: string
    hasApiKey: boolean
    baseUrl?: string
    model: string
  }
}
```

### Settings Card Layout (`speech-settings-card.tsx`)

A toggle at the top: "Separate providers for input and output".

**When OFF:** Current layout unchanged — single API Key, Base URL, STT Model, TTS Model, TTS Voice, Playback Mode, TTS Format fields.

**When ON:** Two sections appear, shared API Key / Base URL fields are hidden:

- **Input (Speech-to-Text) section:**
  - Input API Key (with stored-note / clear pattern)
  - Input Base URL
  - Input Model
  - Status badge (configured / not configured)

- **Output (Text-to-Speech) section:**
  - Output API Key (with stored-note / clear pattern)
  - Output Base URL
  - Output Model
  - TTS Voice
  - Playback Mode
  - TTS Format
  - Status badge (configured / not configured)

### Draft Fields

```typescript
type DraftFields = {
  separateProviders: boolean
  // shared (used when separateProviders=false)
  apiKey: string
  baseUrl: string
  sttModel: string
  ttsModel: string
  ttsVoice: string
  playbackMode: SpeechSettings["playbackMode"]
  ttsFormat: SpeechSettings["ttsFormat"]
  // per-direction (used when separateProviders=true)
  stt: { apiKey: string; baseUrl: string; model: string }
  tts: { apiKey: string; baseUrl: string; model: string }
}
```

### API Key Handling Per Direction

The existing `hasApiKey` / `clearStoredApiKey` pattern extends to each direction independently:
- `stt.hasApiKey` / `tts.hasApiKey` — booleans from server
- Each direction has its own clear button and stored-note
- Entering a new key in one direction doesn't affect the other

### Toggle Behavior

- **OFF → ON:** Save `separateProviders: true`. Per-direction fields are pre-populated from current shared values (apiKey, baseUrl, sttModel/ttsModel) as starting defaults so the user doesn't re-enter everything.
- **ON → OFF:** Save `separateProviders: false`. Per-direction values stay in config but are ignored.

### What Stays Unchanged

- `usePromptVoiceInput.ts` — still calls `serverApi.transcribeAudio()`, no endpoint changes
- `conversation-speech.ts` / `use-speech.ts` — still calls `serverApi.synthesizeSpeech()`
- `api-client.ts` — same routes, no new endpoints

---

## 4. Capability Checks Update

### UI consumers of capabilities

| File | Current check | Updated check |
|------|--------------|---------------|
| `usePromptVoiceInput.ts:44-52` | `capabilities?.configured && capabilities?.supportsStt` | `capabilities?.sttConfigured && capabilities?.supportsStt` |
| `conversation-speech.ts` (`isConversationModeAvailable`) | checks `configured && supportsTts` | checks `ttsConfigured && supportsTts` |
| `speech-settings-card.tsx:88` (`capabilityLabel`) | single `configured ? ... : ...` | Shows per-direction status |

Backward compatibility: `configured` field remains in the response as `(sttConfigured || ttsConfigured)` so any consumer not updated still works.

---

## 5. Server Settings Route

The `/api/settings/server` endpoint that returns speech settings to the UI must expose:
- `separateProviders: boolean`
- `stt: { hasApiKey: boolean, baseUrl?: string, model: string }`
- `tts: { hasApiKey: boolean, baseUrl?: string, model: string }`

The `hasApiKey` pattern (boolean, never exposes the actual key value) extends to each direction.

---

## 6. Error Handling

Unchanged from current implementation. The `OpenAICompatibleSpeechProvider` continues to throw:
> `"Speech provider is not configured. Add an API key in Speech settings."`

Direction context is implicit — whichever provider instance (STT or TTS) is called will throw if its own `apiKey` is missing. No new error messages.

---

## 7. i18n Strings

New keys added to all 8 locale files (`packages/ui/src/lib/i18n/messages/{en,es,ja,zh-Hans,fr,de,he,ne}/settings.ts`):

```
"settings.speech.separateProviders.title"
"settings.speech.separateProviders.subtitle"
"settings.speech.stt.section.title"
"settings.speech.tts.section.title"
"settings.speech.stt.apiKey.title"
"settings.speech.stt.apiKey.subtitle"
"settings.speech.stt.apiKey.placeholder"
"settings.speech.stt.apiKey.storedNote"
"settings.speech.stt.apiKey.clearAction"
"settings.speech.stt.apiKey.clearPending"
"settings.speech.stt.baseUrl.title"
"settings.speech.stt.baseUrl.subtitle"
"settings.speech.stt.baseUrl.placeholder"
"settings.speech.stt.model.title"
"settings.speech.stt.model.subtitle"
"settings.speech.stt.status.configured"
"settings.speech.stt.status.missing"
"settings.speech.tts.apiKey.title"
"settings.speech.tts.apiKey.subtitle"
"settings.speech.tts.apiKey.placeholder"
"settings.speech.tts.apiKey.storedNote"
"settings.speech.tts.apiKey.clearAction"
"settings.speech.tts.apiKey.clearPending"
"settings.speech.tts.baseUrl.title"
"settings.speech.tts.baseUrl.subtitle"
"settings.speech.tts.model.title"
"settings.speech.tts.model.subtitle"
```

TTS Voice, Playback Mode, and Format reuse existing labels.

---

## 8. Testing

- **Server unit tests:** `SpeechService` with `separateProviders=false` (backward compat — existing tests pass unchanged), `separateProviders=true` (STT uses stt.apiKey, TTS uses tts.apiKey, partial config scenarios).
- **Provider tests:** `OpenAICompatibleSpeechProvider` unchanged — no new tests needed.
- **Capabilities test:** Verify `sttConfigured`/`ttsConfigured` correctness in all four combinations (off/off, on/off, off/on, on/on).

---

## Files Touched

| Layer | File | Change |
|-------|------|--------|
| Server schema | `packages/server/src/speech/service.ts` | Split schema, `resolveSettings()`, `createSttProvider()`/`createTtsProvider()` |
| Server types | `packages/server/src/api-types.ts` | Add `separateProviders`, `sttConfigured`, `ttsConfigured`, `sttBaseUrl`, `ttsBaseUrl` |
| Server provider | `packages/server/src/speech/providers/openai-compatible.ts` | No changes |
| Server settings route | `packages/server/src/server/routes/settings.ts` | Expose `separateProviders`, `stt`, `tts` in response |
| UI types | `packages/ui/src/stores/preferences.tsx` | Extend `SpeechSettings` with `separateProviders`, `stt`, `tts` |
| UI settings | `packages/ui/src/components/settings/speech-settings-card.tsx` | Toggle, two sections, per-direction draft fields |
| UI capability checks | `packages/ui/src/components/prompt-input/usePromptVoiceInput.ts` | Use `sttConfigured` |
| UI capability checks | `packages/ui/src/stores/conversation-speech.ts` | Use `ttsConfigured` |
| i18n | 8 locale `settings.ts` files | ~27 new keys each |
