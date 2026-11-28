# Questions and permissions

Native questions, Forms and permission requests are answered in the interruption dock immediately above the composer, not inside pending transcript tool cards.

## Find the request and check its source {#request-dock}

1. Select a conversation with **Needs Input** / **Needs Permission**, or click the project request badge to open the dock in place.
2. Read the request kind, conversation title and provenance before expanding or answering.
3. When several requests are pending, use **Previous request** / **Next request**. Use **View conversation** only if you want to navigate to its source.

| Provenance | Meaning and behavior |
| --- | --- |
| Open conversation | Its request can expand normally |
| Subagent, with **From …** parent | Recursive descendant of the open conversation is local context; parent provenance remains visible |
| Other conversation | Starts as a compact preview; explicitly expand to answer without leaving the current conversation |
| Project request / Service request | A Form may have no owning conversation; no invented conversation link is shown |

**Collapse requests** hides the body; it does not deny, cancel or answer anything. An expanded editor temporarily reduces the composer to its minimum height without changing its saved size or draft. Its content scrolls independently of the fixed reply actions.

## Answer questions and Forms {#answer-questions-forms}

1. Expand the intended request and complete its fields or select the offered choices.
2. When a choice field allows custom answers, an additional text field is shown: type your own answer there instead of an offered choice (or add custom values for a multiple-choice field). Answer every required question.
3. Choose **Submit**; use **Cancel** for a question or Form only when you intend that native cancellation.

Partial answers and rejection drafts survive queue refreshes and conversation navigation within the running client. They are not a submitted decision or a guarantee of recovery after client data is cleared.

Some Forms provide **Open external form** for a browser flow. Follow the request's instructions and return to its status rather than treating an opened page as a successful answer. Arbitrary provider/auth Forms are not necessarily conversation artifacts.

Completed native question tools show the question, selected answer, option descriptions and verbatim custom text in history. **Other choices** keeps the unselected alternatives available. These completed results are distinct from the live dock.

## Approve or deny a permission {#permission-decisions}

1. Read the requested operation, resources and any **Requested diff**. Check which conversation will receive the decision.
2. Optionally enter feedback explaining a denial or a safer alternative.
3. Choose **Allow Once**, **Always Allow** or **Deny**.

| Choice | Native effect | Safety boundary |
| --- | --- | --- |
| Allow Once | Approves this permission request | Not blanket approval of unrelated future operations |
| Always Allow | Sends the native persistent-approval choice for matching requests in its applicable session context | Not a CodeNomad-wide or OS-wide trust switch; review the resource/pattern being authorized |
| Deny | Rejects the request, with optional feedback | Does not undo work performed before this request |

Permission approval can release tool execution immediately. It is not a dry run. Diff/read bounds and source identity checks may prevent approval when the requested content cannot be validated; refresh and review the actual request instead of approving a different operation by assumption.

If another client settles a request, it may disappear here. A timeout or failed reply does not prove whether the native service accepted the decision: let pending-request reconciliation update the dock before making another deliberate choice.

## Read permission receipts {#permission-receipts}

1. Look for **Permission decisions** beside the associated transcript content, even when native tool cards are hidden.
2. For decisions without a source message, open **Session permission decisions**.
3. Use **Load more decisions** to continue, or **Retry** after a read failure.

Receipts record known requests/resources, the confirmed decision and available reason/provenance. **Decision in CodeNomad**, **Automatic decision** and **Native decision** distinguish observed origins; a native settlement is not proof of a user click in this window.

Receipts are read-only CodeNomad annotations, not native messages or permission-rule editors. They are excluded from native full-history search, message copy and export. They cannot reconstruct decisions missed while CodeNomad was offline, and a successful tool result is not substituted for a missing receipt. Session deletion removes its receipts.

## Conversation permission mode {#conversation-mode}

Select a conversation, open **Status → Permissions**, and click a mode. The collapsed section shows the last known mode.

- **Autonomous** — Follows OpenCode’s permission rules.
- **Supervised** — Asks before agent edits and shell commands. For those actions, global, project and conversation deny rules still apply, and allow rules become requests. Matching **Always Allow** approvals saved by OpenCode still apply.

Both modes use OpenCode’s session rules, including in its terminal UI when connected to the same service and conversation. Switching to **Autonomous** removes only the rules added for supervision. OpenCode’s configuration files stay unchanged. CodeNomad does not auto-approve requests in either mode.

Supervised is not a sandbox. Reads, access outside the project and MCP tools keep their own rules. Open requests keep their original rules.

In a subagent, **Permissions** shows and changes the root conversation’s mode. Existing subagents keep their rules when the mode changes; when a subagent starts another, the new one copies its immediate parent’s rules.

A fork gets a copy of its source’s rules and has its own mode. If CodeNomad can’t verify which rules to remove, the fork keeps them and you can still send messages.

If the mode is unconfirmed, choose **Reload permissions**. To set the starting mode, see [New conversation permissions](settings.md#new-conversation-permissions).

## Recover missing or stale requests {#request-recovery}

1. Check the connection indicator and reconnect to the same backend/project.
2. Let recovery reconcile pending native requests; known requests and drafts are retained if coverage is incomplete.

Transient recovery failures retry in the background without creating notifications. If the bundled OpenCode plugin cannot list waiting requests, one notice per backend appears in the browser tab until recovery succeeds.

An incomplete response is not an authoritative empty queue, and a missing-plugin notice is not permission to repeat a prompt, answer or approval. Configuration reload can cancel native Forms/permissions; do not use it as a routine request-refresh button. See [Troubleshooting](troubleshooting.md) and [OpenCode setup](opencode.md).
