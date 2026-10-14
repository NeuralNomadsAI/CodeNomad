# Panel extensions

## Browse installed and online extensions {#browse}

1. Open **Customize right panel** in the right-panel tab bar.
2. Expand **Extensions** below the separator.
3. Use **Search extensions** to search the single list of installed addons and the official online catalogue. Hover or focus an entry for its metadata.

The disclosure starts collapsed each time the customization popup opens. Installed and online entries are combined by extension ID; there is no separate manager window or installed/online mode. Browsing catalogue metadata does not download or execute the author's panel code. The catalogue is maintained in [CodeNomad Extensions](https://github.com/NeuralNomadsAI/CodeNomad-Extensions); inclusion and claimed author names are not signatures or proof of trust.

If the catalogue is unavailable, installed extensions and **Install from ZIP…** remain available. Refresh to retry discovery. Collapsing or dismissing the popup abandons its pending review/confirmation UI; it does not silently install anything.

## Review and install disabled {#install}

1. Choose **Install…** on a catalogue entry, or **Install from ZIP…** for a package you obtained separately.
2. Review the package ID, author, repository, version, API/permissions and SHA-256 digest. Expand technical details when needed.
3. Verify the publisher and, where available, compare the digest through a trusted channel.
4. Only if you trust the code, select **I trust this package and its author**, then **Install disabled**.

Inspection downloads/revalidates the selected package; author code is not executed by inspection. A digest identifies exact bytes, not the author's identity. Catalogue packages come from the exact declared GitHub release asset, not an arbitrary URL. Manual packages are ZIPs containing only `manifest.json` and self-contained `panel.html`; invalid or unsupported packages are rejected.

Installation needs no OpenCode restart and never grants activation automatically. A failed validation, conflict or storage operation does not authorize a retry with different bytes. Reinspect the package before a new installation attempt.

## Activate and understand the scope {#activate-scope}

1. Return to the addon row above the **Extensions** disclosure in **Customize right panel**. Installed disabled addons remain in that list.
2. Select its checkbox to activate it. Clear that same checkbox to disable it.

That checkbox is the only activation control: there is no extra manager switch or per-window visibility gate. Activation is configuration-wide across projects, not per folder. On a remote connection it affects the server's installed extension store, not just your viewing device.

The extension store is `panel-extensions/` beside the selected CodeNomad configuration. Separate desktop data profiles do **not** isolate extensions when those profiles use the same configuration directory. Conversely, opening a different configuration is not a grant to run an addon installed elsewhere. See [Desktop windows and data](desktop.md) for the distinction.

An enabled panel can mount when selected; hiding it can dispose its temporary UI state. Disabling revokes its activation. **Reset** in customization only restores built-in layout and does not enable, disable or uninstall extensions.

## Replace or remove {#replace-remove}

1. Use **Change version…** or inspect another ZIP with the same ID to replace an installed package.
2. Review the new digest and permissions, acknowledge trust, then install it disabled.
3. Reactivate through the normal checkbox only after deciding to trust the replacement.
4. To uninstall, use **Remove…** and **Confirm removal** after reviewing the target.

Every replacement revokes activation across all projects, even if the permission list is unchanged. Validation/conflict/storage failure preserves the installed package. There are no silent extension updates. Removal deletes the package and its activation settings, not OpenCode sessions or project files. To recover from unwanted code, disable it first; reinstall only a verified trusted package.

## Context, asset consent and sandbox limits {#permissions-sandbox}

| Contract | What activation permits |
| --- | --- |
| API 1 / `session.context` | Current session identifier (or none), interface language and appearance. No transcript text or filesystem access. |
| API 2 / `session.assets.read` plus context | Explicitly reviewed permission to list bounded current-session tool-result image/attachment metadata and read supported embedded bytes. It is not general transcript, file or URL access. |

Asset access follows the currently mounted host/session, not an author-selected session. Local/remote references may be listed as unavailable; the asset API does not fetch arbitrary remote URLs or open local files. Switching sessions, disconnecting or revoking consent invalidates old access.

Author code runs in a restricted iframe, not in the trusted application renderer. It receives no native/OpenCode bridge, credential access, general RPC, forms, popups or downloads; network APIs and external resources are restricted. Extensions are UI addons, not [OpenCode plugins](integrations.md).

The sandbox is not process/CPU isolation or a promise that approved code is harmless. A hostile extension can disrupt its renderer. Install only trusted authors, do not provide secrets, and disable/remove an addon if it behaves unexpectedly.
