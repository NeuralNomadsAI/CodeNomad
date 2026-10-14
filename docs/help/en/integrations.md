# Native integrations

CodeNomad exposes OpenCode's native MCP connections, plugin activation, skills and custom commands. These run on the execution host. They are separate from sandboxed [panel Extensions](extensions.md) and [SideCars](browser-sidecars.md).

## Choose the right control {#integration-scopes}

| Integration | Where to act | What the control changes |
| --- | --- | --- |
| MCP server | **Status → MCP Servers** | Native connection at the displayed Location; does not install a server. |
| Native plugin | **Status → Plugins** | Persistent **Global** or **Project** activation rule; does not install/update/remove the package. |
| Skill | Composer `@` menu | Explicit attachment to the next prompt in the conversation's Location. |
| Custom command | Composer `/` menu | Runs a command exposed by OpenCode for that Location. |

Configure/install the integration using OpenCode's supported configuration and CLI first. Installing a package, declaring its source, enabling its rule, connecting a service and making its tools available are separate steps. Native integrations have their host process's privileges, subject to OpenCode permissions; they are not sandboxed HTML panels.

## Connect or disconnect MCP {#mcp}

1. Configure the MCP server on the OpenCode execution host using [OpenCode MCP documentation](https://opencode.ai/v2/docs/mcp-servers/).
2. Open **Status → MCP Servers** for the project.
3. Use the switch beside the server to connect or disconnect it. Wait for the connection indicator to settle.

The switch calls the native connection API for the reported Location, not a device-local installer or a per-window visibility preference. Other clients using that Location can observe the connection change. Disconnecting does not remove the server declaration or uninstall its executable.

If no server appears, verify the active Location and its native configuration. If connection fails, inspect the server's configuration, required environment and native authentication flow; do not assume the switch completes OAuth. Recheck status after reconnecting. Use explicit configuration reload only when necessary, with the disruptions described in [OpenCode setup](opencode.md).

## Activate plugins at Global or Project scope {#plugins}

1. Install/declare the native plugin with OpenCode; then open **Status → Plugins**.
2. Hover or focus its name to inspect source, runtime failure and configuration-target details.
3. Toggle **Global** or **Project** deliberately. Wait for the write and use **Refresh plugin controls** if the state is unclear.

Global targets the connected daemon's discovered global configuration. Project targets configuration within the active Location, not an inherited ancestor file. A later Project rule can override Global; the Global switch still shows the Global rule rather than pretending to be the final Project state. With no Project rule, Project inherits the resolved Global state.

These switches append exact activation rules while preserving source declarations and unrelated configuration. They do not edit plugin options, install packages or remove files. Built-in OpenCode plugins are not offered as user activation switches. Project is disabled when its target cannot be safely separated from Global or would escape the active Location.

The surface retains its last snapshot while hidden and revalidates when shown, on native changes/reconnect and on explicit refresh. A saved rule and live runtime availability can briefly differ. If a plugin remains unavailable, inspect its tooltip and native configuration before choosing **Reload OpenCode configuration**; that action affects all loaded Locations, not just this plugin. Malformed configuration or a concurrent edit is not silently overwritten: resolve it, refresh and retry explicitly.

## Attach skills {#skills}

1. Type `@` in the composer, search the Location's available skills and select one.
2. Check its removable attachment alongside files/agents; remove it before sending if it is not intended.
3. Send the prompt. Skill labels remain with the sent message.

Selection attaches the native skill ID and removes the `@query` token; it does not paste the instructions into the visible draft. Sending clears the composer selection, not instructions already stored by OpenCode with that message. Removing an attachment cannot undo an earlier send.

Skill availability comes from the conversation's Location, not a global CodeNomad skill catalogue. If the list cannot load, close and reopen the picker to retry; if empty, check native discovery/configuration. See [OpenCode skills documentation](https://opencode.ai/v2/docs/skills/) and [Conversations](conversations.md).

## Run custom commands {#commands}

1. Type `/` in the composer and choose an available native command.
2. Supply its arguments and check **Agent**, **Model** and **Thinking** before submitting as appropriate for that command.
3. Inspect the resulting conversation rather than repeatedly submitting if acknowledgement is unclear.

Commands are discovered from OpenCode for the active Location. Their own native definition can choose execution behavior; the menu is not a package installer or an unrestricted configuration editor. CodeNomad applies the profile's session environment before native custom-command submission; a failed environment update blocks the send. `/btw` is CodeNomad's separate ephemeral question flow, not an ordinary custom command.

For command definitions and native configuration inheritance, use [OpenCode commands documentation](https://opencode.ai/v2/docs/commands/). After configuration changes, refresh/reopen the relevant surface first; use explicit configuration reload only if the runtime still needs it. Never replay a possibly admitted command solely to refresh its display.
