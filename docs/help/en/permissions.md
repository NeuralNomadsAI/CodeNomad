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

New arrivals do not replace the request you are editing or navigate away. Selection stays on the same request through queue refreshes; arrows do not wrap at the ends. After settlement, another unrelated conversation's request remains compact until you open it.

**Collapse requests** hides the body; it does not deny, cancel or answer anything. An expanded editor temporarily reduces the composer to its minimum height without changing its saved size or draft. Its content scrolls independently of the fixed reply actions.

## Answer questions and Forms {#answer-questions-forms}

1. Expand the intended request and complete its fields or select the offered choices.
2. When a choice field allows custom answers, an additional text field is shown: type your own answer there instead of an offered choice (or add custom values for a multiple-choice field). Answer every required question.
3. Choose **Submit**; use **Cancel** for a question or Form only when you intend that native cancellation.

Partial answers and rejection drafts survive queue refreshes and conversation navigation within the running client. They are not a submitted decision or a guarantee of recovery after client data is cleared. A failed reply remains editable; inspect the pending request before retrying. CodeNomad does not replay an answer automatically.

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

If another client settles a request, it may disappear here. A timeout or failed reply does not prove whether the native service accepted the decision: let pending-request reconciliation update the dock before making another deliberate choice. An ambiguous reply is never shown as a fabricated confirmed decision.

## Read permission receipts {#permission-receipts}

1. Look for **Permission decisions** beside the associated transcript content, even when native tool cards are hidden.
2. For decisions without a source message, open **Session permission decisions**.
3. Use **Load more decisions** to continue, or **Retry** after a read failure.

Receipts record known requests/resources, the confirmed decision and available reason/provenance. **Decision in CodeNomad**, **Automatic · Yolo** and **Native decision** distinguish observed origins; a native settlement is not proof of a user click in this window.

Receipts are read-only CodeNomad annotations, not native messages or permission-rule editors. They are excluded from native full-history search, message copy and export. They cannot reconstruct decisions missed while CodeNomad was offline, and a successful tool result is not substituted for a missing receipt. Session deletion removes its receipts.

## Yolo mode and family scope {#yolo-mode}

1. Select a conversation and open **Status → Yolo Mode**.
2. Enable it only if automatic permission approval is acceptable for the whole family.
3. Disable it before further untrusted work; inspect pending requests and any already-running tools.

Although the control refers to a session, its effective scope is the resolved family root and descendants: enabling/disabling it from a child affects that family. A native fork is treated as its own root. It is not global approval for every project or independent conversation.

Yolo approves **permissions only**. It does not answer questions or Forms, supply missing information, guarantee successful execution or bypass backend ownership checks. The CodeNomad backend performs the auto-approval: closing one window is not sufficient to disable it while the backend remains active, and a stopped backend cannot keep approving requests. The family setting is persisted and hydrated when the workspace is loaded again.

Turning Yolo off does not revoke a decision already accepted or roll back file/network effects. Review **Automatic · Yolo** receipts and stop execution explicitly if needed. For automation with human gates, see [Missions](missions.md).

## Recover missing or stale requests {#request-recovery}

1. Check the connection indicator and reconnect to the same backend/project.
2. Let recovery reconcile pending native requests; known requests and drafts are retained if coverage is incomplete.
3. If **Question and permission recovery is incomplete** appears, inspect runtime/connectivity diagnostics and retry after resolving the cause.

Recovery does not load every inactive worktree just to enumerate requests. An incomplete response is not an authoritative empty queue, and the warning is not permission to repeat a prompt, answer or approval. Configuration reload can cancel native Forms/permissions; do not use it as a routine request-refresh button. See [Troubleshooting](troubleshooting.md) and [OpenCode setup](opencode.md).
