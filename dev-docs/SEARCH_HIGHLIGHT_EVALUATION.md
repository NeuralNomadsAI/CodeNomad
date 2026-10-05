# Transcript search: CSS Custom Highlight implementation and evaluation

## Result

CSS Highlight removes search-induced DOM rewrites, preserves a user's text
selection, and reduces synchronous highlighting work in the real `MessageBlock`.
The largest measured benefit is on mixed text/reasoning/tool messages. Small
messages do not show a meaningful improvement in time to the next paint opportunity.

The implementation, regression fixtures and repeated comparison are part of this
PR. This is a renderer change; it does not accelerate database search or change
full-history retrieval.

## Implementation

- `components/search-highlight-ranges.ts` collects literal, trimmed,
  locale-lowercased matches from rendered message/reasoning/tool text. It skips
  controls and deduplicates nested containers. Both painting paths use these ranges.
- `components/search-highlights.ts` owns one contribution per mounted message.
  The document shares ordinary/active Highlight sets; disposing a row removes
  only its ranges. The last owner removes the registrations. Weak maps, observer
  disconnection and cancelled animation frames fence disposal and late work.
- A child/text mutation observer coalesces repaint after committed asynchronous
  Markdown, tool and streaming updates. It is disconnected during its own fallback
  mutations. Query/record changes retain the existing `MessageBlock` effect lifecycle.
- Hosts missing either `Highlight` or `CSS.highlights` use `<mark>` wrappers.
  `search-highlight-marks.ts` partitions original text before mutation so two
  case-folded hits sharing an original character cannot truncate the active hit.
  Fallback removal restores text and normalizes the parent. This path still
  mutates DOM and does **not** gain selection preservation.
- Native highlight colors retain the existing search palette. The active match
  uses an underline instead of the mark's box shadow. Highlights add no padding
  and do not change line wrapping. Styles live in `styles/messaging/search-highlights.css`.
- Active message/part/occurrence identity remains unchanged. A range rectangle
  reveals an out-of-view occurrence through nested vertical/horizontal scrollers.
  This is immediate, minimal reveal rather than the former smooth unconditional
  centering. An already visible occurrence does not move the scroll position.

Two intentional boundaries: changing only the active occurrence still rebuilds
the row's matches; queries spanning separate formatted DOM text nodes remain
unsupported by the painter, as before. Case-fold expansions now map back to original
UTF-16 offsets (for example `İ needle`), fixing the baseline's shifted ranges.
The existing 10,000-character Markdown display cap is unchanged.

## Reproducible comparison

Baseline: `6f6edbbcb91227fdd1d5863f6c21fad2691de679`.
`tests/browser/fixtures/search-highlight-baseline.ts` contains its three painting
functions verbatim, with imports/exports added; equality was checked against
`git show`. Keeping this frozen fixture also supports shallow CI checkouts.

The Vite test harness swaps only `MessageBlock`'s painter import. Both variants
use the real Solid components, preferences/providers, styles and rendered data.
There is no application setting or production dependency on the baseline.
Native event-dispatcher tests use synthetic events and isolated HTTP responses;
no shared daemon, personal transcript, database or provider is involved.

Measurements use a production build on Windows 11 (`10.0.26200`), Intel
Core i9-14900KF. Each workload/mode has **30 retained trials**, in six blocks of
five, with three warm-ups before each block; mode order alternates per block.
Queries alternate `needle` and `ribbon`. No samples are removed. Chromium uses
foregrounded pages; Electron reloads the same isolated visible window per block.
Compare modes **within** a host, not absolute timings across different refresh rates.

| Workload | Fixture input | Painted matches |
| --- | --- | ---: |
| short | Two messages, eight lines each | 16 |
| long | One 1,600-line source, rendered through the existing display cap | 97 |
| dense | One 400-line source, eight repetitions per line, same cap | 674 |
| mixed | Twelve messages with Markdown, reasoning and completed bash output | 756 |
| sparse | Large source with one matching rendered line | 1 |
| missing | Large source without either query | 0 |

The final-run harness records base-text/rendered character counts (mixed repeats
the base text in three parts), DOM counts, all samples, versions, normalized-source
SHA-256 hashes and GC counters. Initial artifacts predate the hash fields and name
the repeated base-text count `sourceCharacters`. The large-source
workloads are **not** claims about painting all 1,600 source lines.

Metrics:

- **Sync**: instrumented cleanup + apply duration. Includes collection and
  registration/wrapping, but excludes later browser layout/paint. Streaming observer
  work is covered functionally, not included in this static-query benchmark.
- **Paint opportunity**: query update to the second subsequent animation frame.
  This includes a browser paint opportunity, **not measured GPU presentation**.
- **DOM records**: subtree child/text MutationObserver records during the update.
- **Long tasks**: PerformanceObserver entries during that interval, retained in
  raw data. These short runs do not establish a general dropped-frame/FPS benefit.
- p50 is the median; p95 is nearest-rank. Sub-millisecond differences are noisy.

## Timings

Reviewed-source production runs at `897ccbcc`, 30 samples per cell; values are **p50 / p95 ms**:

| Workload | Chromium baseline sync | Chromium CSS sync | Electron baseline sync | Electron CSS sync |
| --- | ---: | ---: | ---: | ---: |
| short | 0.30 / 0.40 | 0.10 / 0.20 | 0.30 / 0.50 | 0.10 / 0.40 |
| long | 0.70 / 1.30 | 0.20 / 0.30 | 0.90 / 1.70 | 0.20 / 0.40 |
| dense | 2.80 / 3.40 | 0.40 / 0.60 | 3.50 / 4.30 | 0.50 / 0.90 |
| mixed | 16.45 / 29.70 | 4.05 / 6.80 | 14.50 / 26.10 | 4.30 / 4.70 |
| sparse | 0.30 / 0.40 | 0.10 / 0.30 | 0.30 / 0.60 | 0.20 / 0.40 |
| missing | 0.20 / 0.30 | 0.10 / 0.20 | 0.20 / 0.50 | 0.20 / 0.30 |

