# Composer attachment UX harmonization

Status: implemented in PR #729; validation and independent gatekeeper results
are recorded in the PR. This document retains the interaction contract.

Reference: [review direction](https://github.com/NeuralNomadsAI/CodeNomad/pull/729#issuecomment-5751384618).

Rendered captures: [French, narrow](pr729-attachments-fr-narrow.png) and
[Hebrew, wide](pr729-attachments-he-wide.png).

The isolated Windows native-picker smoke uses
`node scripts/test-attachment-picker-desktop.mjs tauri` (or `electron`). It renders
the source SessionView in an isolated host profile and drives the actual OS dialog
for selection, cancellation and reselection; it does not connect to OpenCode.
Tauri requires a built release artifact and discovers its native dynamic CDP port.
The browser runtime matrix separately simulates local/remote/WSL execution contexts.

## Goal and interaction contract

Make it obvious how to give the agent a project reference or a file from the
user's device, without asking users to understand server transport details.

| Intent | Entry point | Result |
| --- | --- | --- |
| Reference a project file or folder | Existing `@` picker | Reference within the active session's project/worktree on the execution host |
| Attach a file from this device | One paperclip action: **Attach file…** | Native device picker, multiple selection, file bytes attached to the draft |
| Drop device files | Composer drop target | Same byte-backed ingestion as the picker |
| Paste an image/file | Clipboard | Same ingestion limits and lifecycle protection, preserving existing image placeholders |
| Paste text | Existing composer behavior | Ordinary text or existing long-text attachment behavior |

The composer action menu should contain one attachment entry. Remove the separate
**Upload from device** entry and the composer-specific server file browser. Use
the existing paperclip, menu, attachment strip and square-corner controls.

Keep `@` discoverable through the existing composer hint, with wording such as
“@ Reference project files”. Explain the paperclip with “Choose files from this
device” in its accessible description/help. No extra chooser or server/device tab
should be inserted before the native picker. Restore composer focus after selection
or cancellation; allow selecting the same file again after removal.

## Environment behavior

| Client and execution host | Attach file / drop / clipboard | `@` |
| --- | --- | --- |
| Web browser, local server | Browser/OS device picker; send bytes | Active server project |
| Web browser, remote server | Browser/OS device picker; send bytes | Active remote project |
| Electron or Tauri, local host | Native picker via the shared file input; send bytes | Active local project |
| Electron or Tauri, remote host | Same picker and label; send bytes through the remote proxy | Active remote project |
| Desktop with WSL execution | Windows device picker; send bytes | Active WSL project |

Device-local paths must never replace file bytes, including when Electron exposes
`File.path`. Reuse the current inline attachment protocol: selecting a file attaches
a snapshot to a draft; it does not create a file in the repository or send a prompt.
Keep project references as references rather than silently copying their content.

### Explicit scope change

Issue #725 originally requested two adjacent flows. The later review direction
supersedes that menu design. `@` is project-scoped and is not equivalent to the
general server filesystem browser. Removing the latter also removes the composer
shortcut for arbitrary files outside the project on a remote server. State this
in the PR description/release note. Such a file must first be made available in
the project or on the user's device; do not silently widen `@` authorization or
claim full feature parity. Keep the shared directory browser for its other callers.

## Attachment state and feedback

- Keep one attachment strip for project references and uploaded files. Use existing
  previews and removal controls; distinguish ambiguous origins in secondary details
  (project-relative path versus device filename/size), with translated accessible text.
- Reuse `PROMPT_INLINE_FILE_LIMITS`: 5 MiB per file, 10 inline files and 20 MiB of
  decoded bytes per prompt; preserve the 32 MiB transport envelope. These limits
  apply to copied bytes, not to the count of project path references.
- Show a loading state on the attachment action during reads and disable sending
  until the current batch settles. Keep the draft editable and do not auto-submit.
- Keep accepted files in selection order. Explain skipped files by reason
  (unreadable, oversized, aggregate limit), preferably with filenames. Report a
  partial batch once rather than emitting a notification per file.
- Cancellation is silent. Failed reads never fall back to a device path.
- Bind selection and reads to instance, session and composer lifecycle. Invalidate
  outstanding work on session/worktree change, deactivation or unmount; a late
  callback must not change another draft or return focus to an inactive composer.
- Serialize overlapping picker/drop/clipboard batches or reserve their aggregate
  budget, and revalidate at commit time. Preserve existing draft persistence.

## Implementation sequence

### 1. Consolidate the visible entry points

In `packages/ui/src/components/prompt-input.tsx`, route the existing attachment
action to the hidden multiple-file input through `handleUploadFiles`, retaining
the user gesture required to open it. Remove the extra upload action and the
composer's `DirectoryBrowserDialog`, selection state, server read handler and
unused imports. Check callers before removing `handleFilePathAttachment` from
`prompt-input/usePromptAttachments.ts`; keep shared server APIs used elsewhere.

Update labels/help in all ten locales. Preserve keyboard interaction, accessible
menu names, disabled state and focus return in normal and compact layouts.

### 2. Unify copied-file ingestion

Keep `prompt-input/device-file-selection.ts` as the bounded byte-reading primitive.
Picker and drop already share `handleDeviceFileSelection`. Bring clipboard file
reads under the same budget, pending-state and cancellation rules: the existing
clipboard `FileReader` callback is a separate path today. Preserve image tokens,
MIME types and long-text paste semantics when connecting it.

Strengthen lifecycle identity with an invalidated generation rather than relying
only on current ID equality (including an A → B → A session transition). Capture
the owning draft when the picker opens, as well as when reading starts. Keep this
logic in the attachment controller instead of growing the composer component.

### 3. Validate project references and compatibility

Reuse `unified-picker.tsx` and `prompt-input/usePromptPicker.ts` unchanged unless a
regression is demonstrated. Preserve Tab completion/navigation, Enter/click file
attachment, Shift+Enter path-only insertion and directory semantics. Check the
selected session/worktree root, including remote and WSL paths and Git-degraded
directory mode. Existing draft attachments must still hydrate and serialize.

Keep proxy ownership checks and prompt-only body limits in place. Preserve normal
prompt submission, custom commands and `/btw` attachment retention semantics.

### 4. Verification and completion criteria

- Update `tests/browser/device-upload.test.ts`: assert exactly one attachment
  action and that it opens a native file chooser. Replace the server-browser
  composer scenario with a real `@` reference-selection scenario.
- Exercise real SessionView and serialized prompt parts across web, Electron and
  Tauri runtime fixtures, in local/remote contexts. Include WSL path assertions;
  distinguish mocked runtime coverage from actual desktop picker smoke checks.
- Cover multiple files, cancellation, reselection, mixed acceptance, MIME/filename
  preservation, boundary sizes/counts, unreadable files, clipboard and drop parity.
- Cover pending reads, picker-open session change, A → B → A, deactivation,
  unmount, worktree changes, and overlapping ingestion without cross-draft writes.
- Retain attachment persistence/submission tests and server budget/local/remote
  proxy tests. Re-run session-aside browser tests after composer integration.
- Inspect narrow and wide rendered layouts, keyboard-only operation, French and
  one RTL locale; smoke-test the native picker in both desktop hosts.
- Update the PR summary to describe the single-action UX and the outside-project
  scope change, with test evidence and captures. Completion means the matrix above
  holds without duplicate menu actions or device-path fallback.

## Size considerations

`prompt-input.tsx` is already approximately 1,190 lines and
`prompt-input/usePromptAttachments.ts` approximately 530 lines. Remove obsolete
composer wiring and keep any new ingestion/lifecycle helper focused; avoid an
unrelated broad component refactor as part of this UX change.
