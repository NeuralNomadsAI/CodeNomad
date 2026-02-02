# Provider Configuration Guide

This directory contains documentation and examples for configuring LLM providers in CodeNomad.

## Available Providers

- **[Firmware.ai](firmware-ai.md)** - Unified API for 21+ models from OpenAI, Anthropic, Google, xAI, DeepSeek, Moonshot, and Cerebras

## Adding a New Provider

To add a new LLM provider to CodeNomad:

1. Create a new markdown file in this directory with provider documentation
2. Add an example configuration file in `examples/` directory
3. Update this README to include your provider
4. Submit a PR to the CodeNomad repository

## Provider Configuration Structure

Each provider configuration should include:

```jsonc
{
  "provider": {
    "provider-id": {
      "npm": "@ai-sdk/openai-compatible",  // or provider-specific SDK
      "name": "Provider Display Name",
      "options": {
        "baseURL": "https://api.provider.com/v1",
        "apiKey": "YOUR_API_KEY",  // User should replace this
        "timeout": 300000
      },
      "models": {
        "model-id": {
          "id": "provider/model-id",
          "name": "Model Display Name",
          "limit": {
            "context": 128000,
            "output": 16384
          },
          "reasoning": false,
          "modalities": {
            "input": ["text"],
            "output": ["text"]
          }
        }
      }
    }
  }
}
```

## Provider Features

The following features are commonly supported by providers:

| Feature | Description |
|---------|-------------|
| `streaming` | Server-Sent Events for real-time responses |
| `tools` | Function calling capabilities |
| `mcpServers` | MCP server integration |
| `thinking` | Extended thinking for reasoning models |
| `reasoningEffort` | Control reasoning intensity |
| `generationConfig` | Provider-specific generation settings |
| `safetySettings` | Safety/filtering configuration |

## Model Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | Provider-prefixed model ID |
| `name` | string | Human-readable model name |
| `limit.context` | integer | Maximum context tokens |
| `limit.output` | integer | Maximum output tokens |
| `reasoning` | boolean | Whether model supports reasoning |
| `modalities.input` | array | Supported input types (text, image) |
| `modalities.output` | array | Supported output types |
| `supports` | array | Optional feature flags |

## Examples

See the `examples/` directory for complete configuration files you can copy and modify.
