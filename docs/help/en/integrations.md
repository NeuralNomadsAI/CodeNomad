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

CodeNomad-managed plugins stay outside the ordinary plugin list and its activation, update and removal controls. CodeNomad recognises them by their validated installer entry and content-addressed payload location; a third-party plugin with the same name or ID keeps its ordinary controls.

If a managed plugin is disabled, fails to load or has no confirmed load, **CodeNomad plugins need attention** appears above the Plugins list. Open its **i** button (**Details for** the plugin) for the available error and OpenCode log reference. Only a disabled plugin offers **Re-enable**: it appends a positive exact-ID activation rule, preserving the disabling rule. It writes in the disabling rule's **Global** or **Project** scope when writable, otherwise in **Project**. OpenCode stays running; the warning remains until native events or **Refresh plugin controls** confirm that the plugin is active.

The warning and its details label configuration origins **Inherited / external** or **Virtual configuration** where applicable. A separate **Project** label identifies the re-enable destination when it differs from the disabling rule's origin.

1. [Add the plugin](#plugin-sources) or declare it in OpenCode's configuration; then open **Status → Plugins**.
2. Hover or focus its name to inspect source, runtime failure and configuration-target details.
3. Toggle **Global** or **Project** deliberately. Wait for the write and use **Refresh plugin controls** if the state is unclear.
4. For a plugin installed from a package, use the icon beside its name. Its menu names the exact operation: **Check updates for** the package, or **Update** it once a newer version is found.

Global targets the connected daemon's discovered global configuration. Project targets configuration within the active Location, not an inherited ancestor file. A later Project rule can override Global; the Global switch still shows the Global rule rather than pretending to be the final Project state. With no Project rule, Project inherits the resolved Global state.

These switches append exact activation rules while preserving source declarations and unrelated configuration. They do not edit plugin options, install packages or remove files. Built-in OpenCode plugins are not offered as user activation switches. Project is disabled when its target cannot be safely separated from Global or would escape the active Location.

A package update changes that package in OpenCode's shared cache for every Location using it, as its tooltip states; it does not change activation rules, restart OpenCode or reload configuration. Local, built-in and SDK-provided plugins have no package action. A package that fails before reporting its plugin ID is listed by its package name, with the failure in its tooltip and check/update actions but no activation switches. A failed check or update is reported and never retried automatically.

The surface retains its last snapshot while hidden and revalidates when shown, on native changes/reconnect and on explicit refresh. A saved rule and live runtime availability can briefly differ. If a plugin remains unavailable, inspect its tooltip and native configuration before choosing **Reload OpenCode configuration**; that action affects all loaded Locations, not just this plugin. Malformed configuration or a concurrent edit is not silently overwritten: resolve it, refresh and retry explicitly.

## Add or remove a plugin {#plugin-sources}

1. In **Status → Plugins**, open **+** and select **Add a plugin…**.
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
## Integrations in Plugins {#integration-rows}

In **Status → Plugins**, **+** opens **Add an integration…** or **Add a plugin…**. The integration picker lists uninstalled entries from the reviewed catalogue. Choose the scope and **Install**: CodeNomad installs the selected catalogue ID. Native integrations use **Global only**. **Catalogue unavailable** offers **Refresh**; **Catalogue of {date}** identifies the last valid catalogue when stale.

A recognised integration has one row in **Status → Plugins**, with its name (for example **OpenCode for Blender**) and version. Its **Global** and **Project** switches use the accent colour like the other switches, where a plain plugin's are green; an integration with a part inside an application is **Global only**. Hover or focus its name: the details start with **Integration** instead of **Plugin**. An ambiguous source shows **Non-conforming**.

For an integration with a part inside an application, a chain icon shows the displayed conversation: linked with **Attached to:** and the document, broken with **No conversation attached**, dimmed with **Attachment unknown** when the integration cannot tell. Focus the icon to read it. A conversation attaches itself the first time its agent uses the integration. A warning icon appears only when the application part is missing, needs an update or is incompatible. Changes reported by the integration and reconnects refresh the row.

The row's **…** menu starts with the connection state, for example **Blender: 1 open document** or **Blender closed**. It then offers **Install in application…** or **Update application…** when available ([see below](#application-installation)), **Detach the conversation** when the displayed conversation is attached, the package update check, **Remove from Global** or **Remove from Project**, and **Refresh plugin controls**. Detaching takes one click without confirmation and affects only this conversation: the application stays open, its part stays installed and other conversations keep theirs. If its answer is lost, the row reads the state again; the request is never repeated.

Catalogue installation, application-part installation/update and removal require confirmation. **Cancel** is focused first; the confirming action becomes available after 600 ms. Activation, plugin updates and detaching run directly.

Removal proceeds without a conversation census or automatic detach.

Removing any plugin opens a warning naming the plugin and exact scope. **Cancel** is initially focused; **Remove from Global/Project** becomes available after 600 ms and needs an explicit click or keyboard action. Removal can interrupt availability and connections in conversations using the plugin; Global can also affect other projects. Cancellation, expiry or navigation before submission leaves everything unchanged. CodeNomad removes only the confirmed declaration, preserving activation rules, package cache, application files and saved attachment hints. Changed configuration requires a fresh selection and confirmation. Success confirms the declaration was removed; runtime state follows OpenCode's reload. If the response is lost, refresh Plugins to check the actual configuration before a new attempt. Reinstalling may restore availability, with a reload or reattachment sometimes needed; interrupted operations may not resume.

## Install or update the application integration {#application-installation}

In **Status → Plugins**, open the integration's **…** menu and choose **Install in application…** or **Update application…** when its fresh status offers the action; the row's warning icon names the reason. It is available without a conversation or an open document. If the application is closed, open it to check its application part.

The confirmation names the application and the **integration package version** supplying the installer. Check both and the machine warning: installation runs on the machine where OpenCode runs, which may be remote. **Cancel** has initial focus. Confirm explicitly to proceed. Changing project, Location or conversation, reconnecting, or receiving relevant native changes before confirmation cancels the pending approval; open the action again to review fresh details.

WSL always refuses application installation, even when an open application appears compatible. Open the application on a supported machine.

The result reports that the application part was installed, updated, already up to date, refused or failed. After installation or update, open the application and check its integration. Installation success describes the installer request; live application availability comes from the application's status.

Requests are never retried automatically. After a refusal or failure, check the application before choosing a new action. If an error leaves the outcome uncertain, never repeat that request: inspect the application first, then start a fresh action and confirmation if needed.
