# Proposal: evaluate CSS Custom Highlight for transcript search

Status: **draft proposal; benefit unverified; no runtime change implemented**.

## Question and hypothesis

Would painting search matches with `Range` + the CSS Custom Highlight API be
measurably better than inserting and removing `<mark>` elements in CodeNomad's
transcript? Fewer DOM mutations are a mechanism, not proof of better performance
or reliability. Keep the current implementation if the experiment does not show
a worthwhile improvement.

This proposal follows the comparison with OpenChamber 2.1.1. Its
[search highlighter](https://github.com/openchamber/openchamber/blob/e302062e3be0686986594fddabdafd8a97c129e5/packages/ui/src/components/chat/search/chatSearchHighlight.ts)
uses CSS highlights without rewriting Markdown nodes. That is a design
reference, not a measured advantage in CodeNomad; no implementation is copied
in this proposal.

## Observed baseline

Inspected CodeNomad revision: `6f6edbbcb91227fdd1d5863f6c21fad2691de679`.

- `packages/ui/src/components/message-block.tsx` owns `applySearchMarks` and
  `removeSearchMarks`. Applying a query first unwraps old marks and normalizes
  their parents, walks searchable text nodes, then replaces matching nodes with
  fragments containing marks. The active mark is scrolled into view.
- Its reactive effect schedules this work with `requestAnimationFrame` and
  cleans it up when the query, active match, record or relevant disclosure
  changes. A large message may therefore be traversed and rewritten repeatedly.
- Search includes message text, tool content and reasoning. Matching uses a
  trimmed literal query with locale-aware lowercasing, and tracks the active
  message, part and occurrence. These semantics differ from OpenChamber's
  word-based search and narrower text selectors.
- Existing colors are in
  `packages/ui/src/styles/messaging/message-section.css`.
- Full-history retrieval and bounded anchor navigation are separate concerns;
  see [history queries](SESSION_HISTORY_QUERIES.md) and
  [history navigation](SESSION_HISTORY_NAVIGATION.md).

The baseline establishes where work happens. It does not establish a visible
stall, a broken selection or a measured performance problem.

## Candidate design for an isolated prototype

1. Build DOM ranges for eligible rendered text instead of splitting text nodes.
   Keep literal-query semantics and existing exclusions for controls. Avoid
   double-counting nested searchable containers.
2. Paint ordinary and active matches separately with `::highlight(...)`, using
   existing theme tokens. Verify active-match visibility rather than assuming
   all styles supported by `<mark>` work on highlight pseudo-elements.
3. Put range ownership and document registration behind one small module.
   Each mounted message replaces/releases only its own contribution. One row
   must never clear another row's matches. `CSS.highlights` is document-global;
   multiple transcripts or previews must not accidentally share ownership.
4. Treat ranges as disposable rendered state. Rebuild after committed Markdown
   rendering, streaming replacements or disclosure changes. Release on row
   unmount, search close and inactive-session transitions. Do not retain ranges
   pointing into evicted transcript nodes or hydrate offscreen history to paint
   it. Fence scheduled work when its owner or render revision changes.
5. Changing the active occurrence should update its highlight without rebuilding
   unchanged match ranges where practical. Preserve message/part/occurrence
   identity and the existing next/previous behavior.
6. Replace active-mark scrolling with range-rectangle navigation through the
   correct nested scroller. A Range has no `scrollIntoView`; long code/tool
   blocks, wrapped matches and newly mounted anchor windows need real gestures
   and rendered verification, not just a row-level scroll.
7. Detect support in the target document/window. Exercise a fallback using the
   current mark renderer when the API is unavailable, or explicitly revise the
   supported-host contract before removing that fallback. Electron success does
   not establish support in every Tauri WebView or remote browser.

Use shared matching logic where possible so supported and fallback paths cannot
silently diverge. Include a test-only way to run both renderers on identical
fixtures. Any prototype is experimental until the evidence below is recorded.

## Correctness and lifecycle checks

Extend real-component fixtures under `packages/ui/tests/browser/`, especially
`session-search.test.ts`, `history-navigation.test.ts` and their fixtures.
Test observable search, rendering and navigation outcomes, not the presence of
one particular wrapper element.

| Scenario | Required observation |
| --- | --- |
| Plain text, Markdown, links, code and tool output | Same eligible occurrences and active target; controls remain usable |
| Thinking and system disclosures | Correct repaint after content becomes visible; hidden content follows existing visibility rules |
| Virtualized rows and distant search results | Highlights return after remount without loading intermediate transcript pages |
| Streaming and asynchronous Markdown replacement | No stale paint or detached-node accumulation after committed updates |
| Repeated query/active-match changes | No old ranges or cross-row clears; next/previous targets remain stable |
| Selection, copy, links and tool buttons | Selected/copied content and interactions remain correct while search changes |
| Nested code/tool scrolling | Active occurrence is visible in its actual scroller without unwanted transcript jumps |
| Session switching, multiple surfaces, search close | Each owner releases its contribution; late work cannot repaint an inactive session |
| Light/dark themes, zoom, RTL and Unicode | Active/inactive matches remain legible and offset mapping is correct |
| API unavailable | Fallback remains functional with the same matching/navigation contract |

Record existing limitations separately: a query spanning formatted text nodes
and lowercasing that changes string length require explicit expected results.
Do not silently change search semantics or introduce incorrect range offsets to
make a screenshot look better. Any semantic fix should be identified separately
from a renderer-performance claim.

## Comparative measurement protocol

- Compare the baseline and candidate on the same machine, host versions, build
  mode, fixture data and viewport. Record exact commits and host/runtime versions.
- Use synthetic transcripts: short prose; one very large response; dense repeated
  matches; many visible mixed tool/reasoning blocks; streaming updates; repeated
  virtualization/anchor navigation; and no-match/rare-match controls.
- Keep search responses and transcript loading identical. Measure the renderer
  separately from database search latency; a faster FTS query is not evidence
  for this change.
- Warm up both variants, then alternate at least 30 recorded trials per workload.
  Record cold initialization separately. Report variability and p50/p95 rather
  than the best run; capture missed frames or long tasks during streaming.
- Measure query-to-painted-highlight and active-match-to-visible latency,
  traversal/cleanup/registration cost, DOM mutation counts and retained nodes or
  ranges after repeated close/reopen/unmount cycles. Include traces and real
  captures so fewer mutations cannot hide extra layout or paint work.
- Verify Electron, Windows Tauri/WebView2 and macOS/Linux Tauri/WebKit separately,
  plus supported remote browsers. Mark unavailable host checks as pending rather
  than treating Chromium fixtures as native-host validation.
- Use isolated fixtures and profiles, never personal transcripts or the shared
  OpenCode database. No provider requests are needed for this experiment.

## Evidence and adoption decision

| Evidence | Current result |
| --- | --- |
| Baseline/candidate prototype | Not implemented |
| Comparative timings and traces | Not measured |
| Search/navigation and selection parity | Not tested |
| Native-host compatibility and fallback | Not tested |
| Retained-node/range behavior | Not measured |
| Adoption decision | Pending evidence |

Before deciding, attach raw measurements, workload sizes, commits, host versions,
captures and failures to the implementation PR. Adoption requires either a
repeatable user-visible latency/frame improvement beyond measured variability,
or a reproduced rendering/selection defect fixed by this design, together with
correctness and lifecycle parity. Agree any numerical regression tolerance
before interpreting the experiment; do not choose a threshold after seeing it.

If gains are negligible, host behavior is inconsistent, or ownership/fallback
complexity outweighs the benefit, retain the mark renderer and record that
outcome. A successful API demonstration alone is not grounds to replace it.

This draft records the principle and evaluation plan only. It does not approve
shipping the candidate or claim a performance improvement.
