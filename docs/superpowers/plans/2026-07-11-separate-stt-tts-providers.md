# Separate STT/TTS Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to configure independent API keys, base URLs, and models for voice input (STT) and voice output (TTS) via a `separateProviders` toggle in speech settings.

**Architecture:** A `separateProviders` boolean in the server speech config controls whether STT/TTS use separate or shared credentials. `SpeechService` gains direction-aware resolvers (`resolveSttSettings`/`resolveTtsSettings`) that produce the existing flat `NormalizedSpeechSettings` for the unchanged `OpenAICompatibleSpeechProvider`. The capabilities response gains per-direction `sttConfigured`/`ttsConfigured` fields. The UI settings card gains a toggle that expands two sections when enabled.

**Tech Stack:** TypeScript, Fastify, SolidJS, Zod, node:test, tsx

## Global Constraints

- Both directions remain OpenAI-compatible providers — no new provider types
- `NormalizedSpeechSettings` (the provider-facing flat interface) stays unchanged
- `OpenAICompatibleSpeechProvider` class is completely untouched
- Error handling in the provider stays as-is (generic message)
- `configured` field stays in capabilities response as `(sttConfigured || ttsConfigured)` for backward compat
- Existing configs with no `separateProviders` field must work unchanged (defaults to false)
- Never hardcode user-visible strings — all new UI text goes through i18n `t()` / `tGlobal()`
- Use the `edit` tool for modifying existing files; `write` only for new files
- No rounded corners in UI styling
- Tests run via: `npx tsx --test <file>`
- Typecheck via: `cd packages/server && npx tsc --noEmit -p tsconfig.json` and `cd packages/ui && npx tsc --noEmit -p tsconfig.json`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/server/src/api-types.ts` | Add `separateProviders`, `sttConfigured`, `ttsConfigured`, `sttBaseUrl`, `ttsBaseUrl` to `SpeechCapabilitiesResponse` |
| `packages/server/src/speech/service.ts` | Extend Zod schema, add `resolveSttSettings()`/`resolveTtsSettings()`, split `createProvider()` into `createSttProvider()`/`createTtsProvider()`, update `getCapabilities()` |
| `packages/server/src/speech/service.test.ts` (new) | Unit tests for direction-aware resolution and capabilities |
| `packages/server/src/settings/public-config.ts` | Sanitize per-direction `stt.apiKey`/`tts.apiKey` into `stt.hasApiKey`/`tts.hasApiKey` |
| `packages/ui/src/stores/preferences.tsx` | Extend `SpeechSettings` type, `defaultSpeechSettings`, `normalizeSpeechSettings()`, `updateSpeechSettings()` |
| `packages/ui/src/components/settings/speech-settings-card.tsx` | Toggle, two sections, per-direction draft fields, save logic |
| `packages/ui/src/components/prompt-input/usePromptVoiceInput.ts` | Use `sttConfigured` instead of `configured` |
| `packages/ui/src/stores/conversation-speech.ts` | Use `ttsConfigured` instead of `configured` |
| `packages/ui/src/lib/i18n/messages/{en,es,ja,zh-Hans,fr,de,he,ne}/settings.ts` | ~27 new i18n keys per locale |

---

### Task 1: Server API Types — Add Per-Direction Capability Fields

**Files:**
- Modify: `packages/server/src/api-types.ts` (the `SpeechCapabilitiesResponse` interface, around line 337)

**Interfaces:**
- Produces: Updated `SpeechCapabilitiesResponse` with new fields: `separateProviders: boolean`, `sttConfigured: boolean`, `ttsConfigured: boolean`, `sttBaseUrl?: string`, `ttsBaseUrl?: string`

- [ ] **Step 1: Add new fields to `SpeechCapabilitiesResponse`**

In `packages/server/src/api-types.ts`, find the `SpeechCapabilitiesResponse` interface and add the new fields after the existing `streamingTtsFormats` field:

```typescript
export interface SpeechCapabilitiesResponse {
  available: boolean
  configured: boolean
  provider: string
  supportsStt: boolean
  supportsTts: boolean
  supportsStreamingTts: boolean
  baseUrl?: string
  sttModel: string
  ttsModel: string
  ttsVoice: string
  ttsFormats: string[]
  streamingTtsFormats: string[]
  // Per-direction fields (added for separateProviders support)
  separateProviders: boolean
  sttConfigured: boolean
  ttsConfigured: boolean
  sttBaseUrl?: string
  ttsBaseUrl?: string
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `cd packages/server && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: No errors (the new fields are optional additions; the provider's `getCapabilities()` doesn't yet return them, but TS structural typing means the return type just won't have them yet — this will be fixed in Task 2)

Note: If TypeScript complains that `getCapabilities()` return type is missing the new required fields, that's expected — it will be resolved in Task 2 when we update the method. If it blocks compilation, temporarily add the fields to the provider's return in `openai-compatible.ts` with placeholder values. But most likely the provider returns an inferred object literal that TS checks structurally, so it will need updating in Task 2.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/api-types.ts
git commit -m "feat(speech): add per-direction capability fields to SpeechCapabilitiesResponse

Add separateProviders, sttConfigured, ttsConfigured, sttBaseUrl, and
ttsBaseUrl to the capabilities response. The existing 'configured' field
remains as (sttConfigured || ttsConfigured) for backward compatibility."
```

---

### Task 2: Server SpeechService — Direction-Aware Settings Resolution

**Files:**
- Modify: `packages/server/src/speech/service.ts` (the full file)
- Create: `packages/server/src/speech/service.test.ts`

**Interfaces:**
- Consumes: `SettingsService.getOwner("config", "server")` — returns the raw config doc
- Produces: `SpeechService` with `createSttProvider()`, `createTtsProvider()`, `resolveSttSettings()`, `resolveTtsSettings()` private methods; updated `getCapabilities()` returning the new `SpeechCapabilitiesResponse` fields

- [ ] **Step 1: Write failing tests for direction-aware resolution**

Create `packages/server/src/speech/service.test.ts`:

```typescript
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { SpeechService } from "./service"
import type { SettingsService } from "../settings/service"
import type { Logger } from "../logger"

function createMockSettings(serverConfig: Record<string, unknown>): SettingsService {
  return {
    getOwner: () => serverConfig,
  } as unknown as SettingsService
}

const mockLogger: Logger = {
  child: () => mockLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger

describe("SpeechService direction resolution", () => {
  describe("separateProviders = false (default)", () => {
    it("uses shared apiKey for both STT and TTS", () => {
      const settings = createMockSettings({
        speech: {
          apiKey: "sk-shared",
          baseUrl: "https://api.openai.com/v1",
          sttModel: "whisper-1",
          ttsModel: "tts-1",
        },
      })
      const service = new SpeechService(settings, mockLogger)
      const caps = service.getCapabilities()

      assert.equal(caps.separateProviders, false)
      assert.equal(caps.sttConfigured, true)
      assert.equal(caps.ttsConfigured, true)
      assert.equal(caps.configured, true)
    })

    it("reports unconfigured when no apiKey is set", () => {
      const settings = createMockSettings({
        speech: { sttModel: "whisper-1", ttsModel: "tts-1" },
      })
      const service = new SpeechService(settings, mockLogger)
      const caps = service.getCapabilities()

      assert.equal(caps.sttConfigured, false)
      assert.equal(caps.ttsConfigured, false)
      assert.equal(caps.configured, false)
    })
  })

  describe("separateProviders = true", () => {
    it("reports per-direction configured status independently", () => {
      const settings = createMockSettings({
        speech: {
          apiKey: "sk-shared",
          separateProviders: true,
          stt: { apiKey: "sk-groq", baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3" },
          tts: { apiKey: "sk-openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-tts" },
        },
      })
      const service = new SpeechService(settings, mockLogger)
      const caps = service.getCapabilities()

      assert.equal(caps.separateProviders, true)
      assert.equal(caps.sttConfigured, true)
      assert.equal(caps.ttsConfigured, true)
      assert.equal(caps.configured, true)
      assert.equal(caps.sttBaseUrl, "https://api.groq.com/openai/v1")
      assert.equal(caps.ttsBaseUrl, "https://api.openai.com/v1")
    })

    it("reports partial config when only STT has apiKey", () => {
      const settings = createMockSettings({
        speech: {
          separateProviders: true,
          stt: { apiKey: "sk-groq" },
        },
      })
      const service = new SpeechService(settings, mockLogger)
      const caps = service.getCapabilities()

      assert.equal(caps.sttConfigured, true)
      assert.equal(caps.ttsConfigured, false)
      assert.equal(caps.configured, true)
    })

    it("falls back to shared apiKey when per-direction apiKey is absent", () => {
      const settings = createMockSettings({
        speech: {
          apiKey: "sk-shared",
          separateProviders: true,
          stt: { baseUrl: "https://api.groq.com/openai/v1" },
          tts: { baseUrl: "https://api.openai.com/v1" },
        },
      })
      const service = new SpeechService(settings, mockLogger)
      const caps = service.getCapabilities()

      assert.equal(caps.sttConfigured, true)
      assert.equal(caps.ttsConfigured, true)
    })

    it("falls back to shared sttModel/ttsModel when per-direction model is absent", () => {
      const settings = createMockSettings({
        speech: {
          apiKey: "sk-shared",
          sttModel: "shared-stt-model",
          ttsModel: "shared-tts-model",
          separateProviders: true,
          stt: { apiKey: "sk-stt" },
          tts: { apiKey: "sk-tts" },
        },
      })
      const service = new SpeechService(settings, mockLogger)
      const caps = service.getCapabilities()

      assert.equal(caps.sttModel, "shared-stt-model")
      assert.equal(caps.ttsModel, "shared-tts-model")
    })

    it("uses per-direction model when set", () => {
      const settings = createMockSettings({
        speech: {
          apiKey: "sk-shared",
          sttModel: "shared-stt-model",
          ttsModel: "shared-tts-model",
          separateProviders: true,
          stt: { apiKey: "sk-stt", model: "whisper-large-v3" },
          tts: { apiKey: "sk-tts", model: "gpt-4o-mini-tts" },
        },
      })
      const service = new SpeechService(settings, mockLogger)
      const caps = service.getCapabilities()

      assert.equal(caps.sttModel, "whisper-large-v3")
      assert.equal(caps.ttsModel, "gpt-4o-mini-tts")
    })

    it("omits sttBaseUrl/ttsBaseUrl when separateProviders is false", () => {
      const settings = createMockSettings({
        speech: { apiKey: "sk-shared", baseUrl: "https://api.openai.com/v1" },
      })
      const service = new SpeechService(settings, mockLogger)
      const caps = service.getCapabilities()

      assert.equal(caps.sttBaseUrl, undefined)
      assert.equal(caps.ttsBaseUrl, undefined)
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test packages/server/src/speech/service.test.ts`
Expected: FAIL — `getCapabilities()` doesn't return `separateProviders`, `sttConfigured`, `ttsConfigured` fields yet.

- [ ] **Step 3: Implement direction-aware resolution in `service.ts`**

Update `packages/server/src/speech/service.ts`. Replace the entire `ServerSpeechSettingsSchema` and the class body:

**3a. Extend the Zod schema** — Replace the existing `ServerSpeechSettingsSchema` (lines 8-20) with:

```typescript
const ServerSpeechSettingsSchema = z.object({
  speech: z
    .object({
      provider: z.string().optional(),
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
      sttModel: z.string().optional(),
      ttsModel: z.string().optional(),
      ttsVoice: z.string().optional(),
      ttsFormat: z.enum(["mp3", "wav", "opus", "aac"]).optional(),
      separateProviders: z.boolean().optional(),
      stt: z
        .object({
          apiKey: z.string().optional(),
          baseUrl: z.string().optional(),
          model: z.string().optional(),
        })
        .optional(),
      tts: z
        .object({
          apiKey: z.string().optional(),
          baseUrl: z.string().optional(),
          model: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
})
```

**3b. Replace `createProvider()` and `resolveSettings()`** — Remove the existing `createProvider()` method and `resolveSettings()` method. Add the following methods to the `SpeechService` class (keep the constructor, `transcribe`, `synthesize`, `synthesizeStream` as-is but update them to call the right provider factory):

```typescript
  async transcribe(input: TranscribeAudioInput): Promise<SpeechTranscriptionResponse> {
    return this.createSttProvider().transcribe(input)
  }

  async synthesize(input: SynthesizeSpeechInput): Promise<SpeechSynthesisResponse> {
    return this.createTtsProvider().synthesize(input)
  }

  async synthesizeStream(input: SynthesizeSpeechInput): Promise<SpeechSynthesisStreamResponse> {
    return this.createTtsProvider().synthesizeStream(input)
  }

  getCapabilities(): SpeechCapabilitiesResponse {
    const sttSettings = this.resolveSttSettings()
    const ttsSettings = this.resolveTtsSettings()
    const separate = this.isSeparateProviders()

    const sttConfigured = Boolean(sttSettings.apiKey)
    const ttsConfigured = Boolean(ttsSettings.apiKey)

    return {
      available: true,
      configured: sttConfigured || ttsConfigured,
      provider: sttSettings.provider,
      supportsStt: true,
      supportsTts: true,
      supportsStreamingTts: true,
      baseUrl: this.resolveSharedBaseUrl(),
      sttModel: sttSettings.sttModel,
      ttsModel: ttsSettings.ttsModel,
      ttsVoice: ttsSettings.ttsVoice,
      ttsFormats: ["mp3", "wav", "opus", "aac"],
      streamingTtsFormats: ["mp3", "wav", "opus", "aac"],
      separateProviders: separate,
      sttConfigured,
      ttsConfigured,
      ...(separate ? { sttBaseUrl: sttSettings.baseUrl, ttsBaseUrl: ttsSettings.baseUrl } : {}),
    }
  }

  private createSttProvider(): SpeechProvider {
    const settings = this.resolveSttSettings()
    return new OpenAICompatibleSpeechProvider({
      settings,
      logger: this.logger.child({ provider: settings.provider, direction: "stt" }),
    })
  }

  private createTtsProvider(): SpeechProvider {
    const settings = this.resolveTtsSettings()
    return new OpenAICompatibleSpeechProvider({
      settings,
      logger: this.logger.child({ provider: settings.provider, direction: "tts" }),
    })
  }

  private isSeparateProviders(): boolean {
    const parsed = ServerSpeechSettingsSchema.parse(this.settings.getOwner("config", "server") ?? {})
    return parsed.speech?.separateProviders === true
  }

  private resolveSttSettings(): NormalizedSpeechSettings {
    const parsed = ServerSpeechSettingsSchema.parse(this.settings.getOwner("config", "server") ?? {})
    const speech = parsed.speech ?? {}
    const separate = speech.separateProviders === true

    if (separate) {
      const stt = speech.stt ?? {}
      return {
        provider: speech.provider?.trim() || DEFAULT_PROVIDER,
        apiKey: stt.apiKey?.trim() || speech.apiKey?.trim() || process.env.OPENAI_API_KEY,
        baseUrl: stt.baseUrl?.trim() || speech.baseUrl?.trim() || process.env.OPENAI_BASE_URL || undefined,
        sttModel: stt.model?.trim() || speech.sttModel?.trim() || DEFAULT_STT_MODEL,
        ttsModel: speech.ttsModel?.trim() || DEFAULT_TTS_MODEL,
        ttsVoice: speech.ttsVoice?.trim() || DEFAULT_TTS_VOICE,
        ttsFormat: speech.ttsFormat ?? DEFAULT_TTS_FORMAT,
      }
    }

    return {
      provider: speech.provider?.trim() || DEFAULT_PROVIDER,
      apiKey: speech.apiKey?.trim() || process.env.OPENAI_API_KEY,
      baseUrl: speech.baseUrl?.trim() || process.env.OPENAI_BASE_URL || undefined,
      sttModel: speech.sttModel?.trim() || DEFAULT_STT_MODEL,
      ttsModel: speech.ttsModel?.trim() || DEFAULT_TTS_MODEL,
      ttsVoice: speech.ttsVoice?.trim() || DEFAULT_TTS_VOICE,
      ttsFormat: speech.ttsFormat ?? DEFAULT_TTS_FORMAT,
    }
  }

  private resolveTtsSettings(): NormalizedSpeechSettings {
    const parsed = ServerSpeechSettingsSchema.parse(this.settings.getOwner("config", "server") ?? {})
    const speech = parsed.speech ?? {}
    const separate = speech.separateProviders === true

    if (separate) {
      const tts = speech.tts ?? {}
      return {
        provider: speech.provider?.trim() || DEFAULT_PROVIDER,
        apiKey: tts.apiKey?.trim() || speech.apiKey?.trim() || process.env.OPENAI_API_KEY,
        baseUrl: tts.baseUrl?.trim() || speech.baseUrl?.trim() || process.env.OPENAI_BASE_URL || undefined,
        sttModel: speech.sttModel?.trim() || DEFAULT_STT_MODEL,
        ttsModel: tts.model?.trim() || speech.ttsModel?.trim() || DEFAULT_TTS_MODEL,
        ttsVoice: speech.ttsVoice?.trim() || DEFAULT_TTS_VOICE,
        ttsFormat: speech.ttsFormat ?? DEFAULT_TTS_FORMAT,
      }
    }

    return {
      provider: speech.provider?.trim() || DEFAULT_PROVIDER,
      apiKey: speech.apiKey?.trim() || process.env.OPENAI_API_KEY,
      baseUrl: speech.baseUrl?.trim() || process.env.OPENAI_BASE_URL || undefined,
      sttModel: speech.sttModel?.trim() || DEFAULT_STT_MODEL,
      ttsModel: speech.ttsModel?.trim() || DEFAULT_TTS_MODEL,
      ttsVoice: speech.ttsVoice?.trim() || DEFAULT_TTS_VOICE,
      ttsFormat: speech.ttsFormat ?? DEFAULT_TTS_FORMAT,
    }
  }

  private resolveSharedBaseUrl(): string | undefined {
    const parsed = ServerSpeechSettingsSchema.parse(this.settings.getOwner("config", "server") ?? {})
    const speech = parsed.speech ?? {}
    return speech.baseUrl?.trim() || process.env.OPENAI_BASE_URL || undefined
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test packages/server/src/speech/service.test.ts`
Expected: PASS — all 8 test cases pass.

- [ ] **Step 5: Run typecheck**

Run: `cd packages/server && npx tsc --noEmit -p tsconfig.json`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/speech/service.ts packages/server/src/speech/service.test.ts
git commit -m "feat(speech): add direction-aware settings resolution in SpeechService

Split createProvider() into createSttProvider()/createTtsProvider() that
each resolve their own apiKey/baseUrl/model based on the separateProviders
toggle. When false (default), behavior is unchanged — shared config is
used for both directions. When true, stt.* and tts.* sub-objects provide
per-direction credentials with fallback to shared values.

getCapabilities() now reports sttConfigured/ttsConfigured independently
and includes sttBaseUrl/ttsBaseUrl when separate mode is active."
```

---

### Task 3: Server Config Sanitization — Per-Direction hasApiKey

**Files:**
- Modify: `packages/server/src/settings/public-config.ts` (the `sanitizeServerOwner` function)
- Create: `packages/server/src/settings/public-config.test.ts`

**Interfaces:**
- Produces: Updated `sanitizeServerOwner` that strips `stt.apiKey`/`tts.apiKey` and sets `stt.hasApiKey`/`tts.hasApiKey`

- [ ] **Step 1: Write failing tests for per-direction sanitization**

Create `packages/server/src/settings/public-config.test.ts`:

```typescript
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { sanitizeConfigOwner } from "./public-config"

describe("sanitizeConfigOwner server speech", () => {
  it("strips shared apiKey and sets hasApiKey", () => {
    const result = sanitizeConfigOwner("server", {
      speech: { apiKey: "sk-secret", sttModel: "whisper-1" },
    })
    assert.equal((result.speech as any).apiKey, undefined)
    assert.equal((result.speech as any).hasApiKey, true)
  })

  it("strips stt.apiKey and sets stt.hasApiKey when separateProviders is true", () => {
    const result = sanitizeConfigOwner("server", {
      speech: {
        separateProviders: true,
        apiKey: "sk-shared",
        stt: { apiKey: "sk-stt-secret", baseUrl: "https://groq.com" },
        tts: { apiKey: "sk-tts-secret", baseUrl: "https://openai.com" },
      },
    })
    assert.equal((result.speech as any).apiKey, undefined)
    assert.equal((result.speech as any).hasApiKey, true)
    assert.equal((result.speech as any).stt.apiKey, undefined)
    assert.equal((result.speech as any).stt.hasApiKey, true)
    assert.equal((result.speech as any).tts.apiKey, undefined)
    assert.equal((result.speech as any).tts.hasApiKey, true)
  })

  it("sets hasApiKey=false when per-direction apiKey is absent", () => {
    const result = sanitizeConfigOwner("server", {
      speech: {
        separateProviders: true,
        stt: { baseUrl: "https://groq.com" },
        tts: { baseUrl: "https://openai.com" },
      },
    })
    assert.equal((result.speech as any).stt.hasApiKey, false)
    assert.equal((result.speech as any).tts.hasApiKey, false)
  })

  it("preserves stt/tts sub-objects that have no apiKey", () => {
    const result = sanitizeConfigOwner("server", {
      speech: {
        separateProviders: true,
        stt: { model: "whisper-large-v3" },
        tts: { model: "tts-1" },
      },
    })
    assert.equal((result.speech as any).stt.model, "whisper-large-v3")
    assert.equal((result.speech as any).stt.hasApiKey, false)
    assert.equal((result.speech as any).tts.model, "tts-1")
    assert.equal((result.speech as any).tts.hasApiKey, false)
  })

  it("passes through non-server owners unchanged", () => {
    const result = sanitizeConfigOwner("ui", { foo: "bar" })
    assert.deepEqual(result, { foo: "bar" })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test packages/server/src/settings/public-config.test.ts`
Expected: FAIL — `stt.apiKey` not stripped, `stt.hasApiKey` not set.

- [ ] **Step 3: Implement per-direction sanitization**

In `packages/server/src/settings/public-config.ts`, replace the `sanitizeServerOwner` function with:

```typescript
function sanitizeServerOwner(value: SettingsDoc): SettingsDoc {
  const next: SettingsDoc = { ...value }
  const speech = isPlainObject(next.speech) ? { ...next.speech } : null

  if (!speech) {
    return next
  }

  const rawApiKey = typeof speech.apiKey === "string" ? speech.apiKey.trim() : ""
  if (rawApiKey) {
    delete speech.apiKey
    speech.hasApiKey = true
  } else if (!("hasApiKey" in speech)) {
    speech.hasApiKey = false
  }

  for (const dir of ["stt", "tts"] as const) {
    if (isPlainObject(speech[dir])) {
      const sub = { ...speech[dir] } as SettingsDoc
      const dirKey = typeof sub.apiKey === "string" ? sub.apiKey.trim() : ""
      if (dirKey) {
        delete sub.apiKey
        sub.hasApiKey = true
      } else if (!("hasApiKey" in sub)) {
        sub.hasApiKey = false
      }
      speech[dir] = sub
    }
  }

  next.speech = speech
  return next
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test packages/server/src/settings/public-config.test.ts`
Expected: PASS — all 5 test cases pass.

- [ ] **Step 5: Run full typecheck**

Run: `cd packages/server && npx tsc --noEmit -p tsconfig.json`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/settings/public-config.ts packages/server/src/settings/public-config.test.ts
git commit -m "feat(speech): sanitize per-direction API keys in public config

Extend sanitizeServerOwner to strip stt.apiKey/tts.apiKey and set
stt.hasApiKey/tts.hasApiKey booleans, matching the existing pattern
for the shared apiKey field. This prevents per-direction API keys from
being exposed to the UI."
```

---

### Task 4: UI SpeechSettings Type & Normalization

**Files:**
- Modify: `packages/ui/src/stores/preferences.tsx`

**Interfaces:**
- Consumes: Sanitized server config (with `stt.hasApiKey`/`tts.hasApiKey` from Task 3)
- Produces: Extended `SpeechSettings` with `separateProviders`, `stt`, `tts` sub-objects; updated `normalizeSpeechSettings()`, `defaultSpeechSettings`, `updateSpeechSettings()`

- [ ] **Step 1: Extend the `SpeechSettings` interface**

In `packages/ui/src/stores/preferences.tsx`, find the `SpeechSettings` interface (around line 49) and add the new fields:

```typescript
export interface SpeechSettings {
  provider: SpeechProviderPreference
  apiKey?: string
  hasApiKey: boolean
  baseUrl?: string
  sttModel: string
  ttsModel: string
  ttsVoice: string
  playbackMode: SpeechPlaybackMode
  ttsFormat: SpeechTtsFormat
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

- [ ] **Step 2: Update `defaultSpeechSettings`**

Find the `defaultSpeechSettings` constant (around line 218) and add the new default fields:

```typescript
const defaultSpeechSettings: SpeechSettings = {
  provider: "openai-compatible",
  hasApiKey: false,
  sttModel: "gpt-4o-mini-transcribe",
  ttsModel: "gpt-4o-mini-tts",
  ttsVoice: "alloy",
  playbackMode: "streaming",
  ttsFormat: "mp3",
  separateProviders: false,
  stt: {
    hasApiKey: false,
    model: "gpt-4o-mini-transcribe",
  },
  tts: {
    hasApiKey: false,
    model: "gpt-4o-mini-tts",
  },
}
```

- [ ] **Step 3: Update `normalizeSpeechSettings`**

Find the `normalizeSpeechSettings` function (around line 270) and add normalization for the new fields. Add these lines to the returned object (after `ttsFormat`):

```typescript
    separateProviders: sanitized.separateProviders === true,
    stt: {
      apiKey: typeof (sanitized as any).stt?.apiKey === "string" && (sanitized as any).stt.apiKey.trim() ? (sanitized as any).stt.apiKey.trim() : undefined,
      hasApiKey: (sanitized as any).stt?.hasApiKey === true,
      baseUrl: typeof (sanitized as any).stt?.baseUrl === "string" && (sanitized as any).stt.baseUrl.trim() ? (sanitized as any).stt.baseUrl.trim() : undefined,
      model:
        typeof (sanitized as any).stt?.model === "string" && (sanitized as any).stt.model.trim()
          ? (sanitized as any).stt.model.trim()
          : defaultSpeechSettings.stt.model,
    },
    tts: {
      apiKey: typeof (sanitized as any).tts?.apiKey === "string" && (sanitized as any).tts.apiKey.trim() ? (sanitized as any).tts.apiKey.trim() : undefined,
      hasApiKey: (sanitized as any).tts?.hasApiKey === true,
      baseUrl: typeof (sanitized as any).tts?.baseUrl === "string" && (sanitized as any).tts.baseUrl.trim() ? (sanitized as any).tts.baseUrl.trim() : undefined,
      model:
        typeof (sanitized as any).tts?.model === "string" && (sanitized as any).tts.model.trim()
          ? (sanitized as any).tts.model.trim()
          : defaultSpeechSettings.tts.model,
    },
```

- [ ] **Step 4: Update `updateSpeechSettings`**

Find the `updateSpeechSettings` function (around line 632). The function currently strips `apiKey` before persisting and handles the `null` clear case. We need to extend it to handle per-direction `stt.apiKey`/`tts.apiKey` similarly.

Replace the `updateSpeechSettings` function with:

```typescript
async function updateSpeechSettings(updates: SpeechSettingsUpdate): Promise<void> {
  const apiKeyPatch = updates.apiKey
  const sttApiKeyPatch = (updates as any).stt?.apiKey
  const ttsApiKeyPatch = (updates as any).tts?.apiKey
  const { apiKey: _apiKey, ...restUpdates } = updates
  const next = normalizeSpeechSettings({
    ...serverSettings().speech,
    ...restUpdates,
    ...(apiKeyPatch === null ? {} : apiKeyPatch ? { apiKey: apiKeyPatch } : {}),
  })
  const { hasApiKey: _hasApiKey, ...persistedSpeech } = next
  const patch: any = {
    ...persistedSpeech,
    ...(apiKeyPatch === null ? { apiKey: null } : {}),
  }

  if (updates.separateProviders !== undefined || sttApiKeyPatch !== undefined || ttsApiKeyPatch !== undefined) {
    if (updates.separateProviders !== undefined) {
      patch.separateProviders = updates.separateProviders
    }
    if (sttApiKeyPatch !== undefined) {
      const { hasApiKey: _sttHas, ...sttRest } = patch.stt ?? {}
      patch.stt = {
        ...sttRest,
        ...(sttApiKeyPatch === null ? { apiKey: null } : { apiKey: sttApiKeyPatch }),
      }
    }
    if (ttsApiKeyPatch !== undefined) {
      const { hasApiKey: _ttsHas, ...ttsRest } = patch.tts ?? {}
      patch.tts = {
        ...ttsRest,
        ...(ttsApiKeyPatch === null ? { apiKey: null } : { apiKey: ttsApiKeyPatch }),
      }
    }
  }

  try {
    await patchConfigOwner("server", { speech: patch })
  } catch (error) {
    log.error("Failed to update speech settings", error)
    throw error
  }
}
```

- [ ] **Step 5: Update `SpeechSettingsUpdate` type**

Find the `SpeechSettingsUpdate` type (around line 61) and extend it:

```typescript
export type SpeechSettingsUpdate = Partial<Omit<SpeechSettings, "apiKey" | "stt" | "tts">> & {
  apiKey?: string | null
  separateProviders?: boolean
  stt?: { apiKey?: string | null; baseUrl?: string; model?: string }
  tts?: { apiKey?: string | null; baseUrl?: string; model?: string }
}
```

- [ ] **Step 6: Run typecheck**

Run: `cd packages/ui && npx tsc --noEmit -p tsconfig.json`
Expected: Errors in `speech-settings-card.tsx` (it uses `DraftFields` which we haven't updated yet — that's Task 6). The `preferences.tsx` file itself should have no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/stores/preferences.tsx
git commit -m "feat(speech): extend SpeechSettings type with per-direction config

Add separateProviders boolean and stt/tts sub-objects to SpeechSettings.
Update normalizeSpeechSettings and updateSpeechSettings to handle
per-direction apiKey/baseUrl/model with the same hasApiKey strip
pattern used for the shared apiKey.

SpeechSettingsUpdate gains separateProviders and stt/tts patch support
where apiKey: null means 'clear the stored key'."
```

---

### Task 5: UI Capability Checks — Use Per-Direction Configured Fields

**Files:**
- Modify: `packages/ui/src/components/prompt-input/usePromptVoiceInput.ts` (line ~44-52)
- Modify: `packages/ui/src/stores/conversation-speech.ts` (lines ~101-113 and ~290-296)

**Interfaces:**
- Consumes: `SpeechCapabilitiesResponse` with new `sttConfigured`/`ttsConfigured` fields (from Task 1)

- [ ] **Step 1: Update `usePromptVoiceInput.ts` STT capability check**

In `packages/ui/src/components/prompt-input/usePromptVoiceInput.ts`, find the `canUseVoiceInput` function (around line 43). Replace `capabilities?.configured` with `capabilities?.sttConfigured`:

```typescript
  const canUseVoiceInput = () => {
    const capabilities = speechCapabilities()
    return Boolean(
      options.enabled() &&
        isSupported() &&
        capabilities?.available &&
        capabilities?.sttConfigured &&
        capabilities?.supportsStt,
    )
  }
```

- [ ] **Step 2: Update `conversation-speech.ts` TTS capability checks**

In `packages/ui/src/stores/conversation-speech.ts`, find `canUseConversationMode` (around line 101). Replace `capabilities.configured` with `capabilities.ttsConfigured`:

```typescript
export function canUseConversationMode(): boolean {
  const capabilities = speechCapabilities()
  if (!capabilities?.available || !capabilities.ttsConfigured || !capabilities.supportsTts) {
    return false
  }
  // ... rest unchanged
```

Also find `createPlaybackHandle` (around line 290). Replace `capabilities.configured` with `capabilities.ttsConfigured`:

```typescript
  if (!capabilities?.available || !capabilities.ttsConfigured || !capabilities.supportsTts) {
    throw new Error(tGlobal("messageItem.actions.speak.error.unavailable"))
  }
```

- [ ] **Step 3: Run typecheck**

Run: `cd packages/ui && npx tsc --noEmit -p tsconfig.json`
Expected: No new errors from these files (speech-settings-card.tsx may still error from Task 4 changes — resolved in Task 6).

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/prompt-input/usePromptVoiceInput.ts packages/ui/src/stores/conversation-speech.ts
git commit -m "fix(speech): use per-direction configured checks for STT and TTS

Voice input now checks sttConfigured instead of the combined configured
field, and conversation mode checks ttsConfigured. This allows voice
input to work when only STT is configured, and vice versa."
```

---

### Task 6: UI Settings Card — Toggle & Per-Direction Sections

**Files:**
- Modify: `packages/ui/src/components/settings/speech-settings-card.tsx`

**Interfaces:**
- Consumes: Extended `SpeechSettings` with `separateProviders`/`stt`/`tts` (from Task 4)
- Consumes: `updateSpeechSettings` accepting per-direction patches (from Task 4)

This is the largest UI task. The card needs a toggle, and when enabled, two sections replace the shared API Key / Base URL / Model fields.

- [ ] **Step 1: Update `DraftFields` type and `createDraftFields`**

In `packages/ui/src/components/settings/speech-settings-card.tsx`, replace the `DraftFields` type (around line 12):

```typescript
type DirectionalDraft = {
  apiKey: string
  apiKeyTouched: boolean
  clearApiKey: boolean
  baseUrl: string
  model: string
}

type DraftFields = {
  separateProviders: boolean
  apiKey: string
  baseUrl: string
  sttModel: string
  ttsModel: string
  ttsVoice: string
  playbackMode: SpeechSettings["playbackMode"]
  ttsFormat: SpeechSettings["ttsFormat"]
  stt: DirectionalDraft
  tts: DirectionalDraft
}
```

Replace `createDraftFields` (around line 22):

```typescript
function createDirectionalDraft(
  direction: "stt" | "tts",
  speech: SpeechSettings,
): DirectionalDraft {
  const dir = speech[direction]
  return {
    apiKey: "",
    apiKeyTouched: false,
    clearApiKey: false,
    baseUrl: dir.baseUrl ?? "",
    model: dir.model,
  }
}

function createDraftFields(speech: SpeechSettings): DraftFields {
  return {
    separateProviders: speech.separateProviders,
    apiKey: "",
    baseUrl: speech.baseUrl ?? "",
    sttModel: speech.sttModel,
    ttsModel: speech.ttsModel,
    ttsVoice: speech.ttsVoice,
    playbackMode: speech.playbackMode,
    ttsFormat: speech.ttsFormat,
    stt: createDirectionalDraft("stt", speech),
    tts: createDirectionalDraft("tts", speech),
  }
}
```

- [ ] **Step 2: Update `isDraftEqual`**

Replace the `isDraftEqual` function (around line 34):

```typescript
function isDirectionalDraftEqual(a: DirectionalDraft, b: DirectionalDraft): boolean {
  return (
    a.apiKey === b.apiKey &&
    a.apiKeyTouched === b.apiKeyTouched &&
    a.clearApiKey === b.clearApiKey &&
    a.baseUrl === b.baseUrl &&
    a.model === b.model
  )
}

function isDraftEqual(a: DraftFields, b: DraftFields): boolean {
  return (
    a.separateProviders === b.separateProviders &&
    a.apiKey === b.apiKey &&
    a.baseUrl === b.baseUrl &&
    a.sttModel === b.sttModel &&
    a.ttsModel === b.ttsModel &&
    a.ttsVoice === b.ttsVoice &&
    a.playbackMode === b.playbackMode &&
    a.ttsFormat === b.ttsFormat &&
    isDirectionalDraftEqual(a.stt, b.stt) &&
    isDirectionalDraftEqual(a.tts, b.tts)
  )
}
```

- [ ] **Step 3: Add per-direction signals and update the component**

In the `SpeechSettingsCard` component body, after the existing `clearStoredApiKey` signal (around line 54), add directional state signals:

```typescript
  const [sttApiKeyTouched, setSttApiKeyTouched] = createSignal(false)
  const [clearSttApiKey, setClearSttApiKey] = createSignal(false)
  const [ttsApiKeyTouched, setTtsApiKeyTouched] = createSignal(false)
  const [clearTtsApiKey, setClearTtsApiKey] = createSignal(false)
```

- [ ] **Step 4: Update the `createEffect` that syncs drafts from server settings**

Find the `createEffect` block around line 65 that resets drafts. Extend it to also reset directional state:

```typescript
  createEffect(() => {
    const speech = serverSettings().speech
    const nextDrafts = createDraftFields(speech)
    if (!isSaving() && !isDirty()) {
      if (!isDraftEqual(drafts(), nextDrafts)) {
        setDrafts(nextDrafts)
      }
      if (apiKeyTouched()) setApiKeyTouched(false)
      if (clearStoredApiKey()) setClearStoredApiKey(false)
      if (sttApiKeyTouched()) setSttApiKeyTouched(false)
      if (clearSttApiKey()) setClearSttApiKey(false)
      if (ttsApiKeyTouched()) setTtsApiKeyTouched(false)
      if (clearTtsApiKey()) setClearTtsApiKey(false)
    }
  })
```

- [ ] **Step 5: Add directional update helpers**

After the existing `updateDraft` function (around line 91), add:

```typescript
  const updateDirectionalDraft = (dir: "stt" | "tts", key: keyof DirectionalDraft, value: string) => {
    setSaveStatus("idle")
    if (key === "apiKey") {
      if (dir === "stt") {
        setSttApiKeyTouched(true)
        setClearSttApiKey(false)
      } else {
        setTtsApiKeyTouched(true)
        setClearTtsApiKey(false)
      }
    }
    setDrafts((current) => ({
      ...current,
      [dir]: { ...current[dir], [key]: value },
    }))
  }
```

- [ ] **Step 6: Update `isDirty`**

Replace the `isDirty` memo (around line 122) to account for separate providers mode:

```typescript
  const isDirty = createMemo(() => {
    const speech = serverSettings().speech
    const current = drafts()

    if (current.separateProviders !== speech.separateProviders) return true

    if (current.separateProviders) {
      const sttDirty =
        clearSttApiKey() ||
        current.stt.apiKey.trim().length > 0 ||
        (current.stt.baseUrl || "") !== (speech.stt.baseUrl || "") ||
        current.stt.model !== speech.stt.model
      const ttsDirty =
        clearTtsApiKey() ||
        current.tts.apiKey.trim().length > 0 ||
        (current.tts.baseUrl || "") !== (speech.tts.baseUrl || "") ||
        current.tts.model !== speech.tts.model ||
        current.ttsVoice !== speech.ttsVoice ||
        current.playbackMode !== speech.playbackMode ||
        current.ttsFormat !== speech.ttsFormat
      return sttDirty || ttsDirty
    }

    return (
      apiKeyDirty() ||
      (current.baseUrl || "") !== (speech.baseUrl || "") ||
      current.sttModel !== speech.sttModel ||
      current.ttsModel !== speech.ttsModel ||
      current.ttsVoice !== speech.ttsVoice ||
      current.playbackMode !== speech.playbackMode ||
      current.ttsFormat !== speech.ttsFormat
    )
  })
```

- [ ] **Step 7: Update `handleSave`**

Replace the `handleSave` function (around line 143) to handle both modes:

```typescript
  async function handleSave() {
    if (!isDirty() || isSaving()) return
    const current = drafts()
    setIsSaving(true)
    setSaveStatus("idle")
    try {
      if (current.separateProviders) {
        const sttApiKeyTrimmed = current.stt.apiKey.trim()
        const ttsApiKeyTrimmed = current.tts.apiKey.trim()
        await updateSpeechSettings({
          separateProviders: true,
          ...(clearSttApiKey() ? { stt: { apiKey: null } } : sttApiKeyTrimmed ? { stt: { apiKey: sttApiKeyTrimmed } } : {}),
          stt: {
            ...(clearSttApiKey() ? { apiKey: null } : sttApiKeyTrimmed ? { apiKey: sttApiKeyTrimmed } : {}),
            baseUrl: current.stt.baseUrl.trim() || undefined,
            model: current.stt.model.trim() || undefined,
          },
          tts: {
            ...(clearTtsApiKey() ? { apiKey: null } : ttsApiKeyTrimmed ? { apiKey: ttsApiKeyTrimmed } : {}),
            baseUrl: current.tts.baseUrl.trim() || undefined,
            model: current.tts.model.trim() || undefined,
          },
          ttsVoice: current.ttsVoice.trim() || undefined,
          playbackMode: current.playbackMode,
          ttsFormat: current.ttsFormat,
        } as any)
      } else {
        const trimmedApiKey = current.apiKey.trim()
        await updateSpeechSettings({
          separateProviders: false,
          ...(clearStoredApiKey() ? { apiKey: null } : trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
          baseUrl: current.baseUrl.trim() || undefined,
          sttModel: current.sttModel.trim() || undefined,
          ttsModel: current.ttsModel.trim() || undefined,
          ttsVoice: current.ttsVoice.trim() || undefined,
          playbackMode: current.playbackMode,
          ttsFormat: current.ttsFormat,
        })
      }
      await loadSpeechCapabilities(true)
      setDrafts(createDraftFields(serverSettings().speech))
      setApiKeyTouched(false)
      setClearStoredApiKey(false)
      setSttApiKeyTouched(false)
      setClearSttApiKey(false)
      setTtsApiKeyTouched(false)
      setClearTtsApiKey(false)
      setSaveStatus("saved")
    } catch (error) {
      log.error("Failed to save speech settings", error)
      setSaveStatus("error")
    } finally {
      setIsSaving(false)
    }
  }
```

- [ ] **Step 8: Update the JSX render**

In the `return` statement of `SpeechSettingsCard`, after the provider row and before the shared API Key `Field`, add the toggle. Then wrap the shared fields and the per-direction sections in `<Show>` blocks based on `drafts().separateProviders`.

After the provider toggle row closing `</div>` (around line 238), add the separateProviders toggle:

```tsx
        <div class="settings-toggle-row settings-toggle-row-compact">
          <div>
            <div class="settings-toggle-title">{t("settings.speech.separateProviders.title")}</div>
            <div class="settings-toggle-caption">{t("settings.speech.separateProviders.subtitle")}</div>
          </div>
          <button
            type="button"
            class="settings-toggle-switch"
            role="switch"
            aria-checked={drafts().separateProviders}
            onClick={() => updateDraft("separateProviders" as any, String(!drafts().separateProviders))}
          >
            <span class="settings-toggle-thumb" data-on={drafts().separateProviders} />
          </button>
        </div>

        <Show when={!drafts().separateProviders}>
          {/* --- shared fields (existing layout) --- */}
          <Field
            label={t("settings.speech.apiKey.title")}
            caption={t("settings.speech.apiKey.subtitle")}
            value={drafts().apiKey}
            onInput={(value) => updateDraft("apiKey", value)}
            type="password"
            placeholder={serverSettings().speech.hasApiKey ? t("settings.speech.apiKey.placeholder") : undefined}
          />
          <Show when={serverSettings().speech.hasApiKey && !apiKeyTouched() && drafts().apiKey.length === 0}>
            <div class="settings-inline-note">
              {clearStoredApiKey() ? t("settings.speech.apiKey.clearPending") : t("settings.speech.apiKey.storedNote")}{" "}
              <Show when={!clearStoredApiKey()}>
                <button
                  type="button"
                  class="selector-button selector-button-secondary w-auto whitespace-nowrap"
                  onClick={() => { setClearStoredApiKey(true); setSaveStatus("idle") }}
                >
                  {t("settings.speech.apiKey.clearAction")}
                </button>
              </Show>
            </div>
          </Show>
          <Field
            label={t("settings.speech.baseUrl.title")}
            caption={t("settings.speech.baseUrl.subtitle")}
            value={drafts().baseUrl}
            onInput={(value) => updateDraft("baseUrl", value)}
            placeholder={t("settings.speech.baseUrl.placeholder")}
          />
          <Field
            label={t("settings.speech.sttModel.title")}
            caption={t("settings.speech.sttModel.subtitle")}
            value={drafts().sttModel}
            onInput={(value) => updateDraft("sttModel", value)}
          />
          <Field
            label={t("settings.speech.ttsModel.title")}
            caption={t("settings.speech.ttsModel.subtitle")}
            value={drafts().ttsModel}
            onInput={(value) => updateDraft("ttsModel", value)}
          />
          <Field
            label={t("settings.speech.ttsVoice.title")}
            caption={t("settings.speech.ttsVoice.subtitle")}
            value={drafts().ttsVoice}
            onInput={(value) => updateDraft("ttsVoice", value)}
            icon={<Mic class="w-3.5 h-3.5 icon-muted flex-shrink-0" />}
          />
        </Show>

        <Show when={drafts().separateProviders}>
          {/* --- STT section --- */}
          <div class="settings-card-section-header">
            <h4 class="settings-card-section-title">{t("settings.speech.stt.section.title")}</h4>
          </div>
          <Field
            label={t("settings.speech.stt.apiKey.title")}
            caption={t("settings.speech.stt.apiKey.subtitle")}
            value={drafts().stt.apiKey}
            onInput={(value) => updateDirectionalDraft("stt", "apiKey", value)}
            type="password"
            placeholder={serverSettings().speech.stt.hasApiKey ? t("settings.speech.stt.apiKey.placeholder") : undefined}
          />
          <Show when={serverSettings().speech.stt.hasApiKey && !sttApiKeyTouched() && drafts().stt.apiKey.length === 0}>
            <div class="settings-inline-note">
              {clearSttApiKey() ? t("settings.speech.stt.apiKey.clearPending") : t("settings.speech.stt.apiKey.storedNote")}{" "}
              <Show when={!clearSttApiKey()}>
                <button
                  type="button"
                  class="selector-button selector-button-secondary w-auto whitespace-nowrap"
                  onClick={() => { setClearSttApiKey(true); setSaveStatus("idle") }}
                >
                  {t("settings.speech.stt.apiKey.clearAction")}
                </button>
              </Show>
            </div>
          </Show>
          <Field
            label={t("settings.speech.stt.baseUrl.title")}
            caption={t("settings.speech.stt.baseUrl.subtitle")}
            value={drafts().stt.baseUrl}
            onInput={(value) => updateDirectionalDraft("stt", "baseUrl", value)}
            placeholder={t("settings.speech.stt.baseUrl.placeholder")}
          />
          <Field
            label={t("settings.speech.stt.model.title")}
            caption={t("settings.speech.stt.model.subtitle")}
            value={drafts().stt.model}
            onInput={(value) => updateDirectionalDraft("stt", "model", value)}
          />

          {/* --- TTS section --- */}
          <div class="settings-card-section-header">
            <h4 class="settings-card-section-title">{t("settings.speech.tts.section.title")}</h4>
          </div>
          <Field
            label={t("settings.speech.tts.apiKey.title")}
            caption={t("settings.speech.tts.apiKey.subtitle")}
            value={drafts().tts.apiKey}
            onInput={(value) => updateDirectionalDraft("tts", "apiKey", value)}
            type="password"
            placeholder={serverSettings().speech.tts.hasApiKey ? t("settings.speech.tts.apiKey.placeholder") : undefined}
          />
          <Show when={serverSettings().speech.tts.hasApiKey && !ttsApiKeyTouched() && drafts().tts.apiKey.length === 0}>
            <div class="settings-inline-note">
              {clearTtsApiKey() ? t("settings.speech.tts.apiKey.clearPending") : t("settings.speech.tts.apiKey.storedNote")}{" "}
              <Show when={!clearTtsApiKey()}>
                <button
                  type="button"
                  class="selector-button selector-button-secondary w-auto whitespace-nowrap"
                  onClick={() => { setClearTtsApiKey(true); setSaveStatus("idle") }}
                >
                  {t("settings.speech.tts.apiKey.clearAction")}
                </button>
              </Show>
            </div>
          </Show>
          <Field
            label={t("settings.speech.tts.baseUrl.title")}
            caption={t("settings.speech.tts.baseUrl.subtitle")}
            value={drafts().tts.baseUrl}
            onInput={(value) => updateDirectionalDraft("tts", "baseUrl", value)}
            placeholder={t("settings.speech.tts.baseUrl.placeholder")}
          />
          <Field
            label={t("settings.speech.tts.model.title")}
            caption={t("settings.speech.tts.model.subtitle")}
            value={drafts().tts.model}
            onInput={(value) => updateDirectionalDraft("tts", "model", value)}
          />
          <Field
            label={t("settings.speech.ttsVoice.title")}
            caption={t("settings.speech.ttsVoice.subtitle")}
            value={drafts().ttsVoice}
            onInput={(value) => updateDraft("ttsVoice", value)}
            icon={<Mic class="w-3.5 h-3.5 icon-muted flex-shrink-0" />}
          />
        </Show>

        {/* Playback mode and format always visible */}
        <SelectField
          label={t("settings.speech.playbackMode.title")}
          caption={t("settings.speech.playbackMode.subtitle")}
          value={drafts().playbackMode}
          onInput={(value) => updateDraft("playbackMode", value as DraftFields["playbackMode"])}
          options={[
            { value: "streaming", label: t("settings.speech.playbackMode.streaming") },
            { value: "buffered", label: t("settings.speech.playbackMode.buffered") },
          ]}
        />
        <SelectField
          label={t("settings.speech.ttsFormat.title")}
          caption={t("settings.speech.ttsFormat.subtitle")}
          value={drafts().ttsFormat}
          onInput={(value) => updateDraft("ttsFormat", value as DraftFields["ttsFormat"])}
          options={[
            { value: "mp3", label: "MP3" },
            { value: "wav", label: "WAV" },
            { value: "opus", label: "Opus" },
            { value: "aac", label: "AAC" },
          ]}
        />
```

Note: The existing shared-mode fields (API Key, Base URL, STT Model, TTS Model, TTS Voice, Playback Mode, TTS Format) should be moved inside the `<Show when={!drafts().separateProviders}>` block. Playback Mode and TTS Format stay outside both blocks since they apply regardless.

- [ ] **Step 9: Import `Show` if not already imported**

Check the imports at the top of the file. `Show` is already imported from `solid-js` in the existing code (line 1). If not, add it.

- [ ] **Step 10: Run typecheck**

Run: `cd packages/ui && npx tsc --noEmit -p tsconfig.json`
Expected: No errors.

- [ ] **Step 11: Commit**

```bash
git add packages/ui/src/components/settings/speech-settings-card.tsx
git commit -m "feat(speech): add separate providers toggle to settings card

Add a toggle at the top of the speech settings card that switches
between shared and per-direction provider config. When enabled, the
card shows separate Input (STT) and Output (TTS) sections with their
own API key, base URL, and model fields. Playback mode and format
remain shared.

Each direction has its own API key stored-note/clear pattern, matching
the existing shared apiKey UX. Toggling off preserves per-direction
config in storage but ignores it at runtime."
```

---

### Task 7: i18n Strings — All 8 Locales

**Files:**
- Modify: `packages/ui/src/lib/i18n/messages/en/settings.ts`
- Modify: `packages/ui/src/lib/i18n/messages/es/settings.ts`
- Modify: `packages/ui/src/lib/i18n/messages/ja/settings.ts`
- Modify: `packages/ui/src/lib/i18n/messages/zh-Hans/settings.ts`
- Modify: `packages/ui/src/lib/i18n/messages/fr/settings.ts`
- Modify: `packages/ui/src/lib/i18n/messages/de/settings.ts`
- Modify: `packages/ui/src/lib/i18n/messages/he/settings.ts`
- Modify: `packages/ui/src/lib/i18n/messages/ne/settings.ts`

**Interfaces:**
- Produces: ~27 new i18n keys per locale file, placed after the existing `settings.speech.save.error` key

- [ ] **Step 1: Add English keys**

In `packages/ui/src/lib/i18n/messages/en/settings.ts`, after the line `"settings.speech.save.error": "Save failed",` (around line 305), add:

```typescript
  "settings.speech.separateProviders.title": "Separate providers for input and output",
  "settings.speech.separateProviders.subtitle": "Use different API keys and endpoints for voice input (STT) and output (TTS).",
  "settings.speech.stt.section.title": "Voice Input (Speech-to-Text)",
  "settings.speech.tts.section.title": "Voice Output (Text-to-Speech)",
  "settings.speech.stt.apiKey.title": "Input API key",
  "settings.speech.stt.apiKey.subtitle": "Used for speech-to-text transcription requests.",
  "settings.speech.stt.apiKey.placeholder": "Enter a new input API key",
  "settings.speech.stt.apiKey.storedNote": "A saved input API key is hidden. Enter a new value to replace it, or leave the field blank to keep it.",
  "settings.speech.stt.apiKey.clearAction": "Clear saved input key",
  "settings.speech.stt.apiKey.clearPending": "The saved input API key will be removed when you save.",
  "settings.speech.stt.baseUrl.title": "Input base URL",
  "settings.speech.stt.baseUrl.subtitle": "OpenAI-compatible endpoint for transcription requests.",
  "settings.speech.stt.baseUrl.placeholder": "https://api.groq.com/openai/v1",
  "settings.speech.stt.model.title": "Input model",
  "settings.speech.stt.model.subtitle": "Model used for speech-to-text.",
  "settings.speech.tts.apiKey.title": "Output API key",
  "settings.speech.tts.apiKey.subtitle": "Used for text-to-speech synthesis requests.",
  "settings.speech.tts.apiKey.placeholder": "Enter a new output API key",
  "settings.speech.tts.apiKey.storedNote": "A saved output API key is hidden. Enter a new value to replace it, or leave the field blank to keep it.",
  "settings.speech.tts.apiKey.clearAction": "Clear saved output key",
  "settings.speech.tts.apiKey.clearPending": "The saved output API key will be removed when you save.",
  "settings.speech.tts.baseUrl.title": "Output base URL",
  "settings.speech.tts.baseUrl.subtitle": "OpenAI-compatible endpoint for synthesis requests.",
  "settings.speech.tts.model.title": "Output model",
  "settings.speech.tts.model.subtitle": "Model used for text-to-speech.",
```

- [ ] **Step 2: Add translated keys for the other 7 locales**

For each locale file (`es`, `ja`, `zh-Hans`, `fr`, `de`, `he`, `ne`), add the same 25 keys after the `settings.speech.save.error` line in the respective file. Use appropriate translations. Below are the translations for each locale:

**zh-Hans** (`packages/ui/src/lib/i18n/messages/zh-Hans/settings.ts`):

```typescript
  "settings.speech.separateProviders.title": "为输入和输出使用不同供应商",
  "settings.speech.separateProviders.subtitle": "为语音输入 (STT) 和语音输出 (TTS) 使用不同的 API 密钥和端点。",
  "settings.speech.stt.section.title": "语音输入 (语音转文字)",
  "settings.speech.tts.section.title": "语音输出 (文字转语音)",
  "settings.speech.stt.apiKey.title": "输入 API 密钥",
  "settings.speech.stt.apiKey.subtitle": "用于语音转文字请求。",
  "settings.speech.stt.apiKey.placeholder": "输入新的输入 API 密钥",
  "settings.speech.stt.apiKey.storedNote": "已保存的输入 API 密钥已隐藏。输入新值可替换，留空则保留当前密钥。",
  "settings.speech.stt.apiKey.clearAction": "清除已保存的输入密钥",
  "settings.speech.stt.apiKey.clearPending": "保存后将删除已保存的输入 API 密钥。",
  "settings.speech.stt.baseUrl.title": "输入基础 URL",
  "settings.speech.stt.baseUrl.subtitle": "用于语音转文字的 OpenAI 兼容端点。",
  "settings.speech.stt.baseUrl.placeholder": "https://api.groq.com/openai/v1",
  "settings.speech.stt.model.title": "输入模型",
  "settings.speech.stt.model.subtitle": "用于语音转文字的模型。",
  "settings.speech.tts.apiKey.title": "输出 API 密钥",
  "settings.speech.tts.apiKey.subtitle": "用于文字转语音请求。",
  "settings.speech.tts.apiKey.placeholder": "输入新的输出 API 密钥",
  "settings.speech.tts.apiKey.storedNote": "已保存的输出 API 密钥已隐藏。输入新值可替换，留空则保留当前密钥。",
  "settings.speech.tts.apiKey.clearAction": "清除已保存的输出密钥",
  "settings.speech.tts.apiKey.clearPending": "保存后将删除已保存的输出 API 密钥。",
  "settings.speech.tts.baseUrl.title": "输出基础 URL",
  "settings.speech.tts.baseUrl.subtitle": "用于文字转语音的 OpenAI 兼容端点。",
  "settings.speech.tts.model.title": "输出模型",
  "settings.speech.tts.model.subtitle": "用于文字转语音的模型。",
```

**es** (`packages/ui/src/lib/i18n/messages/es/settings.ts`):

```typescript
  "settings.speech.separateProviders.title": "Proveedores separados para entrada y salida",
  "settings.speech.separateProviders.subtitle": "Usar diferentes claves API y endpoints para entrada de voz (STT) y salida (TTS).",
  "settings.speech.stt.section.title": "Entrada de voz (Voz a texto)",
  "settings.speech.tts.section.title": "Salida de voz (Texto a voz)",
  "settings.speech.stt.apiKey.title": "Clave API de entrada",
  "settings.speech.stt.apiKey.subtitle": "Usada para solicitudes de voz a texto.",
  "settings.speech.stt.apiKey.placeholder": "Introduce una nueva clave API de entrada",
  "settings.speech.stt.apiKey.storedNote": "Hay una clave API de entrada guardada y oculta. Introduce un nuevo valor para reemplazarla.",
  "settings.speech.stt.apiKey.clearAction": "Borrar clave de entrada guardada",
  "settings.speech.stt.apiKey.clearPending": "La clave API de entrada guardada se eliminará al guardar.",
  "settings.speech.stt.baseUrl.title": "URL base de entrada",
  "settings.speech.stt.baseUrl.subtitle": "Endpoint compatible con OpenAI para transcripción.",
  "settings.speech.stt.baseUrl.placeholder": "https://api.groq.com/openai/v1",
  "settings.speech.stt.model.title": "Modelo de entrada",
  "settings.speech.stt.model.subtitle": "Modelo usado para voz a texto.",
  "settings.speech.tts.apiKey.title": "Clave API de salida",
  "settings.speech.tts.apiKey.subtitle": "Usada para solicitudes de texto a voz.",
  "settings.speech.tts.apiKey.placeholder": "Introduce una nueva clave API de salida",
  "settings.speech.tts.apiKey.storedNote": "Hay una clave API de salida guardada y oculta. Introduce un nuevo valor para reemplazarla.",
  "settings.speech.tts.apiKey.clearAction": "Borrar clave de salida guardada",
  "settings.speech.tts.apiKey.clearPending": "La clave API de salida guardada se eliminará al guardar.",
  "settings.speech.tts.baseUrl.title": "URL base de salida",
  "settings.speech.tts.baseUrl.subtitle": "Endpoint compatible con OpenAI para síntesis.",
  "settings.speech.tts.model.title": "Modelo de salida",
  "settings.speech.tts.model.subtitle": "Modelo usado para texto a voz.",
```

**ja** (`packages/ui/src/lib/i18n/messages/ja/settings.ts`):

```typescript
  "settings.speech.separateProviders.title": "入力と出力で異なるプロバイダーを使用",
  "settings.speech.separateProviders.subtitle": "音声入力 (STT) と音声出力 (TTS) で異なる API キーとエンドポイントを使用します。",
  "settings.speech.stt.section.title": "音声入力 (音声からテキスト)",
  "settings.speech.tts.section.title": "音声出力 (テキストから音声)",
  "settings.speech.stt.apiKey.title": "入力 API キー",
  "settings.speech.stt.apiKey.subtitle": "音声からテキストのリクエストに使用されます。",
  "settings.speech.stt.apiKey.placeholder": "新しい入力 API キーを入力",
  "settings.speech.stt.apiKey.storedNote": "保存済みの入力 API キーは非表示です。新しい値を入力して置き換えるか、空欄のままにしてください。",
  "settings.speech.stt.apiKey.clearAction": "保存済みの入力キーを削除",
  "settings.speech.stt.apiKey.clearPending": "保存すると、保存済みの入力 API キーが削除されます。",
  "settings.speech.stt.baseUrl.title": "入力ベース URL",
  "settings.speech.stt.baseUrl.subtitle": "文字起こし用の OpenAI 互換エンドポイントです。",
  "settings.speech.stt.baseUrl.placeholder": "https://api.groq.com/openai/v1",
  "settings.speech.stt.model.title": "入力モデル",
  "settings.speech.stt.model.subtitle": "音声からテキストに使用するモデルです。",
  "settings.speech.tts.apiKey.title": "出力 API キー",
  "settings.speech.tts.apiKey.subtitle": "テキストから音声のリクエストに使用されます。",
  "settings.speech.tts.apiKey.placeholder": "新しい出力 API キーを入力",
  "settings.speech.tts.apiKey.storedNote": "保存済みの出力 API キーは非表示です。新しい値を入力して置き換えるか、空欄のままにしてください。",
  "settings.speech.tts.apiKey.clearAction": "保存済みの出力キーを削除",
  "settings.speech.tts.apiKey.clearPending": "保存すると、保存済みの出力 API キーが削除されます。",
  "settings.speech.tts.baseUrl.title": "出力ベース URL",
  "settings.speech.tts.baseUrl.subtitle": "音声合成用の OpenAI 互換エンドポイントです。",
  "settings.speech.tts.model.title": "出力モデル",
  "settings.speech.tts.model.subtitle": "テキストから音声に使用するモデルです。",
```

**fr** (`packages/ui/src/lib/i18n/messages/fr/settings.ts`):

```typescript
  "settings.speech.separateProviders.title": "Fournisseurs séparés pour l'entrée et la sortie",
  "settings.speech.separateProviders.subtitle": "Utiliser différentes clés API et points de terminaison pour l'entrée vocale (STT) et la sortie (TTS).",
  "settings.speech.stt.section.title": "Entrée vocale (Voix vers texte)",
  "settings.speech.tts.section.title": "Sortie vocale (Texte vers voix)",
  "settings.speech.stt.apiKey.title": "Clé API d'entrée",
  "settings.speech.stt.apiKey.subtitle": "Utilisée pour les requêtes de voix vers texte.",
  "settings.speech.stt.apiKey.placeholder": "Saisissez une nouvelle clé API d'entrée",
  "settings.speech.stt.apiKey.storedNote": "Une clé API d'entrée enregistrée est masquée. Saisissez une nouvelle valeur pour la remplacer.",
  "settings.speech.stt.apiKey.clearAction": "Effacer la clé d'entrée enregistrée",
  "settings.speech.stt.apiKey.clearPending": "La clé API d'entrée enregistrée sera supprimée lors de l'enregistrement.",
  "settings.speech.stt.baseUrl.title": "URL de base d'entrée",
  "settings.speech.stt.baseUrl.subtitle": "Point de terminaison compatible OpenAI pour la transcription.",
  "settings.speech.stt.baseUrl.placeholder": "https://api.groq.com/openai/v1",
  "settings.speech.stt.model.title": "Modèle d'entrée",
  "settings.speech.stt.model.subtitle": "Modèle utilisé pour la voix vers texte.",
  "settings.speech.tts.apiKey.title": "Clé API de sortie",
  "settings.speech.tts.apiKey.subtitle": "Utilisée pour les requêtes de texte vers voix.",
  "settings.speech.tts.apiKey.placeholder": "Saisissez une nouvelle clé API de sortie",
  "settings.speech.tts.apiKey.storedNote": "Une clé API de sortie enregistrée est masquée. Saisissez une nouvelle valeur pour la remplacer.",
  "settings.speech.tts.apiKey.clearAction": "Effacer la clé de sortie enregistrée",
  "settings.speech.tts.apiKey.clearPending": "La clé API de sortie enregistrée sera supprimée lors de l'enregistrement.",
  "settings.speech.tts.baseUrl.title": "URL de base de sortie",
  "settings.speech.tts.baseUrl.subtitle": "Point de terminaison compatible OpenAI pour la synthèse.",
  "settings.speech.tts.model.title": "Modèle de sortie",
  "settings.speech.tts.model.subtitle": "Modèle utilisé pour le texte vers voix.",
```

**de** (`packages/ui/src/lib/i18n/messages/de/settings.ts`):

```typescript
  "settings.speech.separateProviders.title": "Getrennte Anbieter für Ein- und Ausgabe",
  "settings.speech.separateProviders.subtitle": "Unterschiedliche API-Schlüssel und Endpunkte für Spracheingabe (STT) und Ausgabe (TTS) verwenden.",
  "settings.speech.stt.section.title": "Spracheingabe (Sprache zu Text)",
  "settings.speech.tts.section.title": "Sprachausgabe (Text zu Sprache)",
  "settings.speech.stt.apiKey.title": "Eingabe-API-Schlüssel",
  "settings.speech.stt.apiKey.subtitle": "Wird für Sprache-zu-Text-Anfragen verwendet.",
  "settings.speech.stt.apiKey.placeholder": "Neuen Eingabe-API-Schlüssel eingeben",
  "settings.speech.stt.apiKey.storedNote": "Ein gespeicherter Eingabe-API-Schlüssel ist ausgeblendet. Geben Sie einen neuen Wert ein, um ihn zu ersetzen.",
  "settings.speech.stt.apiKey.clearAction": "Gespeicherten Eingabe-Schlüssel löschen",
  "settings.speech.stt.apiKey.clearPending": "Der gespeicherte Eingabe-API-Schlüssel wird beim Speichern entfernt.",
  "settings.speech.stt.baseUrl.title": "Eingabe-Basis-URL",
  "settings.speech.stt.baseUrl.subtitle": "OpenAI-kompatibler Endpunkt für Transkription.",
  "settings.speech.stt.baseUrl.placeholder": "https://api.groq.com/openai/v1",
  "settings.speech.stt.model.title": "Eingabemodell",
  "settings.speech.stt.model.subtitle": "Modell für Sprache-zu-Text.",
  "settings.speech.tts.apiKey.title": "Ausgabe-API-Schlüssel",
  "settings.speech.tts.apiKey.subtitle": "Wird für Text-zu-Sprache-Anfragen verwendet.",
  "settings.speech.tts.apiKey.placeholder": "Neuen Ausgabe-API-Schlüssel eingeben",
  "settings.speech.tts.apiKey.storedNote": "Ein gespeicherter Ausgabe-API-Schlüssel ist ausgeblendet. Geben Sie einen neuen Wert ein, um ihn zu ersetzen.",
  "settings.speech.tts.apiKey.clearAction": "Gespeicherten Ausgabe-Schlüssel löschen",
  "settings.speech.tts.apiKey.clearPending": "Der gespeicherte Ausgabe-API-Schlüssel wird beim Speichern entfernt.",
  "settings.speech.tts.baseUrl.title": "Ausgabe-Basis-URL",
  "settings.speech.tts.baseUrl.subtitle": "OpenAI-kompatibler Endpunkt für Synthese.",
  "settings.speech.tts.model.title": "Ausgabemodell",
  "settings.speech.tts.model.subtitle": "Modell für Text-zu-Sprache.",
```

**he** (`packages/ui/src/lib/i18n/messages/he/settings.ts`):

```typescript
  "settings.speech.separateProviders.title": "ספקים נפרדים לקלט ולפלט",
  "settings.speech.separateProviders.subtitle": "שימוש במפתחות API ונקודות קצה שונים לקלט קולי (STT) ולפלט (TTS).",
  "settings.speech.stt.section.title": "קלט קולי (דיבור לטקסט)",
  "settings.speech.tts.section.title": "פלט קולי (טקסט לדיבור)",
  "settings.speech.stt.apiKey.title": "מפתח API לקלט",
  "settings.speech.stt.apiKey.subtitle": "משמש עבור בקשות דיבור לטקסט.",
  "settings.speech.stt.apiKey.placeholder": "הזן מפתח API חדש לקלט",
  "settings.speech.stt.apiKey.storedNote": "מפתח API קלט שמור מוסתר. הזן ערך חדש כדי להחליף אותו.",
  "settings.speech.stt.apiKey.clearAction": "נקה מפתח קלט שמור",
  "settings.speech.stt.apiKey.clearPending": "מפתח ה-API לקלט השמור יוסר בעת השמירה.",
  "settings.speech.stt.baseUrl.title": "כתובת בסיס לקלט",
  "settings.speech.stt.baseUrl.subtitle": "נקודת קצה תואמת OpenAI לתמלול.",
  "settings.speech.stt.baseUrl.placeholder": "https://api.groq.com/openai/v1",
  "settings.speech.stt.model.title": "מודל קלט",
  "settings.speech.stt.model.subtitle": "מודל המשמש לדיבור לטקסט.",
  "settings.speech.tts.apiKey.title": "מפתח API לפלט",
  "settings.speech.tts.apiKey.subtitle": "משמש עבור בקשות טקסט לדיבור.",
  "settings.speech.tts.apiKey.placeholder": "הזן מפתח API חדש לפלט",
  "settings.speech.tts.apiKey.storedNote": "מפתח API פלט שמור מוסתר. הזן ערך חדש כדי להחליף אותו.",
  "settings.speech.tts.apiKey.clearAction": "נקה מפתח פלט שמור",
  "settings.speech.tts.apiKey.clearPending": "מפתח ה-API לפלט השמור יוסר בעת השמירה.",
  "settings.speech.tts.baseUrl.title": "כתובת בסיס לפלט",
  "settings.speech.tts.baseUrl.subtitle": "נקודת קצה תואמת OpenAI לסינתזה.",
  "settings.speech.tts.model.title": "מודל פלט",
  "settings.speech.tts.model.subtitle": "מודל המשמש לטקסט לדיבור.",
```

**ne** (`packages/ui/src/lib/i18n/messages/ne/settings.ts`):

```typescript
  "settings.speech.separateProviders.title": "इनपुट र आउटपुटका लागि छुट्टाछुट्टै प्रदायक",
  "settings.speech.separateProviders.subtitle": "आवाज इनपुट (STT) र आउटपुट (TTS) का लागि फरक API कुञ्जीहरू र एन्डपोइन्टहरू प्रयोग गर्नुहोस्।",
  "settings.speech.stt.section.title": "आवाज इनपुट (आवाजबाट पाठ)",
  "settings.speech.tts.section.title": "आवाज आउटपुट (पाठबाट आवाज)",
  "settings.speech.stt.apiKey.title": "इनपुट API कुञ्जी",
  "settings.speech.stt.apiKey.subtitle": "आवाजबाट-पाठ अनुरोधहरूको लागि प्रयोग गरिन्छ।",
  "settings.speech.stt.apiKey.placeholder": "नयाँ इनपुट API कुञ्जी प्रविष्ट गर्नुहोस्",
  "settings.speech.stt.apiKey.storedNote": "बचत गरिएको इनपुट API कुञ्जी लुकाइएको छ। प्रतिस्थापन गर्न नयाँ मान प्रविष्ट गर्नुहोस्।",
  "settings.speech.stt.apiKey.clearAction": "बचत गरिएको इनपुट कुञ्जी सफा गर्नुहोस्",
  "settings.speech.stt.apiKey.clearPending": "बचत गर्दा बचत गरिएको इनपुट API कुञ्जी हटाइनेछ।",
  "settings.speech.stt.baseUrl.title": "इनपुट आधार URL",
  "settings.speech.stt.baseUrl.subtitle": "ट्रान्सक्रिप्सनका लागि OpenAI-संगत एन्डपोइन्ट।",
  "settings.speech.stt.baseUrl.placeholder": "https://api.groq.com/openai/v1",
  "settings.speech.stt.model.title": "इनपुट मोडेल",
  "settings.speech.stt.model.subtitle": "आवाजबाट पाठका लागि प्रयोग गरिने मोडेल।",
  "settings.speech.tts.apiKey.title": "आउटपुट API कुञ्जी",
  "settings.speech.tts.apiKey.subtitle": "पाठबाट-आवाज अनुरोधहरूको लागि प्रयोग गरिन्छ।",
  "settings.speech.tts.apiKey.placeholder": "नयाँ आउटपुट API कुञ्जी प्रविष्ट गर्नुहोस्",
  "settings.speech.tts.apiKey.storedNote": "बचत गरिएको आउटपुट API कुञ्जी लुकाइएको छ। प्रतिस्थापन गर्न नयाँ मान प्रविष्ट गर्नुहोस्।",
  "settings.speech.tts.apiKey.clearAction": "बचत गरिएको आउटपुट कुञ्जी सफा गर्नुहोस्",
  "settings.speech.tts.apiKey.clearPending": "बचत गर्दा बचत गरिएको आउटपुट API कुञ्जी हटाइनेछ।",
  "settings.speech.tts.baseUrl.title": "आउटपुट आधार URL",
  "settings.speech.tts.baseUrl.subtitle": "सिन्थेसिसका लागि OpenAI-संगत एन्डपोइन्ट।",
  "settings.speech.tts.model.title": "आउटपुट मोडेल",
  "settings.speech.tts.model.subtitle": "पाठबाट आवाजका लागि प्रयोग गरिने मोडेल।",
```

- [ ] **Step 3: Run typecheck**

Run: `cd packages/ui && npx tsc --noEmit -p tsconfig.json`
Expected: No errors. Duplicate keys would throw at build time per the merge helper.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/lib/i18n/messages/*/settings.ts
git commit -m "feat(i18n): add speech separate-providers strings for all locales

Add 25 new i18n keys per locale for the separateProviders toggle,
per-direction section titles, and per-direction API key / base URL /
model labels. All 8 locales (en, es, ja, zh-Hans, fr, de, he, ne)
are covered."
```

---

### Task 8: Final Verification

**Files:**
- No modifications — verification only

- [ ] **Step 1: Run all speech tests**

Run: `npx tsx --test packages/server/src/speech/service.test.ts packages/server/src/settings/public-config.test.ts`
Expected: All tests PASS.

- [ ] **Step 2: Run full server typecheck**

Run: `cd packages/server && npx tsc --noEmit -p tsconfig.json`
Expected: No errors.

- [ ] **Step 3: Run full UI typecheck**

Run: `cd packages/ui && npx tsc --noEmit -p tsconfig.json`
Expected: No errors.

- [ ] **Step 4: Verify no duplicate i18n keys**

The i18n merge helper throws at build time on duplicate keys. Run the UI build to verify:

Run: `cd packages/ui && npm run build 2>&1 | tail -5`
Expected: Build succeeds with no duplicate key errors.

- [ ] **Step 5: Manual smoke test (if dev server available)**

1. Start the dev server
2. Open Settings → Speech
3. Verify the "Separate providers" toggle appears
4. Toggle ON → verify two sections (Input/STT, Output/TTS) appear with their own fields
5. Toggle OFF → verify shared fields return
6. Configure separate providers, save, verify capabilities update
7. Test voice input with STT-only config
8. Test voice output with TTS-only config
