# Firmware.ai Provider Configuration

This document provides instructions for adding Firmware.ai as a provider in CodeNomad/OpenCode.

## Overview

[Firmware.ai](https://firmware.ai) provides unified access to 21+ models from OpenAI, Anthropic, Google, xAI, DeepSeek, Moonshot, and Cerebras through a single API.

**Key Features:**
- Unified API for 21+ models from multiple providers
- 5-hour rolling quota window
- OpenAI-compatible API (drop-in replacement)
- Streaming, tool calling, and MCP support
- Extended thinking for Anthropic models
- Reasoning effort control for reasoning models

## Adding Firmware.ai to Your Configuration

Copy the following configuration into your `~/.config/codenomad/opencode-config/opencode.jsonc` file:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "firmware": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Firmware AI",
      "options": {
        "baseURL": "https://app.firmware.ai/api/v1",
        "apiKey": "YOUR_FIRMWARE_API_KEY",
        "timeout": 300000
      },
      "models": {
        // OpenAI Models
        "openai-gpt-5-2": {
          "id": "openai/gpt-5.2",
          "name": "GPT 5.2",
          "limit": { "context": 200000, "output": 64000 }
        },
        "openai-gpt-5": {
          "id": "openai/gpt-5",
          "name": "GPT 5",
          "limit": { "context": 200000, "output": 64000 }
        },
        "openai-gpt-5-mini": {
          "id": "openai/gpt-5-mini",
          "name": "GPT 5 Mini",
          "limit": { "context": 200000, "output": 32000 }
        },
        "openai-gpt-5-nano": {
          "id": "openai/gpt-5-nano",
          "name": "GPT 5 Nano",
          "limit": { "context": 128000, "output": 16000 }
        },
        "openai-gpt-4o": {
          "id": "openai/gpt-4o",
          "name": "GPT 4o",
          "limit": { "context": 128000, "output": 16384 }
        },
        "openai-gpt-4o-mini": {
          "id": "openai/gpt-4o-mini",
          "name": "GPT 4o Mini",
          "limit": { "context": 128000, "output": 16384 }
        },
        
        // Anthropic Models
        "anthropic-claude-opus-4-5": {
          "id": "anthropic/claude-opus-4-5",
          "name": "Claude Opus 4.5",
          "limit": { "context": 200000, "output": 64000 },
          "reasoning": true,
          "supports": ["thinking", "tools"]
        },
        "anthropic-claude-sonnet-4-5-20250929": {
          "id": "anthropic/claude-sonnet-4-5-20250929",
          "name": "Claude Sonnet 4.5 (2025-09-29)",
          "limit": { "context": 200000, "output": 64000 },
          "supports": ["thinking", "tools"]
        },
        "anthropic-claude-haiku-4-5-20251001": {
          "id": "anthropic/claude-haiku-4-5-20251001",
          "name": "Claude Haiku 4.5 (2025-10-01)",
          "limit": { "context": 200000, "output": 32000 },
          "supports": ["thinking", "tools"]
        },
        
        // Google Models
        "google-gemini-3-pro-preview": {
          "id": "google/gemini-3-pro-preview",
          "name": "Gemini 3 Pro Preview",
          "limit": { "context": 1048576, "output": 64000 },
          "reasoning": true,
          "supports": ["generationConfig", "safetySettings"]
        },
        "google-gemini-3-flash-preview": {
          "id": "google/gemini-3-flash-preview",
          "name": "Gemini 3 Flash Preview",
          "limit": { "context": 1048576, "output": 64000 },
          "reasoning": true,
          "supports": ["generationConfig", "safetySettings"]
        },
        "google-gemini-2-5-pro": {
          "id": "google/gemini-2.5-pro",
          "name": "Gemini 2.5 Pro",
          "limit": { "context": 2000000, "output": 64000 },
          "reasoning": true,
          "supports": ["generationConfig", "safetySettings"]
        },
        "google-gemini-2-5-flash": {
          "id": "google/gemini-2.5-flash",
          "name": "Gemini 2.5 Flash",
          "limit": { "context": 1000000, "output": 64000 },
          "reasoning": true,
          "supports": ["generationConfig", "safetySettings"]
        },
        
        // xAI Models
        "xai-grok-4-fast-reasoning": {
          "id": "xai/grok-4-fast-reasoning",
          "name": "Grok 4 Fast Reasoning",
          "limit": { "context": 200000, "output": 64000 },
          "reasoning": true
        },
        "xai-grok-4-fast-non-reasoning": {
          "id": "xai/grok-4-fast-non-reasoning",
          "name": "Grok 4 Fast Non-Reasoning",
          "limit": { "context": 200000, "output": 64000 }
        },
        "xai-grok-code-fast-1": {
          "id": "xai/grok-code-fast-1",
          "name": "Grok Code Fast 1",
          "limit": { "context": 131072, "output": 32768 }
        },
        
        // DeepSeek Models
        "deepseek-deepseek-chat": {
          "id": "deepseek/deepseek-chat",
          "name": "DeepSeek Chat",
          "limit": { "context": 131072, "output": 16384 }
        },
        "deepseek-deepseek-reasoner": {
          "id": "deepseek/deepseek-reasoner",
          "name": "DeepSeek Reasoner",
          "limit": { "context": 131072, "output": 65536 },
          "reasoning": true
        },
        
        // Moonshot (Kimi) Models
        "moonshot-kimi-k2-thinking": {
          "id": "moonshot/kimi-k2-thinking",
          "name": "Kimi K2 Thinking",
          "limit": { "context": 256000, "output": 32000 },
          "reasoning": true
        },
        "moonshot-kimi-k2-thinking-turbo": {
          "id": "moonshot/kimi-k2-thinking-turbo",
          "name": "Kimi K2 Thinking Turbo",
          "limit": { "context": 256000, "output": 32000 },
          "reasoning": true
        },
        
        // Cerebras Models
        "cerebras-zai-glm-4-7": {
          "id": "cerebras/zai-glm-4.7",
          "name": "Zai GLM 4.7",
          "limit": { "context": 128000, "output": 16384 }
        }
      }
    }
  }
}
```

## Getting Your API Key

1. Sign up at [https://firmware.ai](https://firmware.ai)
2. Generate an API key from your dashboard
3. Replace `YOUR_FIRMWARE_API_KEY` in the configuration above

## API Documentation

For complete API documentation, visit: [https://docs.firmware.ai](https://docs.firmware.ai)

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | Create chat completions with streaming and tool calling |
| `GET /v1/models` | List available models |
| `GET /v1/quota` | Check 5-hour usage window |
| `POST /v1/research` | Start deep research jobs |
| `GET /v1/research/{id}` | Poll research status and results |
| `GET /v1/research` | List research jobs |

### Quota System

Firmware.ai uses a 5-hour rolling window for quota tracking. Use the `/v1/quota` endpoint to check your usage:

```bash
curl https://app.firmware.ai/api/v1/quota \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Response:
```json
{
  "used": 0.42,
  "reset": "2026-01-20T18:12:03.000Z"
}
```

