# Files and tools

The right panel combines workspace browsing, Git inspection, and project services. Readers open centrally, above the composer.

## Workspace files

In **Files → Workspace**, expand folders and select a row. Use its **eye** action to open the central file reader; selecting a row alone does not open it.

Text files, including Markdown source, are editable. Use **Save** or **Ctrl/Cmd+S** to write changes. If the file changed on disk, CodeNomad asks you to resolve that conflict rather than silently replacing it. Images and binary previews are read-only.

Close the reader with its **X** to return to the conversation.

## Review Git changes

Switch **Files** to **Changes** to inspect staged and unstaged files. Open a diff with the eye action, stage or unstage files, and use the commit controls at the top of the staged section.

Switch to **Commits** to browse repository history and inspect historical diffs. Diffs are read-only; use the layout switch to choose unified or split views.

## Check Status

The **Status** panel shows project services and background activity, including **MCP Servers** and **Plugins**.

- **MCP Servers** exposes connection state and activation controls.
- **Plugins** have separate **Global** and **Project** activation switches. Global changes can affect other projects; a project rule can override the global choice.
- Background shell activity is distinct from an interactive terminal and from the agent's current reply.

## Preview a web app

Open the session's **browser preview** from the conversation toolbar. It is attached to that session; the agent can target the visible preview through CodeNomad's browser tools. Opening it does not start a development server.

Agent-driven native browser control is available in Electron and **Windows Tauri**. Other Tauri platforms use an iframe preview; that is not equivalent to native browser automation. Some sites also prevent iframe embedding.

## Add a SideCar

**SideCars** are tabs for web tools running on the CodeNomad server host, such as an editor or terminal service.

Start the tool separately, then add it in **Settings → SideCars** with its name, port, and protocol. The port refers to the **server host**, not necessarily the device displaying CodeNomad. Match the prefix mode to the tool's base-path support; see the [SideCar examples](https://github.com/NeuralNomadsAI/CodeNomad#sidecars).
