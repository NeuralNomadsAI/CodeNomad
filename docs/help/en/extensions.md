# Panel extensions

## Browse installed and online extensions {#browse}

1. Open **Customize right panel** in the right-panel tab bar.
2. Expand **Extensions** below the separator.
3. Use **Search extensions** to search the single list of installed addons and the official online catalogue. Hover or focus an entry for its metadata.

Browsing catalogue metadata does not download or execute the author's panel code. The catalogue is maintained in [CodeNomad Extensions](https://github.com/NeuralNomadsAI/CodeNomad-Extensions); inclusion and claimed author names are not signatures or proof of trust.

## Review and install disabled {#install}

1. Choose **Install…** on a catalogue entry, or **Install from ZIP…** for a package you obtained separately.
2. Review the package ID, author, repository, version, API/permissions and SHA-256 digest. Expand technical details when needed.
3. Verify the publisher and, where available, compare the digest through a trusted channel.
4. Only if you trust the code, select **I trust this package and its author**, then **Install disabled**.

Inspection downloads/revalidates the selected package; author code is not executed by inspection. A digest identifies exact bytes, not the author's identity. Catalogue packages come from the exact declared GitHub release asset, not an arbitrary URL. Manual packages are ZIPs containing only `manifest.json` and self-contained `panel.html`; invalid or unsupported packages are rejected.

Installation needs no OpenCode restart and never grants activation automatically.

## Activate and understand the scope {#activate-scope}

1. Return to the addon row above the **Extensions** disclosure in **Customize right panel**. Installed disabled addons remain in that list.
2. Select its checkbox to activate it. Clear that same checkbox to disable it.

Activation is configuration-wide across projects, not per folder. On a remote connection it affects the server's installed extension store, not just your viewing device.

The extension store is `panel-extensions/` beside the selected CodeNomad configuration. Separate desktop data profiles do **not** isolate extensions when those profiles use the same configuration directory. See [Desktop windows and data](desktop.md) for the distinction.

**Reset** in customization only restores built-in layout and does not enable, disable or uninstall extensions.

## Replace or remove {#replace-remove}

1. Use **Change version…** or inspect another ZIP with the same ID to replace an installed package.
2. Review the new digest and permissions, acknowledge trust, then install it disabled.
3. Reactivate through the normal checkbox only after deciding to trust the replacement.
4. To uninstall, use **Remove…** and **Confirm removal** after reviewing the target.

Every replacement revokes activation across all projects, even if the permission list is unchanged, and clears the panel's own saved settings. There are no silent extension updates. Removal deletes the package, its activation settings and its saved panel settings, not OpenCode sessions or project files. To recover from unwanted code, disable it first; reinstall only a verified trusted package.

## Context, asset consent and sandbox limits {#permissions-sandbox}

| Contract | What activation permits |
| --- | --- |
| API 1 / `session.context` | Current session identifier (or none), interface language and appearance. No transcript text or filesystem access. |
| API 2 / `session.assets.read` plus context | Explicitly reviewed permission to list bounded current-session tool-result image/attachment metadata and read supported embedded bytes. It is not general transcript, file or URL access. |
| API 3 / `repository.workItems.read` plus context | Explicitly reviewed permission to list bounded pages of the project repository's issues and pull requests on GitHub, GitLab or Gitea/Forgejo, and to open one of them in the browser. It is not file, credential or general network access. |
| API 4 / context plus one or more of the permissions below | The review lists one sentence per declared permission; activation grants all of them together, and a replacement revokes them all. |
| `session.images.read` | Read the images returned by the read tool in the displayed conversation, with generation status and lineage when they can be verified. |
| `session.images.prompts` (needs `session.images.read`) | Read the prompt and model of each image generated in the project's Images conversation. |
| `composer.prefill` | Add text to the message box of the displayed conversation. It never sends a message. |
| `images.conversation` | Open or start this project's Images conversation. |
| `opencode.designAgent` | Adds CodeNomad's Design agent and its image skills to OpenCode while this extension is enabled. |
| `panel.preferences` | Remember this panel's own settings. |
| `panel.notes` | Keep one note per conversation of this project, list and delete them, and open their conversations. Removing the extension deletes the notes. |
| `repository.workItems.read` | Read this project's repository name and its issues and pull requests on GitHub, GitLab or Gitea/Forgejo (through your signed-in gh, glab or tea, or anonymously for public repositories), and open them in your browser. |
| `repository.worktrees.read` (needs `repository.workItems.read`) | See which issues and pull requests have a local branch created by CodeNomad, and whether a worktree checks it out. |
| `repository.worktrees.write` (needs `repository.worktrees.read`) | Ask to create a branch and a worktree for an issue or pull request (fetching the pull request from the repository) and move the displayed conversation there. CodeNomad asks you each time. |

Asset access follows the currently mounted host/session, not an author-selected session. Switching sessions, disconnecting or revoking consent invalidates old access.

An extension with `session.images.prompts` can read the prompts you or the agent wrote for images in an Images conversation, and could pass them on despite the sandbox, so grant it only to authors you trust with them. Text added by `composer.prefill` stays in the message box until you edit it or select **Send message**; it never starts with a command, never ends with an open `@` mention, and cites image paths as plain text. Undoing with Ctrl+Z (Cmd+Z on macOS) in the message box does not remove it. Saved panel settings belong to this CodeNomad profile, at most 4 KiB per extension; disabling an extension keeps them. Notes kept with `panel.notes` also belong to this profile, filed by project: the worktrees of one repository share them, and so do its clones whose remote is the same hosted repository. Disabling or replacing the extension keeps them, removing it deletes them. Like agent memory, notes need Git to identify their project.

