# Full-history queries and technical cleanup

## Entry points

The non-modal transcript search window (Ctrl/Cmd+F or the header toggle) can
query the entire session or workspace. It displays paginated excerpts and
page-local progress from that search alone. The command palette's
remove-tools-and-reasoning command plans against the same stored history. Navigation:
[SESSION_HISTORY_NAVIGATION.md](SESSION_HISTORY_NAVIGATION.md).

Both paths use the bundled `codenomad-session-pruning` plugin's authenticated RPC,
with two fixed CodeNomad routes:

- `POST /api/workspaces/:id/session-history/query` → `history`
- `POST /api/workspaces/:id/session-history/prune` → `pruneBatch`

Never expose generic RPC, caller-supplied SQL, a database filename, replacement
content or a caller-selected directory. The normal daemon and plugin provisioning
lifecycle governs the plugin. The plugin performs a fresh `ctx.storage` challenge
to bind a read-only SQLite connection to this daemon; that challenge writes only
temporary plugin KV state.

Agents use the same bundle's `codenomad.session_search` Code Mode tool to find
past discussions. Native tool permissions govern execution. Backend presence
owns both the tool and RPC registrations.

## Scope and resource limits

Session queries validate the session's current full native location and project.
Workspace queries enumerate the validated local worktree inventory, preserving
execution-host paths, and scan directory descendants without duplicate nested
worktree scans. A directory boundary and native workspace identity are always
required. Workspace scans include the current native project and migrated
`global` history in that directory tree, excluding other projects/independent
clones. Session-specific queries retain the session's actual project identity.
Each native page carries broker-only per-session location/count provenance. Before
publishing counts or excerpts the broker validates every contributing location
against the local repository/worktree ownership rules, including independent
clones that share a native project ID. This provenance is stripped from HTTP output.

Content counts and pruning pages examine at most 32 rows. Search and message-only
counts examine up to 1024 rows, stopping at 32 matching messages or 32 contributing
sessions. All scans yield to the native event loop between rows and end the page
after roughly 40 ms of processing; a running SQLite statement or JSON parse
finishes first. JSON is materialized one message at a time, limited to 16 MiB.
Oversized or unsupported content is counted as skipped and reported to the UI.
Never add an index, trigger, FTS table or persistent transcript copy.

Cursors bind scope and query; the broker also binds the authorized directory
inventory. A rowid horizon excludes new rows appended during each location scan.
The search window never starts a separate statistics traversal, and an empty
query scans nothing. Its progress (visible results and messages scanned for the
current page) updates as batches arrive and resets on pagination or a new search.
The technical-content switch changes only the search, never triggering a
tools/reasoning count.
The separate stats RPC serves explicit callers; message-only stats read metadata
without decoding JSON. A traversal spans many reads: concurrent
edits/deletes/moves can affect later pages, and different locations start at
different times.

Search is literal and case-insensitive, with one matching excerpt per message
(up to 320 characters), in stored row order. It searches text, reasoning, tool
names/arguments/text output/errors and readable native user/system/synthetic/
skill/shell/compaction text, skipping attachments and opaque continuation state.
With the technical-content switch off, SQLite reads/parses the stored JSON
but projects only readable text into JavaScript, retaining original part positions.
The UI combines scan batches until it has at least 32 results or reaches the end,
displaying partial results as they arrive. It retains one bounded result page
(at most 63 hits, to retain the final transport batch without losing its cursor).
The next-results action advances by result page, independently of scanned rows.
Ownership checks are shared by identical locations only within each broker request
and revalidated on subsequent requests. Closing the window,
changing query/scope or leaving the session cancels obsolete UI work. Resident matches scroll to their existing row without a network read.

Workspace results group consecutive hits by session. Each group names its
conversation and the worktree (label, normally its branch) that currently holds
the session's native location; never label hits with a commit (messages have
none). Titles and locations come from the session store, or from one
`session.get` per distinct unloaded session (older catalog pages, collapsed
subsessions), at most four in flight. These display reads never add sessions
to the list. Queued reads follow the visible results: a new query or page drops
sessions it no longer shows, session scope and closing abort them, and a
reconnect discards resolved labels. Only a not-found session is labelled
unavailable; other read failures retry on the next result update. The
preview's "Open in session" hydrates only that session and its parents, stores
the hit as its transcript anchor, selects it and returns its central surface to
chat, so the destination restores the bounded window around the message
through its normal anchor path.

## Ranked agent search

