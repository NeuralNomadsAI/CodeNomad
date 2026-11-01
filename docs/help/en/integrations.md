# Native integrations

CodeNomad exposes OpenCode's native MCP connections, plugin activation, skills and custom commands. These run on the execution host. They are separate from sandboxed [panel Extensions](extensions.md) and [SideCars](browser-sidecars.md).

## Choose the right control {#integration-scopes}

| Integration | Where to act | What the control changes |
| --- | --- | --- |
| MCP server | **Status → MCP Servers** | Native connection at the displayed Location; does not install a server. |
| Native plugin | **Status → Plugins** | Adds or removes a package declaration, and sets a persistent **Global** or **Project** activation rule; for a package plugin, an explicit check or update of that package. |
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

1. [Add the plugin](#plugin-sources) or declare it in OpenCode's configuration; then open **Status → Plugins**.
2. Hover or focus its name to inspect source, runtime failure and configuration-target details.
3. Toggle **Global** or **Project** deliberately. Wait for the write and use **Refresh plugin controls** if the state is unclear.
4. For a plugin installed from a package, use the icon beside its name. Its menu names the exact operation: **Check updates for** the package, or **Update** it once a newer version is found.

Global targets the connected daemon's discovered global configuration. Project targets configuration within the active Location, not an inherited ancestor file. A later Project rule can override Global; the Global switch still shows the Global rule rather than pretending to be the final Project state. With no Project rule, Project inherits the resolved Global state.

These switches append exact activation rules while preserving source declarations and unrelated configuration. They do not edit plugin options, install packages or remove files. Built-in OpenCode plugins are not offered as user activation switches. Project is disabled when its target cannot be safely separated from Global or would escape the active Location.

A package update changes that package in OpenCode's shared cache for every Location using it, as its tooltip states; it does not change activation rules, restart OpenCode or reload configuration. Local, built-in and SDK-provided plugins have no package action. A package that fails before reporting its plugin ID is listed by its package name, with the failure in its tooltip and check/update actions but no activation switches. A failed check or update is reported and never retried automatically.

The surface retains its last snapshot while hidden and revalidates when shown, on native changes/reconnect and on explicit refresh. A saved rule and live runtime availability can briefly differ. If a plugin remains unavailable, inspect its tooltip and native configuration before choosing **Reload OpenCode configuration**; that action affects all loaded Locations, not just this plugin. Malformed configuration or a concurrent edit is not silently overwritten: resolve it, refresh and retry explicitly.

## Add or remove a plugin {#plugin-sources}

1. In **Status → Plugins**, select **Add plugin** (the plus icon beside **Refresh plugin controls**).
2. Enter a package from the npm registry (`name`, `name@1.2.3`, `@scope/name@^1`) or a Git repository (`github:owner/repo`, `git+https://…`).
3. Keep **Global** unless the plugin should run only for this project, then select **Add**.
4. The new row shows **Installing** until OpenCode reports it. It then becomes an ordinary plugin row with its switches, or a failed row.

To remove a plugin, open the menu beside its name and select **Remove from Global** or **Remove from Project**. Only the declaration in that scope's configuration file is deleted; its **Global**/**Project** activation rules stay as rules, and OpenCode's package cache is left in place.

The plugin's code runs with your permissions inside OpenCode. A **Project** entry runs whenever that folder is opened in OpenCode, and packages with parts for OpenCode's desktop app load those parts only from **Global**; the tooltip says so when such a package is declared elsewhere. Local paths, configuration variables and plugin IDs are refused here: declare local plugins in the configuration file. A package already declared in a configuration that applies to this Location is refused, whatever its version, range or form.

An OpenCode integration from the reviewed catalog (for example the Blender integration) is recognised before it is installed. One with a part inside an application is added to **Global** only: **Project** is refused for it. Its registry package and its Git builds count as one package, so adding a second form of an integration already declared or loaded is refused.

Hover or focus a plugin's name to see its version, **Update available** and, for a failed install, the error with its reference in the OpenCode log. A row that OpenCode has not reported after two minutes shows **Not confirmed** with a **Refresh plugin controls** action: the plugin may be disabled, or its installation never completed (see [Troubleshooting](troubleshooting.md#providers-and-addons)).

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
## Attach an open application {#application-attachment}

Offer a document from the application's integration, then select **Attach an open application…** in the conversation header (or its overflow menu) or the integration's Plugins row menu. The action appears only for an active native integration reporting offers. Select an application/document, check the target conversation and modification warning, then select **Confirm attachment**. Cancel is focused initially. The application runs on the machine where OpenCode runs, including remote connections. An unsupported host, including unsupported WSL, shows help instead of an attachment action.

An admitted action keeps its result or error through native changes and reconnects while the target conversation stays displayed. Its success message is a local action receipt with **Detach this conversation**, which is safe even if already detached. Detach also shows a local completion receipt. Navigation dismisses these receipts. Current per-conversation bindings cannot be read with this integration contract. Saved metadata is only a reattach hint: **Reattach** appears in the picker only for an offer with the same integration and label, and still requires confirmation. Other clients may change bindings. To detach an existing binding after reopening, use the application's controls.

Plugins shows **Integration catalog unavailable** when no catalog can be read, or the last valid catalog with its fetch time when stale. Refresh Plugins to retry. Removal is refused while conversations are attached or their attachments cannot be verified; detach them in the application, enable the integration if needed, then refresh and retry.

## Install or update the application integration {#application-installation}

In **Status → Plugins**, open the menu of the integration's own row and choose **Install application integration…** or **Update application integration…**. The action appears when a fresh status from an active native integration requests installation or update. It is available without a conversation or an offered document.

The confirmation names the application and the **integration package version** supplying the installer. Check both and the machine warning: installation runs on the machine where OpenCode runs, which may be remote. **Cancel** has initial focus. Confirm explicitly to proceed. Changing project, Location or conversation, reconnecting, or receiving relevant native changes before confirmation cancels the pending approval; open the action again to review fresh details.

WSL always refuses application installation, even when an open application appears compatible. Open the application on a supported machine.

The result reports that the integration was installed, updated, already up to date, refused or failed. For installation or update, open the application and check its integration; attach a conversation separately using [Attach an open application](#application-attachment). Installation success describes the installer request; live application availability comes from the application's status.

Requests are never retried automatically. After a refusal or failure, check the application before choosing a new action. If an error leaves the outcome uncertain, never repeat that request: inspect the application first, then start a fresh action and confirmation if needed.
