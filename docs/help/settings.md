# Settings

Open **Settings** for CodeNomad's display preferences and native configuration controls. On a local desktop, this opens a separate **Preferences** window.

## Providers and models

**Settings → Providers** separates **Models** from **Web search**.

**Manage models** filters which models CodeNomad shows in selectors. **Active account** switches the provider credential when multiple accounts are available; environment-based connections are read-only. **Connect** adds a connection through the provider's native flow.

Provider credentials are shared by projects using the same OpenCode service. Changing the active account can affect other clients connected to that service.

## Web search

In the Web search group, connect a search provider, then set **Default search** or **For the current project**. A project override takes precedence over the global choice. Search credentials are global; connecting a provider does not by itself select it for every project.

## OpenCode

**Settings → OpenCode** shows the selected executable and running service. You can install or update the CLI, check status, and use explicit service controls.

- **Update** changes the installed executable.
- **Restart shared service** replaces the running OpenCode process and can interrupt work in every connected client.
- **Reload OpenCode configuration** is different from restarting. It rebuilds loaded Locations and can cancel pending requests and close terminals/background commands. Use it deliberately, not as a routine refresh.

Follow the compatibility information shown by the current CodeNomad release. A newer installed CLI and an older running service can coexist until you restart it.

## Appearance and interaction

Choose a light, dark, or automatic appearance and a palette for each mode. You can also adjust language, font sizing, notifications, and conversation content visibility.

**Ctrl/Cmd+Shift+P** opens the **Command Palette**. **Settings → General → Enter to submit** controls composer submission; shortcut hints reflect the active behavior.

## Environment variables

CodeNomad applies the profile's environment variables before each prompt or session command on the execution host. Editing them does not restart the service or change a session until the next send. The client device's environment is not substituted for a remote host's.

## Voice and speech

Configure voice input and text-to-speech in their settings sections. Microphone use requires device/browser permission. Availability depends on the selected service and your setup.