`codenomad.session_search({ query, since?, until?, limit?, includeTechnical? })`
searches the calling session's Location directory tree, native workspace identity,
and current project plus `global` history. The calling session's exact Location
and project are checked before and after the read. Scope comes from the plugin's
native Location. The read-only connection uses the fresh storage binding above.
Before collecting candidates, the plugin checks each contributing directory's
physical Git common directory against that Location. The shared filesystem-only
`checkout-identity.ts` reader follows administrative files, linked worktrees and
plain subfolders. Independent nested clones are excluded, including `global`
history. Missing, unreadable, ambiguous and environment-overridden identities fail
closed. A verified non-Git Location owns its physical root and plain descendants
whose bounded discovery reaches that root without finding a checkout or bare/separate
Git directory. This includes temporary and directory-only projects. Physical path,
device/inode and discovery identity bind the root across final revalidation;
unrelated folders and nested repositories stay excluded.
Request-local directory checks are bounded to 600 directories and 128
ancestor levels, with yielding and cancellation. The 128-level bound belongs to
plugin discovery; workspace filesystem discovery keeps its full ancestor walk.
Fresh ownership passes bracket body judging, independently of its time budget.
An uncached root/common-directory fence follows the final directory pass immediately
before publication. Both physical directories' device/inode identities are bound;
any observed root replacement invalidates the request. These checks filter returned
titles, hits, provenance and counts. `exclusions` reports
`foreign_directory`/`unknown_directory` reasons without rejected directory details.

Queries contain literal Unicode letter/number/underscore words of at least two
characters. The six longest distinct case-insensitive terms drive the search.
Tokens retain their original spelling and deduplicate by `/iu` equivalence, keeping
dotted-capital-I exact self-matches intact.
JavaScript judges complete Unicode words, including accented French text. Optional
`since`/`until` are real `YYYY-MM-DD` UTC dates with inclusive day bounds. `limit`
defaults to 10 and accepts 1–20. Readable text is the default;
`includeTechnical: true` also examines the shared history tool/reasoning projection.

The rowid-horizon scan covers the scope in chunks of at most 1,000 rows. It yields
between chunks and after roughly 40 ms within processing, observing cancellation.
The deterministic JavaScript scalar on the owned read-only SQLite connection
uses the judge's readable projection and shared part extraction. Text-only queries
use the same SQLite projection as body reads; technical queries additionally
extract readable tool/reasoning sources. Native JSON decoding preserves Unicode
escapes, surrogate pairs, control characters and literal backslashes exactly.
An escaped `/giu` alternation scans decoded strings for overlapping substrings;
complete-word boundaries belong to the body judge.

The substring mask covers at most 64 KiB of projected readable text per message.
Larger projections have unknown term presence. Unknown rows contribute to neither
the IDF corpus size nor document frequencies and receive no candidate score.
They are queued after known candidates within the existing judge/time budgets.
Returned hits take each session's best hit first, known-source before
unknown-source, then fill by the same order; an unknown-source hit from another
session can therefore precede a second known-source hit of one session. `prefilterBypassed`
reports unknown rows globally and per session, and the tool prints their count.
Each weight is `log(1 + N / max(df, 1))` over known collected candidates and
their term-presence bits. Known candidate rank uses the sum of present-term weights
and recency, across the scanned scope before choosing bodies.

The judge reads at most 600 candidate bodies, one materialized message at a time,
under the shared 16 MiB message bound. The shared readable-part extraction retains
native part indexes and excludes attachments and opaque state. Final scores sum
the weights of complete terms found across the message's prose, with an exact
case-insensitive query-phrase bonus equal to the sum of query-term weights.
Technical matches fill messages with no prose match when requested. Prose ranks
first within each known/unknown group, then score, then message recency. Results first take one hit per session,
then fill by rank without duplicating messages. Excerpts, at most 320 characters,
center on the rarest matched term in the selected readable part.

Collection stops at 30,000 candidates, 600 contributing sessions or approximately
1.5 seconds; the complete
collection/body-judging operation has a 2-second processing budget; the bounded
ownership validation completes independently so verified partial results survive
judge-budget exhaustion. A running SQLite statement, JSON parse
or single-message judge finishes first. The response identifies collection,
judgement and time caps, so match counts and ranking explicitly describe the
examined subset. Oversized and unsupported rows contribute to `skipped`.
The verified session count covers all matched judged messages, including matches
beyond the returned hit limit. The compact tool output gives that count and cap
notice, followed by date, folder name, session ID, title, role and excerpt per hit.
It treats excerpts as untrusted data and gives the native full-session read command.