Work items come from the project folder's `upstream` remote, else `origin`. CodeNomad reads them with the GitHub, GitLab or Gitea CLI you already signed in to (`gh`, `glab`, `tea`), or anonymously for public repositories, and stores no token; the extension sees only the repository name and the items. Anonymous reads cover github.com, gitlab.com, codeberg.org and gitea.com; a self-hosted forge is read only through its CLI signed in to it. Opening an item asks CodeNomad to open that item's page on the same forge in your browser, at most once a second; the extension cannot open other addresses.

A linked branch is one CodeNomad created for an item: `issue-N` from the current commit, or `pr-N` at the pull request's head fetched from the same remote, forks included. Git keeps the link with the branch and drops it when the branch is deleted; a branch of the same name that CodeNomad did not create is never reused. An extension can only ask: CodeNomad shows its own dialog naming the item, then creates the branch and the worktree if needed and moves the displayed conversation and its subagent conversations there. A `pr-N` branch has no upstream; push with your usual Git command.

Author code runs in a restricted iframe, not in the trusted application renderer. It receives no native/OpenCode bridge, credential access, general RPC, forms, popups or downloads; network APIs and external resources are restricted. Extensions are UI addons, not [OpenCode plugins](integrations.md).

The sandbox is not process/CPU isolation or a promise that approved code is harmless. A hostile extension can disrupt its renderer. Install only trusted authors, do not provide secrets, and disable/remove an addon if it behaves unexpectedly.

## Create images with the Design extension {#design}

The **Design** extension is a light table for the images you create with CodeNomad's Design agent in a project's **Images conversation**. It shows the images, prepares requests in the message box and leaves every generation to the messages you send.

1. Connect a provider that offers an image model. Image generation is on unless it was turned off in **Settings → Providers → Images** ([Image generation and storage](providers.md#images)).
2. In **Customize right panel → Extensions**, install **Design** from the catalogue ([Review and install disabled](#install)) after reviewing its permissions ([Context, asset consent and sandbox limits](#permissions-sandbox)), then select its checkbox ([Activate and understand the scope](#activate-scope)).
3. Open the **Design** panel and choose **Open the Images conversation**.

While the extension is enabled, CodeNomad adds its Design agent and image skills to OpenCode. Your own `design` agent and your own `design-*` skills always take precedence; when you supply your own `design` agent, the panel shows **Your own Design agent is used.**

### Images conversation {#design-conversation}

Each project folder or worktree has its own Images conversation, titled **Images**. **Open the Images conversation** finds it, or creates it with the Design agent and the model CodeNomad picks for a new conversation with that agent, then shows it with the focus in the message box; opening sends nothing. An existing Images conversation keeps its own model. **New Images conversation** starts another one with an empty light table, and the panel suggests it once a conversation holds many images; **Open** then shows the newest one. Archived and deleted Images conversations are skipped.

Describe what you need and send it: the agent asks a few framing questions, says how many images it will generate, generates them, reads each one back and reviews it. Images are saved in `.codenomad/design/` of the project folder. CodeNomad adds that folder to the repository's local Git exclusions (`.git/info/exclude`), leaving `.gitignore` untouched; when it cannot, the panel shows **Images in this location may appear in Git.** Undoing a turn removes its images from the light table but keeps their files, and an image the agent overwrote cannot be recovered.

If the conversation's chat model cannot receive images, the panel warns that the agent can't critique them visually; the images it reads back still appear on the light table.

### Light table {#design-light-table}

The **Light table** shows the images the agent read back into the displayed conversation, newest first, grouped by reply. Selecting an image shows it larger with **Small sizes** previews at 16, 32 and 64 px; **Compare** puts two images side by side, and **View full size** opens a viewer. In a narrow panel, widen it to compare. Lineage (**Made from**, **Used for**), and in the Images conversation the prompt and model, appear only when CodeNomad can verify which generation produced the image; otherwise the image keeps its pixels and reads **origin not verifiable**. **Generations** lists each image generation with its state; follow its progress in the conversation. In another conversation, the panel shows that conversation's read-back images without prompts or requests and offers to open the Images conversation.

In the Images conversation, **Start from** (a recipe such as an app icon or a logo), **Refine**, **Variants**, **Apply direction**, **Save to project…**, **Ask the agent to show it** and **Retry** only add editable text to the message box: the panel never sends a message or generates an image. Actions about a chosen image cite its path relative to the project, and only images of the project with a verifiable origin can be cited. Edit the request, then send it yourself. **Save to project…** asks the agent to copy the image to the destination you type after the request. **Images per turn** (1 to 4, 3 by default) is included in requests that generate new images and kept in the panel's saved settings. On a phone, the panel floats and closes when it adds a request.

### Use the Design agent without CodeNomad {#design-without-codenomad}

The Design agent and skills are ordinary OpenCode files. To use them in the OpenCode TUI or another client without CodeNomad, copy the contents of the [Design content folder](../../../packages/server/src/opencode/design/opencode/) into a project's `.opencode/` folder or your global OpenCode configuration folder (`~/.config/opencode/`), keeping `NOTICE.md` and the licence beside them. Then select the **design** agent; it loads its skills by name, and other agents use them only when you name them.

The Design agent and skills adapt material from [Open Design](https://github.com/nexu-io/open-design) (Apache-2.0) and [taste-skill](https://github.com/Leonxlnx/taste-skill) (MIT); `NOTICE.md` lists each adapted file. The Design extension reuses code from the MCP Assets extension (MIT).