Mixed-query synchronous work falls **75% in Chromium and 70% in Electron**.
Mixed paint-opportunity p50/p95 changes from **49.70/68.30 to 33.20/34.50 ms**
in Chromium, and **50.00/66.80 to 12.00/162.60 ms** in Electron. The Electron
tail is **worse**, despite its improved median and synchronous cost. Its mixed
long-task count was **2 baseline versus 4 CSS**. These outliers are retained;
the evidence supports less synchronous work and selection preservation, not a
universal latency/FPS improvement. Most small/sparse cases remain frame-bound.

DOM mutation-record medians fall from **96 / 582 / 3455 / 3708 / 6 / 0**
(short/long/dense/mixed/sparse/missing) to **zero** for every CSS workload.

Raw reviewed-source evidence: [Chromium](measurements/search-highlights/chromium.json),
[Electron](measurements/search-highlights/electron.json).
Generate all percentiles with `tests/browser/search-highlight-report.mjs`.
The earlier [Chromium](measurements/search-highlights/chromium-initial.json) and
[Electron](measurements/search-highlights/electron-initial.json) runs are retained
separately; they predate the final review fixes and are not the final table's inputs.

## Correctness and lifetime evidence

The browser suite exercises the real message renderer for:

- baseline/CSS/fallback match counts and active occurrence, literal queries,
  Unicode expansion, emoji, Hebrew, multiline text and excluded controls;
- a selected `needle` remaining selected after CSS painting, while the baseline
  reproducibly loses the selection by replacing its text node;
- owner isolation, unmount/remount, query close, delayed text replacement,
  reasoning disclosure, real tool content and native streaming text events;
- revealing an active occurrence inside nested overflow, unchanged CSS layout,
  distinct active/inactive styles in light/dark mode at 125% zoom;
- repeated query/owner churn, empty registries after disposal and no detached
  registered ranges after renderer replacement.

After warming component caches, 16 mount/search/dispose cycles and forced
Chromium GC left **189 DOM nodes and 34 event listeners before and after**, for
both modes in the initial browser and Electron runs. This is bounded DOM-retention
evidence, not a full heap-leak proof or a claim that the baseline leaks.
Selection text is verified; operating-system clipboard integration is not measured.

## Host coverage and limits

UI typecheck passes. The first full browser run finished with **467 passing,
five failing and two skipped** checks. Two failures were obsolete `<mark>`-only
assertions in `system-messages.test.ts`; these now assert painted range content
and ownership. The other three are `permission-fallback-diff.test.ts` timeouts,
reproduced unchanged in an isolated archive of the pinned base commit.

Review found and corrected overlapping Unicode fold ranges in the mark fallback:
searching `\u0307i` in `İİİ` previously truncated the first active hit. Original-text
partitioning now preserves both active occurrences. The post-fix Chromium search
and system-message run passes **16 checks, with only the opt-in benchmark skipped**.
The subsequent review pass found no further actionable defects in the PR changes.
Reviewed-source production reruns: **12/12 Chromium, 12/12 Electron, 10/10 WebKit**
(WebKit skips Chromium GC counters and the opt-in benchmark). Selected captures:
[light, Chromium](measurements/search-highlights/chromium-light-125.png) and
[dark, Electron](measurements/search-highlights/electron-dark-125.png), both at 125%.

| Host | Coverage |
| --- | --- |
| Playwright Chromium 153.0.8010.12, Windows | Real-component correctness, forced fallback, repeated production measurements and GC counters |
| Electron 39.0.0 / Chromium 142.0.7444.52, Windows | Same renderer in an isolated native BrowserWindow; production comparison and GC counters |
| Playwright WebKit 26.6, Windows | Real-component correctness and forced fallback; no performance claim |
| Tauri / Windows WebView2 | Native application not exercised |
| Tauri / macOS WKWebView / Linux WebKitGTK | Native applications not exercised; Playwright WebKit is not a substitute |
| Other remote browsers / assistive technology | Not exercised |

Only mounted rendered content is painted. Existing history-search/navigation
fixtures cover the surrounding bounded-window behavior; this benchmark does not
measure search-index or virtualization throughput. No cold-start improvement,
streaming FPS improvement or universal platform speedup is claimed.

## Run it

From `packages/ui`, after installing dependencies and Playwright Chromium:

```powershell
node --import tsx --test tests/browser/search-highlight.test.ts
$env:CODENOMAD_HIGHLIGHT_PRODUCTION = '1'
$env:CODENOMAD_HIGHLIGHT_RESULTS = 'path/to/chromium.json'
$env:CODENOMAD_HIGHLIGHT_CAPTURES = 'path/to/captures' # optional
node --import tsx --test tests/browser/search-highlight.test.ts
node tests/browser/search-highlight-report.mjs path/to/chromium.json
```

Run benchmarks without concurrent builds/tests. Set `CODENOMAD_HIGHLIGHT_HOST`
to `electron` or `webkit` for those hosts (default: `chromium`). Install the
Electron binary with `node node_modules/electron/install.js` from the repository
root if install scripts were skipped; install WebKit with `npx playwright install
webkit`. `CODENOMAD_TEST_ELECTRON` can select a test executable and
`CODENOMAD_TEST_TEMP` a dedicated temporary directory. Electron uses a fresh,
isolated profile; test build/profile cleanup never touches application user data.