- `used`: Decimal 0-1 representing percentage of quota used
- `reset`: ISO timestamp when the window resets (null if no active window)

## Supported Features

| Feature | Description |
|---------|-------------|
| **Streaming** | Server-Sent Events for real-time responses |
| **Tool Calling** | OpenAI-style function tools |
| **MCP Servers** | Server-side MCP tool execution |
| **Thinking** | Extended thinking for Anthropic models (`thinking` config) |
| **Reasoning Effort** | Control reasoning intensity: low/medium/high |
| **Generation Config** | Google-specific params (candidateCount, responseMimeType) |
| **Safety Settings** | Google safety filters |

## Model Capabilities

| Model | Reasoning | Tools | Thinking | Vision |
|-------|-----------|-------|----------|--------|
| GPT 5.x | No | ✓ | No | ✓ |
| GPT 4o | No | ✓ | No | ✓ |
| Claude 4.5 | ✓ | ✓ | ✓ | ✓ |
| Gemini 2.5 | ✓ | ✓ | No | ✓ |
| Grok 4 | ✓ | ✓ | No | No |
| DeepSeek Reasoner | ✓ | ✓ | No | No |
| Kimi K2 | ✓ | ✓ | No | No |

## Environment Variables (Optional)

If using environment variables instead of config:

```bash
export FIRMWARE_API_KEY="your-api-key"
export FIRMWARE_API_BASE="https://app.firmware.ai/api/v1"
export FIRMWARE_QUOTA_REFRESH_INTERVAL=300
```

## Troubleshooting

### 401 Unauthorized
- Check your API key is correct
- Ensure the key has not expired

### 429 Rate Limited
- You hit the 5-hour quota limit
- Wait for the `reset` timestamp or use a different model

### Models Not Showing
- Restart CodeNomad after updating config
- Check config syntax is valid JSONC
- Verify `baseURL` ends with `/v1`

## License

This configuration guide is provided as-is for CodeNomad users.
