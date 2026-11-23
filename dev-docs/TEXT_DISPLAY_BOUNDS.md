# Text display bounds

Long message text and tool output stay complete in the message store. Rendering
shows a bounded prefix and in-place reveal per block, as for the per-message part
window (`MESSAGE_PART_DISPLAY_LIMIT`).

## Bounds

`packages/ui/src/lib/render-text-window.ts` owns the constants and the pure
`getRenderTextWindow(source, limit, revealSteps)`.

| Block | Initial bound |
| --- | --- |
| Prose Markdown: assistant/user text parts, compaction summaries, skill instructions | 50 000 characters |
| Tool output: shell, read, write, edit/patch fallbacks, diffs, ANSI, execute, webfetch, tool input and errors | 10 000 characters |
| Subagent card panes (the task card's nested prompt and report scrollers) | 20 000 characters (`TASK_PANE_RENDER_CHARACTER_LIMIT`) |
| Reasoning (plain text in the thinking card's scroller) | 10 000 characters (`REASONING_RENDER_CHARACTER_LIMIT`) |

Structured tool values (an object input or output) larger than about 10 KB are
never serialized for display: they show the explicit "Structured output omitted
from rendering" message, without a reveal; copy returns them whole.

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
  syntax highlighting; completion renders immediately, highlighted. Shorter
  windows render every chunk. Reasoning applies the same interval to its
  window while the part streams (no `time.completed` in a message still
  `sending` or `streaming`). Past the bound its window keeps the prefix and the
  reveal line counts the text still arriving; a reveal renders the live text at
  once and stays after completion. Reasoning cards are keyed by part, so a delta
  updates the streaming card in place.
- Diffs over 10 000 characters render as plain text
  (`shouldRenderDiffPayloadAsPlainText`), and the window applies to either form.
  `apply_patch` and multi-file `patch` share one 10 000-character budget across a call's files: each rendered
  file reveals its own diff, and files omitted entirely show a copy-only status.

## Reveal state and rendering

- Steps live in `stores/message-v2/record-display-cache.ts`, keyed by
  instance/message/part/section (`output`, `input`, `error`, `task:prompt`, …), so
  they survive virtualization remounts, re-renders and session switches, and reset
  with the instance's render caches. Markdown outside the transcript (mission
  readers, previews) reveals for its mount only.
- `components/hidden-text.tsx` provides the window hook, `BoundedText` for plain
  renderers and the reveal line, which sits right after the bounded content, inside
  tool panes' and reasoning cards' own scrollers. Its button is described by the
  status text. A reasoning reveal leaves its scroller's bottom-following
  (`FollowScrollHelpers.stopFollowing`), so the revealed text grows below the
  reader; scrolling back to the bottom follows again.
- Markdown computes the window inside its own memo (a reveal re-renders in place)
  and gives bounded windows a distinct cache version; caching only HTML matters
  because a slice would retain the whole part after eviction while the cache
  accounts only for the slice.
- Windows read sources through `slice` (`TextSource`; strings qualify). Text joined
  from parts, like a shell call's `$ command` and output, uses `joinedTextSource`,
  so a window copies only its prefix and never keeps a whole join alive between tool
  updates. Tool speech likewise bounds each section before joining.
- A task card's steps list mounts only its newest `TASK_STEP_MOUNT_LIMIT` (30) rows:
  each nested row is a whole tool card, so the scroller's layout cost is charged per
  mounted row. The omitted gap renders the shared hidden-parts placeholder and one
  reveal mounts `TASK_STEP_REVEAL_STEP` (100) more rows, keyed `task:steps` in the
  record display cache like a text reveal. The window's start may slide forward only
  up to the boundary of what the reader is actually reading — the first row still in
  sight, or nearer still a row holding focus or the selection, wherever it sits. The
  boundary is read from the DOM (row identity against the current keys) on each
  window change, so it survives the scan bound dropping older rows and never depends
  on a remembered anchor; the scan bound itself caps what a held window can mount.
- Search navigation marks the hit's part search-revealed (`markRecordPartSearchRevealed`
  in the record display cache): every text window of that part gains one base reveal
  step, and the reader's own reveals stack on top of it, so a hit beyond a window's
  rendered prefix still lands in view — and further **Show more** clicks keep
  extending — while the highlight pass finds it. The mark is idempotent and clears
  with the instance's render caches.
- A reveal at transcript level (text parts, errors) holds the pre-reveal cut point
  through the transcript list's `alignElement` (`TranscriptAlignmentContext`): an
  absolutely positioned marker in the row is held before the text grows, so neither
  bottom-following nor the list's compensation moves the reader. After **Show all**
  keyboard focus moves to the revealed text through a temporary tab stop;
  **Show N more** keeps focus on its button.

## Native-content readers

Copy actions, search (native history queries) and the timeline read native
content. Tool speech has its own 10 000-character bound, and reasoning speech
reads the first `REASONING_RENDER_CHARACTER_LIMIT` characters. The display
projection carries the whole native reasoning text (a reference to the store's
string), which the card windows.

## Validation

- Unit: `lib/render-text-window.test.ts` (windows, exact step counts, joined-source
  retention against a full-join control), `components/tool-call/render-memory.test.ts`
  (speech retention), `stores/message-v2/instance-store.test.ts`.
- Browser: `tests/browser/reveal-truncated-text.test.ts` (text and tool reveals,
  reveal point while following the bottom, virtualization and session switch, copy),
  `tests/browser/tool-card-bounds.test.ts` (subagent card pane windows, the steps
  tail window with its in-place reveal, reveal persistence across remounts, and
  bottom-following while steps stream),
  `markdown-latest-request.test.ts` (reveal, cache entries, streaming renders and
  main-thread time; `CODENOMAD_MARKDOWN_BASELINE=<markdown.tsx>` measures another
  component as baseline), `render-cost.test.ts` (megabyte-scale reveal steps),
  `reasoning-stream.test.ts` (a 100k+ thinking stream: growing reveal line, coalesced
  revealed renders in place, reveal kept after completion; streaming and completed
  reveals keep the reader's scroll position, also after following again),
  `full-source-copy.test.ts`, `mission-primitives.test.ts`. Set
  `CODENOMAD_REVEAL_SCREENSHOTS=<dir>` to capture dark-theme before/after screenshots.

## Agent conventions

- A message renders at most `MESSAGE_PART_DISPLAY_LIMIT` parts (head + tail), the outline contract's `MESSAGE_DISPLAY_LIMIT`: indexed timeline layouts list the same displayed parts. Omitted parts render as a placeholder at the exact gap with an in-place "Show more" control that keeps keyboard focus at the revealed parts, never as a copy-only footer. Reveal state lives in `stores/message-v2/record-display-cache.ts`; every derived cache (blocks, grouping, timeline) keys on it, and technical groups/cleanup runs never span the gap. Styles live in `styles/messaging/hidden-message-parts.css`.
- Apply the block bounds and reveal rules above. Renderers pass full native text to `renderMarkdown` (with `codeLanguage` for fenced output), `renderDiff` or `BoundedText`, never pre-truncated text; joined parts use `joinedTextSource`. Markdown keeps its rendered prefix until the longer render lands and shows the reveal line only after its real render. Never add a copy-only suffix.
