import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { resolveLiveUpstream } from "./live-upstream"
import type { SettingsService } from "../settings/service"

function createMockSettings(serverConfig: Record<string, unknown>): SettingsService {
  return {
    getOwner: () => serverConfig,
  } as unknown as SettingsService
}

describe("resolveLiveUpstream", () => {
  it("resolves Gemini upstream options from speech.live settings", () => {
    const settings = createMockSettings({
      speech: {
        live: {
          provider: "gemini",
          geminiApiKey: "AIzaTestKey",
        },
      },
    })

    const upstream = resolveLiveUpstream(settings)
    assert.equal(upstream.host, "generativelanguage.googleapis.com")
    assert.equal(upstream.port, 443)
    assert.equal(upstream.secure, true)
    assert.equal(
      upstream.path,
      "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=AIzaTestKey",
    )
    assert.deepEqual(upstream.headers, {})
  })

  it("resolves OpenAI upstream options from speech.live settings", () => {
    const settings = createMockSettings({
      speech: {
        live: {
          provider: "openai",
          openaiApiKey: "sk-test-live",
          openaiModel: "gpt-4o-realtime-custom",
        },
      },
    })

    const upstream = resolveLiveUpstream(settings)
    assert.equal(upstream.host, "api.openai.com")
    assert.equal(upstream.port, 443)
    assert.equal(upstream.secure, true)
    assert.equal(upstream.path, "/v1/realtime?model=gpt-4o-realtime-custom")
    assert.equal(upstream.headers.Authorization, "Bearer sk-test-live")
    assert.equal(upstream.headers["OpenAI-Beta"], "realtime=v1")
  })

  it("allows overriding model via params for OpenAI", () => {
    const settings = createMockSettings({
      speech: {
        live: {
          provider: "openai",
          openaiApiKey: "sk-test-live",
        },
      },
    })

    const upstream = resolveLiveUpstream(settings, { model: "custom-model" })
    assert.equal(upstream.path, "/v1/realtime?model=custom-model")
  })

  it("throws if Gemini API key is missing", () => {
    const originalEnv = process.env.GEMINI_API_KEY
    delete process.env.GEMINI_API_KEY
    try {
      const settings = createMockSettings({
        speech: {
          live: {
            provider: "gemini",
          },
        },
      })
      assert.throws(() => resolveLiveUpstream(settings), /Gemini API key is not configured/)
    } finally {
      if (originalEnv) {
        process.env.GEMINI_API_KEY = originalEnv
      }
    }
  })

  it("throws if OpenAI API key is missing", () => {
    const originalEnv = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const settings = createMockSettings({
        speech: {
          live: {
            provider: "openai",
          },
        },
      })
      assert.throws(() => resolveLiveUpstream(settings), /OpenAI API key is not configured/)
    } finally {
      if (originalEnv) {
        process.env.OPENAI_API_KEY = originalEnv
      }
    }
  })
})