The plugin also exposes `historyRanked` with required `version: 1`, the same query
options, ranked hits carrying the history hit fields plus `createdAt`, and bounded
per-session directory/workspace/count provenance with titles for every scanned
session, including rows that produce no match. Per-session candidate, judged and
matched-message counts let an ownership-validating broker reconstruct totals.
Its discriminant is `status: "ranked"`; blocked reads use the
shared pruning blocked result. This RPC is available to native callers. The
CodeNomad HTTP broker and UI continue using their existing history contract;
generic RPC proxy access stays closed.

## Cleanup semantics

Planning returns compact message IDs, content hashes and technical-part counts;
it never downloads transcripts. The confirmation reports eligible
tools/reasoning and explicitly reports skipped content. Execution sends at most
16 candidates per RPC. Each message independently uses the synchronous
write transaction, fresh DB challenge, durable native claim/ownership checks,
content revision comparison and atomic receipt. Part indexes are computed from
the authorized stored content inside that transaction.

Text and message/session metadata remain intact. A changed message is refused
rather than silently expanding what the user confirmed. Pre-compaction messages
are included; active/incomplete content is skipped. Whole-session cleanup commits
per message: a later conflict leaves earlier successful messages pruned.
Progress and cancellation are displayed above the transcript. Cancellation stops
future batches; an already dispatched batch may commit. Ambiguous acknowledgments
invalidate the active window; identical retries use the same durable receipts.
The ordinary custom pruning events coalesce native-window refreshes in other
clients. Cleanup never creates or resumes generation.

## Validation

SQLite/plugin and route regressions cover pagination beyond 200 messages, project/
directory/legacy identity isolation, cursor binding, scan horizon, unsupported
payload reporting, active claims, rollback and batch receipt validation. UI store
tests cover compact planning, changed-content refusal, cancellation and late pages.
The Chromium fixture exercises the real search window with HTTP responses and
asserts that searches/counts and selected previews never page the transcript.

`scripts/test-session-history-native.mjs` runs only inside the isolated pruning
fixture: 241 imported synthetic messages, counts, search, cleanup and exact batch
replays against a real daemon; a second session verifies all 242 text-only
workspace matches and ranked search with three diverse hits and exact two-session
provenance. Pure ranking tests cover Unicode terms, frequency weights, phrase
bonuses, diversity, dates and cap formatting. Synthetic SQLite/filesystem tests cover
physical clone/worktree ownership, unknown identities and adversarial large-row
first-yield responsiveness, tool-heavy rarity ranking, exact control/Unicode
escape decoding and IDF isolation from unknown projections. The native fixture also checks dotted-capital-I and
mixed-accent/Kelvin/long-s scalar matching, plus large-row bypass reporting.
Synthetic SQLite tests cover scope,
prefilter supersets and selectivity, multiline rarity ranking, bounded materialization, cancellation, yielding and time/candidate
caps; registration tests exercise the tool, RPC, storage challenge and caller fences.
The parent fixture also checks active-generation refusal and
pre-compaction discovery. Never point it at a user's DB or shared daemon; report
native Windows, browser rendering and other platforms as separate validation claims.

`node scripts/benchmark-session-history.mjs [baseline-ref]` compares local scan
cost (synthetic in-memory database, excluding broker/RPC) with a Git revision,
HEAD by default.

## Agent conventions

- Ranked search belongs in `history-ranked-store.ts`, with pure ranking in `history-ranking.ts`; share scope SQL, readable extraction, text projection and message bounds through `history-content.ts`. Compute masks only from decoded shared readable sources; unknown projections stay outside IDF and behind known candidates. Preserve the literal `history` RPC contract. Keep Unicode/control-escape selectivity, dotted-I self-matches, tool-heavy rarity/unknown ordering, large-projection responsiveness/reporting, partial results at the judge deadline and verified-match provenance tests whenever ranking changes. `history-ranked-ownership.ts` owns request-local physical ownership and the uncached publication fence; bind both root and common-directory device/inode identities. The shared filesystem reader stays inside the packable plugin and is imported by workspace discovery; keep depth limits explicit at plugin calls. Never add Git process spawns to ranked ownership, caller scope selectors, caller-supplied regular-expression execution, transcript indexes or generic RPC routes. Tool registration and disposal follow the pruning bundle's backend presence.
- Full-history search/counts use the bundled pruning plugin's bounded queries, outside the transcript store. Current-session results and the global timeline navigate through bounded anchor windows; other-session previews fetch one native message only. Search/results/progress styles live in `styles/components/history-search.css`. Workspace results group by session with its title and current worktree badge via `components/history-search-results.tsx`; unloaded labels and "Open in session" live in `stores/history-search-sessions.ts` (bounded display reads, targeted hydration, transcript anchor). Never show raw native IDs in results.
