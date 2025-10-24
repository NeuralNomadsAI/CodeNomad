---
title: Long Paste Handling
description: Summarize large pasted text into attachments.
---

Implement Long Paste Handling

---

### Detect Long Pastes

Monitor clipboard paste events for text content. Identify if the pasted text exceeds a defined length (e.g., >150 characters or >3 lines).

---

### Create Summarized Attachments

If a paste is identified as "long", prevent direct insertion into the input field. Instead, create a new text attachment containing the full content.

Display a summarized chip for the attachment, such as `[pasted #1 10+ lines]`.

---

### Acceptance Criteria

- Pasting short text directly inserts it into the input.
- Pasting long text creates a summarized attachment chip.
- The full content of the long paste is retained within the attachment for submission.
- Multiple long pastes create distinct numbered chips.
