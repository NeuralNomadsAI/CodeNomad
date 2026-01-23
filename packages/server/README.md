# Era Code Server

**Era Code Server** is the high-performance engine behind the Era Code cockpit. It transforms your machine into a robust development host, managing the lifecycle of multiple OpenCode instances and providing the low-latency data streams that long-haul builders demand. It bridges your local filesystem with the UI, ensuring that whether you are on localhost or a remote tunnel, you have the speed, clarity, and control of a native workspace.

## Features & Capabilities

### 🌍 Deployment Freedom
- **Remote Access**: Host Era Code on a powerful workstation and access it from your lightweight laptop.
- **Code Anywhere**: Tunnel in via VPN or SSH to code securely from coffee shops or while traveling.
- **Multi-Device**: The responsive web client works on tablets and iPads, turning any screen into a dev terminal.
- **Always-On**: Run as a background service so your sessions are always ready when you connect.

### ⚡️ Workspace Power
- **Multi-Instance**: Juggle multiple OpenCode sessions side-by-side with per-instance tabs.
- **Long-Context Native**: Scroll through massive transcripts without hitches.
- **Deep Task Awareness**: Monitor background tasks and child sessions without losing your flow.
- **Command Palette**: A single, global palette to jump tabs, launch tools, and fire shortcuts.

## Prerequisites
- **OpenCode**: `opencode` must be installed and configured on your system.
- Node.js 18+ and npm (for running or building from source).
- A workspace folder on disk you want to serve.
- Optional: a Chromium-based browser if you want `--launch` to open the UI automatically.

## Usage

### Run via npx (Recommended)
You can run Era Code directly without installing it:

```sh
npx @neuralnomads/codenomad --launch
```

### Install Globally
Or install it globally to use the `codenomad` command:

```sh
npm install -g @neuralnomads/codenomad
codenomad --launch
```

### Common Flags
You can configure the server using flags or environment variables:

| Flag | Env Variable | Description |
|------|--------------|-------------|
| `--port <number>` | `CLI_PORT` | HTTP port (default 9898) |
| `--host <addr>` | `CLI_HOST` | Interface to bind (default 127.0.0.1) |
| `--workspace-root <path>` | `CLI_WORKSPACE_ROOT` | Default root for new workspaces |
| `--unrestricted-root` | `CLI_UNRESTRICTED_ROOT` | Allow full-filesystem browsing |
| `--config <path>` | `CLI_CONFIG` | Config file location |
| `--launch` | `CLI_LAUNCH` | Open the UI in a Chromium-based browser |
| `--log-level <level>` | `CLI_LOG_LEVEL` | Logging level (trace, debug, info, warn, error) |

### Data Storage
- **Config**: `~/.config/era-code/config.json`
- **Instance Data**: `~/.config/era-code/instances` (chat history, etc.)

## Concurrent Modification Protection

Era Code Server includes built-in safeguards to prevent data loss when multiple sessions attempt to modify the same files simultaneously. This is particularly important for shared project configuration files like directives, governance settings, and MCP configurations.

### How It Works

1. **Mutex-Based Locking**: Each file operation acquires a lock before writing, serializing concurrent writes to the same file path.

2. **Content Hash Tracking**: The server tracks SHA-256 content hashes for each file. When a client reads a file, it receives the current hash along with the content.

3. **Optimistic Locking**: Clients include the `expectedHash` from their last read when writing. If the hash doesn't match (another session modified the file), the write is rejected with a 409 Conflict response.

### API Changes

All read endpoints now return a `hash` field:
```json
{
  "success": true,
  "content": "...",
  "hash": "a1b2c3d4e5f6g7h8"
}
```

All write endpoints accept optional `sessionId` and `expectedHash` parameters:
```json
{
  "folder": "/path/to/project",
  "content": "...",
  "sessionId": "ui-12345-abc",
  "expectedHash": "a1b2c3d4e5f6g7h8"
}
```

### Conflict Response

When a conflict is detected, the server returns HTTP 409 with conflict details:
```json
{
  "success": false,
  "error": "File was modified by another session",
  "conflictInfo": {
    "currentHash": "new-hash-value",
    "lastModifiedBy": "session-2",
    "lastModifiedAt": 1705867200000
  }
}
```

### Protected Files

The following files are protected by the safe file writer:
- `.era/memory/directives.md` - Project directives
- `.era/memory/constitution.md` - Project constitution
- `.era/governance.yaml` - Governance rules
- `.era/governance.local.yaml` - Local governance overrides
- `.era/mcp.json` - MCP server configuration

