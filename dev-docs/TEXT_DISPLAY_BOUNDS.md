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

Structured tool values (an object input or output) larger than about 10 KB are
not serialized for display at all: they keep the existing explicit "Structured
output omitted from rendering" message, without a reveal; copy still returns them
whole.

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
  steps of about 250 000 characters (each window end moves back to a nearby line
  break), labelled with the exact count the step adds (e.g. **Show 250,009 more**),
  so no single render jumps by more than about ¼ MB; a 1 MB output needs four steps.
- Markdown longer than `MARKDOWN_HIGHLIGHT_CHARACTER_LIMIT` (100 000) renders code
  blocks without syntax highlighting. Default windows stay highlighted.
- While a reply streams (`streaming` on text parts of a message still in
  `streaming` status), a window over `STREAMING_INSTANT_RENDER_CHARACTER_LIMIT`
  (10 000) keeps its last render and re-renders at most every
  `STREAMING_RENDER_INTERVAL_MS` (200 ms), always with the latest text and without
  syntax highlighting; completion renders immediately, highlighted. Shorter replies
  render every chunk as before. Measured with 10 chunks of 80 characters, 50 ms
  apart (main-thread task time per chunk, Chromium):

  | Window | Before | After |
  | --- | --- | --- |
  | 9 000 prose / code | 5 renders, 8 / 25 ms | unchanged |
  | 45 000 prose | 10 renders, 60 ms | 4 renders, 9 ms |
  | 45 000 code | 10 renders, 112 ms | 4 renders, 2 ms |
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
  displayed. Its cache entries keep only HTML: a window is a slice that would retain
  the whole part after eviction while the cache accounts only for the slice.
- Windows read sources through `slice` (`TextSource`; strings qualify). Text joined
  from parts, like a shell call's `$ command` and output, uses `joinedTextSource`,
  so a window copies only its prefix and never keeps a whole join alive between tool
  updates. Tool speech likewise bounds each section before joining.
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

- Unit: `lib/render-text-window.test.ts` (windows, exact step counts, joined-source
  retention against a full-join control), `components/tool-call/render-memory.test.ts`
  (speech retention), `stores/message-v2/instance-store.test.ts`.
- Browser: `tests/browser/reveal-truncated-text.test.ts` (text and tool reveals,
  reveal point while following the bottom, virtualization and session switch, copy),
  `markdown-latest-request.test.ts` (reveal, cache entries, streaming renders and
  main-thread time; `CODENOMAD_MARKDOWN_BASELINE=<markdown.tsx>` measures an earlier
  component), `render-cost.test.ts` (megabyte-scale reveal steps),
  `full-source-copy.test.ts`, `mission-primitives.test.ts`. Set
  `CODENOMAD_REVEAL_SCREENSHOTS=<dir>` to capture dark-theme before/after screenshots.

## Agent conventions

These rules moved here from `AGENTS.md`, which indexes this document; they bind every change in this area.

- A message renders at most `MESSAGE_PART_DISPLAY_LIMIT` parts (head + tail). Omitted parts render as a placeholder at the exact gap with an in-place "Show more" control that keeps keyboard focus at the revealed parts, never as a copy-only footer. Reveal state lives in `stores/message-v2/record-display-cache.ts`; every derived cache (blocks, grouping, timeline) keys on it, and technical groups/cleanup runs never span the gap. Styles live in `styles/messaging/hidden-message-parts.css`. Long text blocks are bounded the same way, per block (`lib/render-text-window.ts`): prose Markdown (text parts, subagent prompts/reports, skills) renders 50 000 characters and tool output (shell, read, diff, ANSI, patches, errors) 10 000, followed at the exact cut, inside the block's own scroller, by the `components/hidden-text.tsx` reveal line ("N more characters hidden…" with Show all, or "Show N more" with the exact count of a ~250 000-character step beyond a ¼ MB remainder). Renderers pass full native text to `renderMarkdown` (with `codeLanguage` for fenced output), `renderDiff` or `BoundedText`, never pre-truncated text, and text joined from parts as a `joinedTextSource` rather than a full join; text reveal steps are keyed by instance/message/part/section in the same cache and reset with the instance. Markdown keeps its rendered prefix until the longer render lands, shows the reveal line only after its real render, skips syntax highlighting beyond 100 000 characters, caches HTML without source slices, coalesces streaming re-renders of windows over 10 000 characters (one per 200 ms, unhighlighted, immediate on completion), and holds the reveal point through `TranscriptAlignmentContext`. Never reintroduce a copy-only suffix; copy/search read native text and tool speech keeps its own bound. See `dev-docs/TEXT_DISPLAY_BOUNDS.md`.
