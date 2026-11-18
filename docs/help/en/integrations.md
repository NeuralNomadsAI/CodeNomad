# Native integrations

CodeNomad exposes OpenCode's native MCP connections, plugin activation, skills and custom commands. These run on the execution host. They are separate from sandboxed [panel Extensions](extensions.md) and [SideCars](browser-sidecars.md).

## Choose the right control {#integration-scopes}

| Integration | Where to act | What the control changes |
| --- | --- | --- |
| MCP server | **Status → MCP Servers** | Native connection at the displayed Location; does not install a server. |
| Native plugin | **Status → Plugins** | Adds or removes a package declaration, and sets a persistent **Global** or **Project** activation rule; for a package plugin, an explicit check or update of that package. |
| Skill | Composer `@` menu | Explicit attachment to the next prompt in the conversation's Location. |
| Custom command | Composer `/` menu | Runs a command exposed by OpenCode for that Location. |

Native integrations have their host process's privileges, subject to OpenCode permissions; they are not sandboxed HTML panels.

## Connect or disconnect MCP {#mcp}

1. Configure the MCP server on the OpenCode execution host using [OpenCode MCP documentation](https://opencode.ai/v2/docs/mcp-servers/).
2. Open **Status → MCP Servers** for the project.
3. Use the switch beside the server to connect or disconnect it. Wait for the connection indicator to settle.

Other clients using that Location can observe the connection change. Disconnecting does not remove the server declaration or uninstall its executable.

If connection fails, check the server's configuration, required environment and authentication; the switch does not complete OAuth.

## Activate plugins at Global or Project scope {#plugins}

CodeNomad-managed plugins stay outside the ordinary plugin list and its activation, update and removal controls.

For **CodeNomad plugins need attention**, open **i** for details. A disabled plugin offers **Re-enable**; check the displayed configuration scope before using it.

1. [Add the plugin](#plugin-sources) or declare it in OpenCode's configuration; then open **Status → Plugins**.
2. Hover or focus its name to inspect source, runtime failure and configuration-target details.
3. Toggle **Global** or **Project** deliberately. Wait for the write and use **Refresh plugin controls** if the state is unclear.
4. For a plugin installed from a package, use the icon beside its name. Its menu names the exact operation: **Check updates for** the package, or **Update** it once a newer version is found.

Global targets the connected daemon's discovered global configuration. Project targets configuration within the active Location, not an inherited ancestor file. A later Project rule can override Global; the Global switch still shows the Global rule rather than pretending to be the final Project state. With no Project rule, Project inherits the resolved Global state.

Built-in OpenCode plugins are not offered as user activation switches. Project is disabled when its target cannot be safely separated from Global or would escape the active Location.

A package update changes that package in OpenCode's shared cache for every Location using it, as its tooltip states; it does not change activation rules, restart OpenCode or reload configuration. Local, built-in and SDK-provided plugins have no package action.

## Add or remove a plugin {#plugin-sources}

1. In **Status → Plugins**, open **+** and select **Add a plugin…**.
2. Enter a package from the npm registry (`name`, `name@1.2.3`, `@scope/name@^1`) or a Git repository (`github:owner/repo`, `git+https://…`).
3. Keep **Global** unless the plugin should run only for this project, then select **Add**.
4. The new row shows **Installing** until OpenCode reports it.

To remove a plugin, open the menu beside its name and select **Remove from Global** or **Remove from Project**. Its declaration and its activation rules in that scope's configuration file are deleted, except a disabling rule while another declaration of the plugin remains and an enabling rule that an earlier declaration still defines. An enabling rule that would lose its definition is also deleted from this project's configuration, since OpenCode would otherwise download a registry package of that name; if it is in a file CodeNomad does not edit, the removal is refused. OpenCode's package cache is left in place. Rules of a plugin OpenCode could not identify (disabled, or failed before loading) stay on a row of their own, whose menu offers the same removal.

The plugin's code runs with your permissions inside OpenCode. A **Project** entry runs whenever that folder is opened in OpenCode, and packages with parts for OpenCode's desktop app load those parts only from **Global**; the tooltip says so when such a package is declared elsewhere. Local paths, configuration variables and plugin IDs are refused here: declare local plugins in the configuration file. A package already declared in a configuration that applies to this Location is refused, whatever its version, range or form.

The installed package version appears beside the plugin's name. For Git plugins, the details include the commit; if the version is unavailable, a seven-character commit appears beside the name. Hover or focus the name to see details, **Update available** and, for a failed install, the error with its reference in the OpenCode log.

## Attach skills {#skills}

1. Type `@` in the composer, search the Location's available skills and select one.
2. Check its removable attachment alongside files/agents; remove it before sending if it is not intended.
3. Send the prompt. Skill labels remain with the sent message.

Removing an attachment cannot undo an earlier send.

Skill availability comes from the conversation's Location, not a global CodeNomad skill catalogue. See [OpenCode skills documentation](https://opencode.ai/v2/docs/skills/) and [Conversations](conversations.md).

## Run custom commands {#commands}

1. Type `/` in the composer and choose an available native command.
2. Supply its arguments and check **Agent**, **Model** and **Thinking** before submitting as appropriate for that command.
3. Inspect the resulting conversation rather than repeatedly submitting if acknowledgement is unclear.

Commands are discovered from OpenCode for the active Location. `/btw` is CodeNomad's separate ephemeral question flow, not an ordinary custom command.

For command definitions and native configuration inheritance, use [OpenCode commands documentation](https://opencode.ai/v2/docs/commands/). After configuration changes, refresh/reopen the relevant surface first; use explicit configuration reload only if the runtime still needs it. Never replay a possibly admitted command solely to refresh its display.
## Integrations in Plugins {#integration-rows}

In **Status → Plugins**, **+** opens **Add an integration…** or **Add a plugin…**. The integration picker lists uninstalled entries from the reviewed catalogue. Choose the scope and **Install**: CodeNomad installs the selected catalogue ID. Native integrations use **Global only**. **Catalogue unavailable** offers **Refresh**; **Catalogue of {date}** identifies the last valid catalogue when stale.

Use the accent-coloured state line to **Install in Blender**, **Update Blender** or **Attach** the displayed conversation to an open document (**Attach…** to choose between several). A chain icon and document show an attachment; select it to detach. A conversation also attaches itself the first time its agent uses the integration.

The row's **…** menu starts with the connection state, for example **Blender: 1 open document** or **Blender closed**. It then offers **Documentation**, **Install in application…**, **Update application…** or **Reinstall in application…** ([see below](#application-installation)), the package update check, **Remove from Global** or **Remove from Project**, and **Refresh plugin controls**. Detaching takes one click without confirmation and affects only this conversation: the application stays open, its part stays installed and other conversations keep theirs.

Catalogue installation, application-part installation/update and removal require confirmation. **Cancel** is focused first; the confirming action becomes available after 600 ms. Activation, plugin updates, attaching and detaching run directly.

Removing any plugin opens a warning naming the plugin and exact scope. **Cancel** is initially focused; **Remove from Global/Project** becomes available after 600 ms and needs an explicit click or keyboard action. Removal can interrupt availability and connections in conversations using the plugin; Global can also affect other projects. CodeNomad removes only the confirmed declaration and the activation rules described above, preserving the package cache, application files and saved attachment hints. Changed configuration requires a fresh selection and confirmation.

## Install or update the application integration {#application-installation}

In **Status → Plugins**, select **Install in Blender** or **Update Blender** on the integration's state line when its fresh status offers the action, or choose **Install in application…**, **Update application…** or **Reinstall in application…** in its **…** menu. Reinstalling rewrites the application part, the application open or closed. It is available without a conversation or an open document.

The confirmation names the application and the **integration package version** supplying the installer. Check both and the machine warning: installation runs on the machine where OpenCode runs, which may be remote. **Cancel** has initial focus. Confirm explicitly to proceed.

WSL always refuses application installation, even when an open application appears compatible. Open the application on a supported machine.

After installation or update, open the application and check its integration.

If an error leaves the outcome uncertain, never repeat that request: inspect the application first, then start a fresh action and confirmation if needed.
