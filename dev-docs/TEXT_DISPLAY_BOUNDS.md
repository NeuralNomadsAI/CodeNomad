# Text display bounds

Long message text and tool output stay complete in the message store. Rendering
shows a bounded prefix of each block and an in-place reveal of the rest, the same
philosophy as the per-message part window (`MESSAGE_PART_DISPLAY_LIMIT`).

## Bounds

`packages/ui/src/lib/render-text-window.ts` owns the constants and the pure
`getRenderTextWindow(source, limit, revealSteps)`.

| Block | Initial bound | Why |
| --- | --- | --- |
| Prose Markdown: assistant/user text parts, compaction summaries, subagent prompts and reports, skill instructions | 50 000 characters | ≈35 ms to parse and lay out in Chromium |
| Tool output: shell, read, write, edit/patch fallbacks, diffs, ANSI, execute, webfetch, tool input and errors | 10 000 characters | ≈70 ms with syntax highlighting |

Measured on Chromium (dev machine, dark theme, 800 px column; parse + layout):

| Characters | Prose Markdown | Highlighted code | Unhighlighted code / plain text |
| --- | --- | --- | --- |
| 10 000 | 6 ms | 62 ms | 1 ms |
| 50 000 | 30 ms | 265 ms | 3 ms |
| 100 000 | 72 ms | 445 ms | 5 ms |
| 250 000 | 312 ms | 1.25 s | 19 ms |
| 1 000 000 | 5.9 s | 3.8 s | 70 ms |

Prose parsing grows faster than linearly and highlighting costs about 5 µs per
character, so:

- A window ends on a line break within the last tenth of its budget when there is
  one (keeping code lines and terminal escape sequences whole) and never splits a
  surrogate pair.
- **Show all** reveals the whole remainder when it is at most
  `TEXT_REVEAL_CHARACTER_STEP` (250 000) characters. Larger remainders reveal in
  steps labelled **Show 250,000 more**, so no single render jumps by more than about
  ¼ MB; a 1 MB output needs four steps.
- Markdown longer than `MARKDOWN_HIGHLIGHT_CHARACTER_LIMIT` (100 000) renders code
  blocks without syntax highlighting. Default windows stay highlighted.
- Diffs keep their existing decision: over 10 000 characters they render as plain
  text (`shouldRenderDiffPayloadAsPlainText`), and the window applies to either form.
  `apply_patch` still shares one 10 000-character budget across its files: each
  rendered file reveals its own diff, and the copy-only status remains only for
  files omitted entirely.

## Reveal state and rendering

- Steps live in `stores/message-v2/record-display-cache.ts`, keyed by
  instance/message/part/section (`output`, `input`, `error`, `task:prompt`, …), so
  they survive virtualization remounts, re-renders and session switches, and reset
  with the instance's render caches. Markdown outside the transcript (mission
  readers, previews) reveals for its mount only.
- `components/hidden-text.tsx` provides the window hook, `BoundedText` for plain
  renderers and the reveal line, which sits right after the bounded content, inside
  tool panes' own scrollers. Its button is described by the status text.
- Markdown computes the window inside its own memo (a reveal re-renders in place),
  gives bounded windows a distinct cache version, keeps the rendered prefix until
  the longer render lands, and shows the reveal line only once its real render is
  displayed.
- A reveal at transcript level (text parts, errors) holds the former reveal point
  through the transcript list's `alignElement` (`TranscriptAlignmentContext`): an
  absolutely positioned marker in the row is held before the text grows, so neither
  bottom-following nor the list's compensation moves the reader. After **Show all**
  keyboard focus moves to the revealed text through a temporary tab stop;
  **Show N more** keeps focus on its button.

## Not bounded by rendering

Copy actions, search (native history queries) and the timeline read native
content. Tool speech keeps its own 10 000-character bound, without any copy hint.
Reasoning text is still extracted with a separate 10 000-character bound
(`REASONING_RENDER_CHARACTER_LIMIT`) and has no reveal yet.

## Validation

- Unit: `lib/render-text-window.test.ts`, `components/tool-call/render-memory.test.ts`,
  `stores/message-v2/instance-store.test.ts`.
- Browser: `tests/browser/reveal-truncated-text.test.ts` (text and tool reveals,
  reveal point while following the bottom, virtualization and session switch, copy),
  `markdown-latest-request.test.ts`, `full-source-copy.test.ts`,
  `mission-primitives.test.ts`. Set `CODENOMAD_REVEAL_SCREENSHOTS=<dir>` to capture
  dark-theme before/after screenshots.
